/**
 * Database schema (Drizzle ORM, PostgreSQL).
 *
 * Rules baked in here:
 * - Every company-owned row carries `company_id`. Services always filter by it.
 * - Personal todos are tasks with visibility = 'private'; only `owner_user_id` may see them.
 * - People ↔ companies has NO salary columns. Salaries live in `salaries`, readable only
 *   through the salary service for users listed in `salary_viewers` (see access.ts).
 * - People are never hard-deleted ("mark as left"), so later tables (e.g.
 *   `org_posts.manager_person_id`) can safely reference `people.id`.
 *
 * This file is imported by app code, CLI scripts and tests, so it must stay free of
 * runtime side effects (no `server-only`, no connections).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { AwaitingComment, ChecklistItem, ItemStates } from "../../lib/routines";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const userRoleEnum = pgEnum("user_role", ["founder", "staff"]);
/** Which dashboard template a company page uses (0027; was an enum operating/service/holding). */
export const COMPANY_KINDS = ["it_services", "factory", "brand_sales", "sales_partners", "courier", "generic"] as const;
export type CompanyKind = (typeof COMPANY_KINDS)[number];
export const companyStatusEnum = pgEnum("company_status", ["active", "planned"]);
export const projectStatusEnum = pgEnum("project_status", [
  "planned",
  "active",
  "on_hold",
  "done",
  "cancelled",
]);
export const taskVisibilityEnum = pgEnum("task_visibility", ["private", "shared"]);
export const taskStatusEnum = pgEnum("task_status", [
  "todo",
  "in_progress",
  "waiting",
  "done",
  "cancelled",
]);
export const taskPriorityEnum = pgEnum("task_priority", ["urgent", "high", "normal", "low"]);
export const taskEventKindEnum = pgEnum("task_event_kind", [
  "created",
  "updated",
  "status_changed",
  "deadline_changed",
  "assignee_changed",
  "deleted",
  /** A person answered through the Telegram bot (Принято, Нужна помощь, a reply, a deadline request). 0028. */
  "staff_reply",
]);
export const employmentTypeEnum = pgEnum("employment_type", ["staff", "contractor", "part_time"]);
export const salaryPayTypeEnum = pgEnum("salary_pay_type", ["monthly", "piecework", "hourly"]);
export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending",
  "sent",
  "failed",
  "cancelled",
  "parked",
  /** Claimed by a dispatcher run (see claimed_at); not visible to other runs. */
  "sending",
  /** Telegram is configured but the founder has not linked a chat: held, sent once linked. */
  "not_linked",
]);

// ---------------------------------------------------------------------------
// Users & sessions (local auth mode)
// ---------------------------------------------------------------------------
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  shortName: text("short_name").notNull(),
  /** bcrypt hash. Null when the user signs in through an external provider (Supabase). */
  passwordHash: text("password_hash"),
  role: userRoleEnum("role").notNull().default("founder"),
  /** Supabase auth.users id, filled when AUTH_MODE=supabase is introduced. */
  externalAuthId: text("external_auth_id").unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * Failed sign-in attempts for the login rate limit (src/server/auth/login-limiter.ts).
 * Stored in the database so the limit holds across serverless instances. Only SHA-256
 * hashes of the normalized email and the client IP are kept; rows expire after a day.
 */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    emailHash: text("email_hash").notNull(),
    ipHash: text("ip_hash").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("login_attempts_email_idx").on(t.emailHash, t.createdAt),
    index("login_attempts_ip_idx").on(t.ipHash, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------
export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  legalName: text("legal_name"),
  kind: text("kind").$type<CompanyKind>().notNull().default("generic"),
  status: companyStatusEnum("status").notNull().default("active"),
  description: text("description"),
  /** Hex color used for the company dot/tag in the UI. */
  color: text("color").notNull().default("#1E6B49"),
  sort: integer("sort").notNull().default(100),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Sub-units of a company tracked separately (e.g. Alura Style factories ХБК and Ош Район). */
export const companyUnits = pgTable(
  "company_units",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("unit"),
    sort: integer("sort").notNull().default(100),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("company_units_company_slug_uq").on(t.companyId, t.slug)],
);

// ---------------------------------------------------------------------------
// People (shared across companies)
// ---------------------------------------------------------------------------
export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: text("full_name").notNull(),
    /** How the team calls them ("Эльмурат", "Edil"). */
    shortName: text("short_name"),
    phone: text("phone"),
    telegramHandle: text("telegram_handle"),
    email: text("email"),
    notes: text("notes"),
    /** Set when this person is also an app user (e.g. a founder). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * Set when the person left the group entirely ("mark as left"). Rows are never deleted,
     * so history (tasks, salaries, a future org chart) keeps pointing at them.
     */
    leftAt: timestamp("left_at", { withTimezone: true }),
    /**
     * Staff on Telegram (0028): the bot may message this person only when they linked a chat
     * themselves (/start CODE) AND a founder switched this on. Off by default.
     */
    botEnabled: boolean("bot_enabled").notNull().default(false),
    /** When "bot may message" was last switched on (new-task messages only for tasks assigned after it). */
    botEnabledAt: timestamp("bot_enabled_at", { withTimezone: true }),
    /** No bot messages until this instant (founder's "pause until"). */
    botPausedUntil: timestamp("bot_paused_until", { withTimezone: true }),
    /** Language of bot messages to this person. Only "ru" today. */
    lang: text("lang").notNull().default("ru"),
    /** Per-person overrides of the staff chase defaults (see src/lib/staff-schemas.ts). Null = defaults. */
    staffChase: jsonb("staff_chase").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("people_full_name_idx").on(t.fullName), check("people_lang_ck", sql`${t.lang} in ('ru')`)],
);

/**
 * Person ↔ company link with role/title, optional unit (e.g. Alura Style ХБК) and
 * employment type. One person can have links to several companies (the accountant).
 * Deliberately NO salary columns (see `salaries`).
 */
export const personCompanies = pgTable(
  "person_companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id").references(() => companyUnits.id, { onDelete: "set null" }),
    role: text("role").notNull(),
    title: text("title"),
    employmentType: employmentTypeEnum("employment_type").notNull().default("staff"),
    /** False once the person stopped working for this company (ended_on keeps the date). */
    isActive: boolean("is_active").notNull().default(true),
    /**
     * True when this link was ended by "mark as left" (not by hand). Undoing "left" brings
     * back exactly these links; any manual edit of the link clears it.
     */
    endedByLeave: boolean("ended_by_leave").notNull().default(false),
    startedOn: date("started_on", { mode: "string" }),
    endedOn: date("ended_on", { mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("person_companies_uq").on(t.personId, t.companyId, t.role),
    index("person_companies_company_idx").on(t.companyId),
  ],
);

// ---------------------------------------------------------------------------
// Salaries (RESTRICTED). Only users in salary_viewers may read or write these, and only
// through src/server/services/salaries.ts. Every change is written to salary_access_log.
// ---------------------------------------------------------------------------

/**
 * Salary history per person-company link. A change is a NEW row; the current salary is
 * the latest `effective_from` on or before today (ties: the newest row).
 */
export const salaries = pgTable(
  "salaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    personCompanyId: uuid("person_company_id")
      .notNull()
      .references(() => personCompanies.id, { onDelete: "restrict" }),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("KGS"),
    payType: salaryPayTypeEnum("pay_type").notNull().default("monthly"),
    effectiveFrom: date("effective_from", { mode: "string" }).notNull(),
    note: text("note"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    /** Insert order: tie-breaker when two rows share link, effective_from and created_at. */
    seq: bigint("seq", { mode: "number" }).generatedByDefaultAsIdentity(),
  },
  (t) => [
    index("salaries_link_idx").on(t.personCompanyId, t.effectiveFrom),
    check("salaries_amount_nonneg", sql`${t.amount} >= 0`),
    check("salaries_currency_code", sql`${t.currency} ~ '^[A-Z]{3}$'`),
  ],
);

/** Users allowed to see and edit salaries. Default: both founders (seeded; 0016 adds Talant). */
export const salaryViewers = pgTable("salary_viewers", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

/**
 * Audit log for salaries: who viewed (one row per page/API view, not per row) or changed
 * which person's salary, and who granted/revoked salary access. Append-only.
 */
export const salaryAccessLog = pgTable(
  "salary_access_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** "view" | "change" | "import" | "grant_viewer" | "revoke_viewer" */
    action: text("action").notNull(),
    /** Where it happened, e.g. "people_list", "company:alura-style", "person", "api". */
    scope: text("scope").notNull(),
    personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
    personCompanyId: uuid("person_company_id").references(() => personCompanies.id, { onDelete: "set null" }),
    targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "set null" }),
    details: jsonb("details"),
    createdAt: createdAt(),
  },
  (t) => [index("salary_access_log_created_idx").on(t.createdAt)],
);

// ---------------------------------------------------------------------------
// Projects & tasks
// ---------------------------------------------------------------------------
export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    description: text("description"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    status: projectStatusEnum("status").notNull().default("active"),
    startDate: date("start_date", { mode: "string" }),
    dueDate: date("due_date", { mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_company_idx").on(t.companyId)],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    title: text("title").notNull(),
    notes: text("notes"),
    /** Optional for personal todos; required for shared tasks (enforced in the service layer). */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    /** The creator. For private tasks, the only user who may see the task. */
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    visibility: taskVisibilityEnum("visibility").notNull().default("shared"),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    assigneePersonId: uuid("assignee_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    /**
     * Optional department of the company's org chart (C3b). Must belong to the task's company
     * (enforced in the service layer). Departments are archived, never deleted.
     */
    orgDepartmentId: uuid("org_department_id").references((): AnyPgColumn => orgDepartments.id, { onDelete: "set null" }),
    status: taskStatusEnum("status").notNull().default("todo"),
    priority: taskPriorityEnum("priority").notNull().default("normal"),
    /** Calendar date in APP_TIMEZONE (Asia/Bishkek). */
    dueDate: date("due_date", { mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** Per-task overrides of the staff chase (0028; see src/lib/staff-schemas.ts). Null = the person's settings. */
    staffChase: jsonb("staff_chase").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_company_idx").on(t.companyId),
    index("tasks_project_idx").on(t.projectId),
    index("tasks_owner_idx").on(t.ownerUserId),
    index("tasks_assignee_user_idx").on(t.assigneeUserId),
    index("tasks_due_idx").on(t.dueDate),
    index("tasks_org_department_idx").on(t.orgDepartmentId),
    check(
      "tasks_single_assignee",
      sql`${t.assigneeUserId} is null or ${t.assigneePersonId} is null`,
    ),
  ],
);

/** Audit trail for tasks. Deadline changes are always recorded here. */
export const taskEvents = pgTable(
  "task_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null after the task was deleted (the "deleted" event keeps a snapshot). */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "set null" }),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Set when a person (staff, through the Telegram bot) made the change (0028). */
    actorPersonId: uuid("actor_person_id").references(() => people.id, { onDelete: "set null" }),
    /**
     * Copy of the task's visibility/owner, so the audit log follows the same rule as the
     * task (see visibleEventsWhere in access.ts). Kept in sync while the task exists and
     * frozen as a snapshot after it is deleted.
     */
    visibility: taskVisibilityEnum("visibility").notNull().default("private"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    kind: taskEventKindEnum("kind").notNull(),
    field: text("field"),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    createdAt: createdAt(),
  },
  (t) => [index("task_events_task_idx").on(t.taskId)],
);

// ---------------------------------------------------------------------------
// Notifications (outbox, preferences, Telegram links). See src/server/notifications/.
// Only founders (users) ever receive notifications. People records never do.
// ---------------------------------------------------------------------------
export const notificationPriorityEnum = pgEnum("notification_priority", ["low", "normal", "high", "urgent"]);

export const notificationsOutbox = pgTable(
  "notifications_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The founder this is for, or null for a person (staff) item. Exactly one of user_id / person_id (0028). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** The person (staff on Telegram) this is for (0028). */
    personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),
    /** Channel actually used ("telegram", "dev", later "push"). "auto" until dispatched. */
    channel: text("channel").notNull().default("auto"),
    /** e.g. "morning_summary", "evening_check", "task_due_today", "overdue_chase", "task_reminder". */
    kind: text("kind").notNull(),
    /** Kind-specific references (task id, summary line). The message itself is built at send time. */
    payload: jsonb("payload").notNull().default({}),
    /** Task this item is about (if any). Deleting the task removes its reminders. */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    priority: notificationPriorityEnum("priority").notNull().default("normal"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull().defaultNow(),
    /** After this instant the item is stale and gets cancelled instead of sent. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    status: outboxStatusEnum("status").notNull().default("pending"),
    /** Prevents queueing the same reminder twice for the same user. */
    dedupeKey: text("dedupe_key"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Wall-clock time a dispatcher run claimed this item (status "sending"). */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Retry backoff: not retried before this instant. */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /** Set when the daily budget was full and the item was parked for the next summary. */
    parkedAt: timestamp("parked_at", { withTimezone: true }),
    /** The summary item that later included this parked item. */
    bundledIntoId: uuid("bundled_into_id"),
    providerMessageId: text("provider_message_id"),
    /** Channel-neutral message as rendered at send time (shown in the dev inbox). */
    message: jsonb("message"),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_outbox_due_idx").on(t.status, t.scheduledFor),
    index("notifications_outbox_user_idx").on(t.userId, t.createdAt),
    index("notifications_outbox_person_idx").on(t.personId, t.createdAt),
    uniqueIndex("notifications_outbox_user_dedupe_uq").on(t.userId, t.dedupeKey),
    /** Dedupe for founders and persons alike (0028). */
    uniqueIndex("notifications_outbox_recipient_dedupe_uq").on(sql`coalesce(${t.userId}, ${t.personId})`, t.dedupeKey),
    check("notifications_outbox_one_recipient", sql`(${t.userId} is null) <> (${t.personId} is null)`),
  ],
);

/** Per-founder notification settings. Times are "HH:MM" in APP_TIMEZONE. */
export const notificationPreferences = pgTable("notification_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  morningSummaryTime: text("morning_summary_time").notNull().default("08:30"),
  eveningCheckEnabled: boolean("evening_check_enabled").notNull().default(true),
  eveningCheckTime: text("evening_check_time").notNull().default("19:00"),
  quietStart: text("quiet_start").notNull().default("21:00"),
  quietEnd: text("quiet_end").notNull().default("08:00"),
  /** Max pushes per day besides the morning summary and evening check. */
  maxOtherPerDay: integer("max_other_per_day").notNull().default(3),
  /** Let priority "urgent" items through during quiet hours. */
  urgentAtNight: boolean("urgent_at_night").notNull().default(false),
  /**
   * How overdue tasks are chased on chase days: "separate" (one push per task), "grouped"
   * (one 10:00 push listing them all — the default, chosen by the founders; 0016) or
   * "summary_only" (no chase pushes; the morning summary lists them).
   */
  overdueChaseStyle: text("overdue_chase_style").notNull().default("grouped"),
  updatedAt: updatedAt(),
}, (t) => [
  check("notification_preferences_morning_hm", sql`${t.morningSummaryTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check("notification_preferences_evening_hm", sql`${t.eveningCheckTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check("notification_preferences_quiet_start_hm", sql`${t.quietStart} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check("notification_preferences_quiet_end_hm", sql`${t.quietEnd} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check("notification_preferences_max_other_range", sql`${t.maxOtherPerDay} between 0 and 10`),
  check(
    "notification_preferences_chase_style",
    sql`${t.overdueChaseStyle} in ('separate', 'grouped', 'summary_only')`,
  ),
]);

/**
 * A linked Telegram private chat: a founder's (user_id) or a person's (person_id, 0028).
 * One per user, one per person, one recipient per chat.
 */
export const telegramLinks = pgTable(
  "telegram_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull().unique(),
    telegramUserId: text("telegram_user_id").notNull(),
    username: text("username"),
    firstName: text("first_name"),
    /** A person sent /stop: the bot sends them nothing until they link again. */
    stoppedAt: timestamp("stopped_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("telegram_links_person_uq").on(t.personId),
    check("telegram_links_one_owner", sql`(${t.userId} is null) <> (${t.personId} is null)`),
  ],
);

/** One-time codes for `/start CODE`. Only a SHA-256 hash is stored. */
export const telegramLinkCodes = pgTable(
  "telegram_link_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** A founder's own code, or null for a person's invite code (0028). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** "Invite to Telegram": the person this code links (0028). */
    personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),
    /** The founder who made a person's invite. */
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    codeHash: text("code_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("telegram_link_codes_user_idx").on(t.userId),
    index("telegram_link_codes_person_idx").on(t.personId),
    check("telegram_link_codes_one_owner", sql`(${t.userId} is null) <> (${t.personId} is null)`),
  ],
);

/**
 * Server-side tokens behind Telegram inline buttons. The callback data carries only a
 * random token; the user, task and action live here (hash of the token is the key).
 */
export const notificationActionTokens = pgTable(
  "notification_action_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    /** The founder the button belongs to, or null for a person's button (0028). */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** The person (staff) the button belongs to (0028). */
    personId: uuid("person_id").references(() => people.id, { onDelete: "cascade" }),
    /** The task a task button acts on (null for a holding button). */
    taskId: uuid("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    /** The holding ask item an "I asked Elmurat" button acts on (null for a task button). */
    holdingAskId: uuid("holding_ask_id").references((): AnyPgColumn => holdingAskItems.id, { onDelete: "cascade" }),
    /** A founder's Approve / Decline on a person's deadline request (0028). */
    deadlineRequestId: uuid("deadline_request_id").references((): AnyPgColumn => taskDeadlineRequests.id, { onDelete: "cascade" }),
    /** A routine run a "✓ item" / "Готово" button ticks (0029); the item key is in payload. */
    routineRunId: uuid("routine_run_id").references((): AnyPgColumn => routineRuns.id, { onDelete: "cascade" }),
    /** "done" | "snooze_1d" | "move_1d" | "move_3d" | "holding_asked" | staff actions (see types.ts) */
    action: text("action").notNull(),
    /** Small server-side data for the action (e.g. the text a "К какой задаче?" button attaches). */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    outboxId: uuid("outbox_id").references(() => notificationsOutbox.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("notification_action_tokens_user_idx").on(t.userId),
    index("notification_action_tokens_person_idx").on(t.personId),
    check(
      "notification_action_tokens_subject",
      sql`${t.taskId} is not null or ${t.holdingAskId} is not null or ${t.deadlineRequestId} is not null or ${t.routineRunId} is not null`,
    ),
    check("notification_action_tokens_one_owner", sql`(${t.userId} is null) <> (${t.personId} is null)`),
  ],
);

/**
 * Comments on a task (0028): from a founder in the app or from the assigned person through the
 * Telegram bot ("Нужна помощь", a free-text reply). Exactly one author.
 */
export const taskComments = pgTable(
  "task_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "cascade" }),
    authorPersonId: uuid("author_person_id").references(() => people.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    /** "app" | "telegram" */
    source: text("source").notNull().default("app"),
    /** "comment" | "help" (the person pressed Нужна помощь). */
    kind: text("kind").notNull().default("comment"),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("task_comments_task_idx").on(t.taskId, t.createdAt),
    check("task_comments_one_author", sql`(${t.authorUserId} is null) <> (${t.authorPersonId} is null)`),
    check("task_comments_source_ck", sql`${t.source} in ('app', 'telegram')`),
    check("task_comments_kind_ck", sql`${t.kind} in ('comment', 'help')`),
    check("task_comments_text_ck", sql`length(${t.text}) between 1 and 4000`),
  ],
);

/**
 * "Перенести срок": a person asks for a new deadline; a founder approves (the deadline moves,
 * logged in task_events) or declines. A person can never change a deadline themselves.
 */
export const taskDeadlineRequests = pgTable(
  "task_deadline_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    currentDueDate: date("current_due_date", { mode: "string" }),
    proposedDueDate: date("proposed_due_date", { mode: "string" }).notNull(),
    /** "pending" | "approved" | "declined" | "cancelled" */
    status: text("status").notNull().default("pending"),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("task_deadline_requests_task_idx").on(t.taskId),
    uniqueIndex("task_deadline_requests_one_pending_uq").on(t.taskId).where(sql`${t.status} = 'pending'`),
    check("task_deadline_requests_status_ck", sql`${t.status} in ('pending', 'approved', 'declined', 'cancelled')`),
  ],
);

/**
 * App-wide settings, one JSON value per key (0028). `staff_notification_defaults`: the global
 * staff chase defaults edited in Settings → Team on Telegram (shape in src/lib/staff-schemas.ts).
 */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull(),
  updatedByUserId: uuid("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Routines (0029): recurring jobs assigned to a person (staff, on Telegram) or a founder.
// Read and written only through services/routines.ts (founders only); the bot acts for a person
// only on runs of routines assigned to them.
// ---------------------------------------------------------------------------
export const routines = pgTable(
  "routines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The company it is for, or null for group-wide work (e.g. 1C entries for all companies). */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** Exactly one assignee: a person (staff, via Telegram) or a founder (users). */
    assigneePersonId: uuid("assignee_person_id").references(() => people.id, { onDelete: "cascade" }),
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, { onDelete: "cascade" }),
    /** "weekly" (days of week 1 = Mon … 7 = Sun) | "monthly" (month_day; 31 = the last day of shorter months). */
    scheduleKind: text("schedule_kind").notNull().default("weekly"),
    days: integer("days").array(),
    monthDay: integer("month_day"),
    /** Local time of the (first) ask, "HH:MM". */
    time: text("time").notNull(),
    /** Every ask time of the day, sorted ("10:00", "16:00"); null on older rows = just `time` (0031). */
    times: text("times").array(),
    /** Optional first / last day (inclusive, local); after `endsOn` the planner marks it "ended" (0031). */
    startsOn: date("starts_on", { mode: "string" }),
    endsOn: date("ends_on", { mode: "string" }),
    timezone: text("timezone").notNull().default("Asia/Bishkek"),
    /** "button" | "checklist" | "number" (later). */
    confirmation: text("confirmation").notNull().default("button"),
    /** Checklist items [{ key, label, details?, needsComment? }] (keys stay stable when labels are edited). */
    items: jsonb("items").$type<ChecklistItem[]>().notNull().default([]),
    /** Chase override (src/lib/routines.ts RoutineChaseOverride); null = the person's / global defaults. */
    chase: jsonb("chase").$type<Record<string, unknown>>(),
    /** "active" | "paused" | "ended" (past ends_on) | "archived" */
    status: text("status").notNull().default("active"),
    /** Seeded examples ("elmurat-1c"): created once, only if absent. */
    seedKey: text("seed_key").unique(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("routines_company_idx").on(t.companyId),
    index("routines_person_idx").on(t.assigneePersonId),
    check("routines_one_assignee", sql`(${t.assigneePersonId} is null) <> (${t.assigneeUserId} is null)`),
    check("routines_schedule_kind_ck", sql`${t.scheduleKind} in ('weekly', 'monthly')`),
    check("routines_confirmation_ck", sql`${t.confirmation} in ('button', 'checklist', 'number')`),
    check("routines_status_ck", sql`${t.status} in ('active', 'paused', 'ended', 'archived')`),
    check("routines_month_day_ck", sql`${t.monthDay} is null or ${t.monthDay} between 1 and 31`),
  ],
);

/** One day of a routine: opened at the ask time, ticked by the assignee, closed at the day's end. */
export const routineRuns = pgTable(
  "routine_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    runDate: date("run_date", { mode: "string" }).notNull(),
    /** "open" | "escalated" | "done" | "partly" | "missed" */
    status: text("status").notNull().default("open"),
    /** The checklist of this run (as it opened; edits of the routine while it is open update it). */
    items: jsonb("items").$type<ChecklistItem[]>().notNull().default([]),
    /** Keys of the items ticked done (kept in sync with item_states). */
    itemsDone: jsonb("items_done").$type<string[]>().notNull().default([]),
    /** Per item key (or "_run"): done / partly / can't, when, by whom, comment (0031). */
    itemStates: jsonb("item_states").$type<ItemStates>().notNull().default({}),
    /** The assignee pressed «Комментарий» / «Частично» / «Не могу»: their next text is the comment (0031). */
    awaitingComment: jsonb("awaiting_comment").$type<AwaitingComment | null>(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    doneAt: timestamp("done_at", { withTimezone: true }),
    lastChasedAt: timestamp("last_chased_at", { withTimezone: true }),
    chaseCount: integer("chase_count").notNull().default(0),
    escalatedAt: timestamp("escalated_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("routine_runs_routine_day_uq").on(t.routineId, t.runDate),
    index("routine_runs_status_idx").on(t.status, t.runDate),
    check("routine_runs_status_ck", sql`${t.status} in ('open', 'escalated', 'done', 'partly', 'missed')`),
  ],
);

/**
 * Comments on routine runs (0031): from the assignee in the bot («💬 Комментарий», and the
 * comment «Частично» / «Не могу» require), or a note when an item flagged "needs a comment" was
 * ticked. Founders read them on the routine page.
 */
export const routineComments = pgTable(
  "routine_comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    routineId: uuid("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => routineRuns.id, { onDelete: "cascade" }),
    /** The checklist item key, or null for the whole run. */
    itemKey: text("item_key"),
    /** "comment" | "done" | "partly" | "cant" (what the comment came with). */
    kind: text("kind").notNull().default("comment"),
    authorPersonId: uuid("author_person_id").references(() => people.id, { onDelete: "set null" }),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    text: text("text").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("routine_comments_run_idx").on(t.runId),
    index("routine_comments_routine_idx").on(t.routineId, t.createdAt),
    check("routine_comments_kind_ck", sql`${t.kind} in ('comment', 'done', 'partly', 'cant')`),
  ],
);

export type Routine = typeof routines.$inferSelect;
export type RoutineRun = typeof routineRuns.$inferSelect;
export type RoutineComment = typeof routineComments.$inferSelect;

/** "Snooze 1 day": no reminders/chases for this task to this user until `snoozedUntil`. */
export const reminderSnoozes = pgTable(
  "reminder_snoozes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("reminder_snoozes_user_task_uq").on(t.userId, t.taskId)],
);

// ---------------------------------------------------------------------------
// Numbers layer: metric definitions, values (with history) and connector runs.
// Company-owned (company_id); read and written only through services/metrics.ts and
// server/connectors/, which compose the access rules in access.ts.
// ---------------------------------------------------------------------------
export const metricGranularityEnum = pgEnum("metric_granularity", ["day", "week", "month"]);
export const metricDirectionEnum = pgEnum("metric_direction", ["higher_is_better", "lower_is_better", "neutral"]);
/** derived = computed by the app from other data (e.g. the intercompany debt from the Holding ledger). */
/** extension = sent by the founders' Chrome extension through POST /api/v1/ingest (0022). */
export const metricSourceEnum = pgEnum("metric_source", ["manual", "upload", "connector", "derived", "extension"]);
export const connectorRunStatusEnum = pgEnum("connector_run_status", ["ok", "not_configured", "error", "running"]);
/**
 * How finer-grained connector points (e.g. days) become one value of a coarser metric
 * (e.g. a week): sum (orders, money), avg (percentages), last (headcount, balances).
 */
export const metricAggregationEnum = pgEnum("metric_aggregation", ["sum", "avg", "last"]);

/**
 * What a company tracks (seeded from src/lib/kpis.ts, editable later). One row per
 * company + optional unit (e.g. Alura Style ХБК vs Ош Район) + key.
 */
export const metricDefinitions = pgTable(
  "metric_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    /** Company unit (factory) this metric is tracked for; null = whole company. */
    companyUnitId: uuid("company_unit_id").references(() => companyUnits.id, { onDelete: "restrict" }),
    key: text("key").notNull(),
    /** English UI name. */
    name: text("name").notNull(),
    /** Other header names accepted by the upload (Russian, short forms). */
    aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
    /** Measurement unit: KGS, pcs, orders, %, people, count. */
    unit: text("unit").notNull(),
    granularity: metricGranularityEnum("granularity").notNull(),
    /** How a connector's daily points are combined into one week/month value. */
    aggregation: metricAggregationEnum("aggregation").notNull().default("sum"),
    direction: metricDirectionEnum("direction").notNull().default("higher_is_better"),
    /**
     * Data for a period is due this many days after the period ends (null = default per
     * granularity: day 1, week 3, month 10). After that the card turns "stale".
     */
    dueDays: integer("due_days"),
    target: numeric("target", { precision: 18, scale: 4 }),
    /** Where values are expected to come from. */
    sourceKind: metricSourceEnum("source_kind").notNull().default("manual"),
    /** Connector id (src/server/connectors) when sourceKind = connector. */
    connectorId: text("connector_id"),
    sort: integer("sort").notNull().default(100),
    /**
     * Pay data (salaries, payroll, bonuses, ФОТ…): never sent to an AI provider and never
     * watched by a custom AI role, whatever its name says (0024). Checked IN ADDITION to the
     * name / key word list. The piecework pay total (a factory total) stays allowed.
     */
    isPayData: boolean("is_pay_data").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("metric_definitions_company_unit_key_uq").on(t.companyId, t.companyUnitId, t.key).nullsNotDistinct(),
    check("metric_definitions_due_days_range", sql`${t.dueDays} is null or ${t.dueDays} between 0 and 60`),
  ],
);

/**
 * Metric values. Append-only history: a correction inserts a new row and clears
 * `is_current` on the old one, so exactly one current value per metric + period
 * (partial unique index) and every earlier value is kept.
 */
export const metricValues = pgTable(
  "metric_values",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    metricId: uuid("metric_id")
      .notNull()
      .references(() => metricDefinitions.id, { onDelete: "restrict" }),
    /** First day of the period (day itself, Monday of the week, 1st of the month). */
    periodStart: date("period_start", { mode: "string" }).notNull(),
    value: numeric("value", { precision: 18, scale: 4 }).notNull(),
    source: metricSourceEnum("source").notNull(),
    isCurrent: boolean("is_current").notNull().default(true),
    enteredBy: uuid("entered_by").references(() => users.id, { onDelete: "set null" }),
    connectorRunId: uuid("connector_run_id").references(() => connectorRuns.id, { onDelete: "set null" }),
    note: text("note"),
    /**
     * "period": the value of the metric's own period (a day, a week, a month) — every row
     * before 0015. "month_total": a whole-month value entered for a DAILY metric (period_start
     * = the 1st), used by AI roles that accept monthly totals when the days are incomplete
     * (a total for sum metrics, an average for avg, the end-of-month value for last). Never
     * part of the daily series, freshness, cards or the grid's day rows.
     */
    periodKind: text("period_kind").$type<MetricPeriodKind>().notNull().default("period"),
    createdAt: createdAt(),
  },
  (t) => [
    // One current value per metric + period + kind (latest wins within each kind).
    uniqueIndex("metric_values_current_uq").on(t.metricId, t.periodStart, t.periodKind).where(sql`${t.isCurrent}`),
    index("metric_values_metric_period_idx").on(t.metricId, t.periodStart),
    check("metric_values_period_kind", sql`${t.periodKind} in ('period', 'month_total')`),
    check("metric_values_month_total_first_day", sql`${t.periodKind} <> 'month_total' or extract(day from ${t.periodStart}) = 1`),
  ],
);

export type MetricPeriodKind = "period" | "month_total";

/** Every connector attempt (also "not configured"), for the data sources status. */
export const connectorRuns = pgTable(
  "connector_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    connectorId: text("connector_id").notNull(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    status: connectorRunStatusEnum("status").notNull(),
    rangeFrom: date("range_from", { mode: "string" }).notNull(),
    rangeTo: date("range_to", { mode: "string" }).notNull(),
    pointsReceived: integer("points_received").notNull().default(0),
    valuesWritten: integer("values_written").notNull().default(0),
    message: text("message"),
    /**
     * Extra facts about the run, e.g. `conflicts`: values the source reported that differ
     * from a value a founder entered or uploaded (the founder's value is kept).
     */
    details: jsonb("details").$type<ConnectorRunDetails>(),
    triggeredBy: uuid("triggered_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("connector_runs_connector_idx").on(t.connectorId, t.startedAt)],
);

export interface ConnectorRunConflict {
  metricId: string;
  period: string;
  /** The current (manual / upload) value that was kept. */
  kept: number;
  keptSource: "manual" | "upload";
  /** What the source reported. */
  reported: number;
}

export interface ConnectorRunDetails {
  conflicts?: ConnectorRunConflict[];
  /**
   * Browser extension calls: points that matched a founder's number (nothing written) — they
   * clear an older "source disagrees" of the same number and period.
   */
  agreed?: { metricId: string; period: string }[];
  /** Points not written, with the reason (capped). */
  skippedReasons?: string[];
}

// ---------------------------------------------------------------------------
// Browser extension (0022): personal API keys of the founders and a log of every ingest call.
// Only the key's SHA-256 is stored (the key itself is shown once). Founders only.
// ---------------------------------------------------------------------------
export const extensionKeys = pgTable(
  "extension_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** sha256 (hex) of the whole key. */
    keyHash: text("key_hash").notNull(),
    /** The first characters of the key, to recognise it ("fcx_Ab3d…"). */
    keyPrefix: text("key_prefix").notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("extension_keys_hash_uq").on(t.keyHash)],
);

/** Every authenticated ingest call (key, adapter, counts). The rate limit has its own counters (ingest_rate_counters). */
export const extensionIngestLog = pgTable(
  "extension_ingest_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null once the key is deleted (keys go with their user; the log stays, 0026). */
    keyId: uuid("key_id").references(() => extensionKeys.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    adapterId: text("adapter_id"),
    /** ok | invalid (the request itself was refused: bad JSON, too many points, …) */
    status: text("status").notNull(),
    points: integer("points").notNull().default(0),
    accepted: integer("accepted").notNull().default(0),
    rejected: integer("rejected").notNull().default(0),
    conflicts: integer("conflicts").notNull().default(0),
    /** { message?, rejected: [{ index, reason }] (first 50) } */
    details: jsonb("details").$type<{ message?: string; rejected?: { index: number; reason: string }[] }>(),
    createdAt: createdAt(),
  },
  (t) => [index("extension_ingest_log_key_idx").on(t.keyId, t.createdAt), check("extension_ingest_log_status", sql`${t.status} in ('ok', 'invalid')`)],
);

/**
 * Fixed one-minute windows for the ingest route's limits (0023), counted atomically
 * (INSERT … ON CONFLICT DO UPDATE SET n = n + 1 RETURNING n) BEFORE a request is processed,
 * so parallel requests cannot all see "under the limit". Buckets: `key:<key id>` (every
 * authenticated call) and `authfail:<ip>` (failed authentication). Rows older than an hour are
 * deleted as new windows start.
 */
export const ingestRateCounters = pgTable(
  "ingest_rate_counters",
  {
    bucket: text("bucket").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    n: integer("n").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.bucket, t.windowStart] }), index("ingest_rate_counters_window_idx").on(t.windowStart)],
);

// ---------------------------------------------------------------------------
// Holding: intercompany flows, contracts, monthly акты, the debt ledger and the
// "ask Elmurat" items. Founders only (assertHoldingAccess in access.ts); read and written
// only through services/holding.ts. Nothing is hard-deleted: rows are archived.
// Elmurat (the accountant) is a people record and never receives anything from the app.
// ---------------------------------------------------------------------------
export const flowStatusEnum = pgEnum("intercompany_flow_status", ["active", "planned"]);
export const contractStatusEnum = pgEnum("intercompany_contract_status", ["draft", "signed", "expired", "terminated"]);
export const actStatusEnum = pgEnum("intercompany_act_status", ["missing", "requested", "received", "signed", "not_needed"]);
export const ledgerKindEnum = pgEnum("intercompany_ledger_kind", ["opening", "payment"]);
export const holdingAskKindEnum = pgEnum("holding_ask_kind", ["ask", "reminder"]);
export const holdingAskStatusEnum = pgEnum("holding_ask_status", ["pending", "shown", "done", "cancelled"]);

/** Uploaded documents (PDF/JPG/PNG, max 10 MB). The bytes live in the file storage (see server/storage). */
export const holdingFiles = pgTable("holding_files", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** "local" (.data/uploads) or "supabase" (later). */
  storage: text("storage").notNull(),
  storageKey: text("storage_key").notNull().unique(),
  originalName: text("original_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  sha256: text("sha256").notNull(),
  uploadedBy: uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  /**
   * First time the file was attached to an акт or a contract. Uploads never attached
   * within 24 h are removed by the tick (cleanupUnattachedFiles); a file once attached is
   * kept even if it is later replaced (documents are never deleted).
   */
  attachedAt: timestamp("attached_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index("holding_files_unattached_idx").on(t.createdAt).where(sql`${t.attachedAt} is null`),
  check("holding_files_type", sql`${t.contentType} in ('application/pdf', 'image/jpeg', 'image/png')`),
  check("holding_files_size", sql`${t.sizeBytes} between 1 and 10485760`),
]);

/** Who does what for whom: "Alura Style → Alura Brand · пошив". */
export const intercompanyFlows = pgTable(
  "intercompany_flows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The company that provides the service (issues the акт, is owed the money). */
    fromCompanyId: uuid("from_company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    /** The company that receives the service (signs the акт, owes the money). */
    toCompanyId: uuid("to_company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    /** Short service name, shown in the grid ("пошив", "ERP"). */
    service: text("service").notNull(),
    description: text("description"),
    /** First month акты are expected for. Null = start date not set yet (nothing expected). */
    since: date("since", { mode: "string" }),
    /** Last day of the flow (optional): months after it are not expected. */
    until: date("until", { mode: "string" }),
    status: flowStatusEnum("status").notNull().default("active"),
    /**
     * "Who to ask" for this flow's акты: a person who works for one of the two companies
     * (checked by the service). Null = nobody named: generic wording ("Ask the accountant…",
     * "Здравствуйте! …"). New flows default to the companies' accountant, if there is one.
     * The app never messages this person; it only names them in the founders' messages.
     */
    askPersonId: uuid("ask_person_id").references(() => people.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("intercompany_flows_two_companies", sql`${t.fromCompanyId} <> ${t.toCompanyId}`),
    check("intercompany_flows_dates", sql`${t.until} is null or ${t.since} is null or ${t.until} >= ${t.since}`),
    uniqueIndex("intercompany_flows_live_uq")
      .on(t.fromCompanyId, t.toCompanyId, sql`lower(${t.service})`)
      .where(sql`${t.archivedAt} is null`),
  ],
);

export const intercompanyContracts = pgTable(
  "intercompany_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowId: uuid("flow_id").notNull().references(() => intercompanyFlows.id, { onDelete: "restrict" }),
    number: text("number").notNull(),
    signedOn: date("signed_on", { mode: "string" }),
    validUntil: date("valid_until", { mode: "string" }),
    status: contractStatusEnum("status").notNull().default("draft"),
    /** Free text: "120 000 KGS per month", "per piece by price list". */
    amountTerms: text("amount_terms"),
    attachmentFileId: uuid("attachment_file_id").references(() => holdingFiles.id, { onDelete: "restrict" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("intercompany_contracts_flow_idx").on(t.flowId)],
);

/**
 * One акт приёма-передачи per flow per month. A month without a row is "missing" when it
 * is expected (see src/lib/holding.ts); a row is written the first time a founder changes it.
 */
export const intercompanyActs = pgTable(
  "intercompany_acts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    flowId: uuid("flow_id").notNull().references(() => intercompanyFlows.id, { onDelete: "restrict" }),
    /** First day of the month. */
    period: date("period", { mode: "string" }).notNull(),
    status: actStatusEnum("status").notNull().default("missing"),
    /** When a founder asked Elmurat (status requested; kept after received). */
    requestedOn: date("requested_on", { mode: "string" }),
    requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    /** Who was asked (the flow's / round's "who to ask" at that moment); null = nobody named. */
    requestedPersonId: uuid("requested_person_id").references(() => people.id, { onDelete: "set null" }),
    /** Amount of the акт in KGS (counts as invoiced once received or signed). */
    amount: numeric("amount", { precision: 14, scale: 2 }),
    actNumber: text("act_number"),
    actDate: date("act_date", { mode: "string" }),
    note: text("note"),
    attachmentFileId: uuid("attachment_file_id").references(() => holdingFiles.id, { onDelete: "restrict" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("intercompany_acts_flow_period_uq").on(t.flowId, t.period),
    check("intercompany_acts_period_first", sql`extract(day from ${t.period}) = 1`),
    check("intercompany_acts_amount_nonneg", sql`${t.amount} is null or ${t.amount} >= 0`),
  ],
);

/**
 * Debt ledger entries besides акты: an opening balance ("debtor owes creditor X as of
 * date") or a payment ("debtor paid creditor X"). Cancelled entries are archived.
 */
export const intercompanyLedgerEntries = pgTable(
  "intercompany_ledger_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: ledgerKindEnum("kind").notNull(),
    debtorCompanyId: uuid("debtor_company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    creditorCompanyId: uuid("creditor_company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    entryDate: date("entry_date", { mode: "string" }).notNull(),
    amount: numeric("amount", { precision: 14, scale: 2 }).notNull(),
    note: text("note"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archivedBy: uuid("archived_by").references(() => users.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    check("intercompany_ledger_two_companies", sql`${t.debtorCompanyId} <> ${t.creditorCompanyId}`),
    check("intercompany_ledger_amount_pos", sql`${t.amount} > 0`),
    index("intercompany_ledger_pair_idx").on(t.debtorCompanyId, t.creditorCompanyId),
  ],
);

/**
 * "Ask Elmurat" items: ONE grouped line per founder per month (kind ask, round = YYYY-MM)
 * or per week (kind reminder, round = that Monday), shown in that founder's next morning
 * summary with an "I asked Elmurat" button. The unique index makes planning idempotent.
 * When one founder marks the months as asked, the other's pending item is cancelled.
 */
export const holdingAskItems = pgTable(
  "holding_ask_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: holdingAskKindEnum("kind").notNull(),
    roundKey: text("round_key").notNull(),
    /** [{ flowId, period }] the item is about. */
    cells: jsonb("cells").$type<{ flowId: string; period: string }[]>().notNull(),
    status: holdingAskStatusEnum("status").notNull().default("pending"),
    /** The morning summary that showed it. */
    outboxId: uuid("outbox_id").references(() => notificationsOutbox.id, { onDelete: "set null" }),
    shownAt: timestamp("shown_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("holding_ask_items_round_uq").on(t.userId, t.kind, t.roundKey)],
);

/**
 * A founder's per-round override of a flow's "who to ask" (e.g. Elmurat is on holiday this
 * month: ask Aigul). Round = the month of the ask (YYYY-MM); it applies to that month's ask
 * lines, the in-app card and the copyable message. The person must work for one of the
 * flow's two companies (checked by the service). Clearing the override deletes the row.
 */
export const holdingAskOverrides = pgTable(
  "holding_ask_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roundKey: text("round_key").notNull(),
    flowId: uuid("flow_id").notNull().references(() => intercompanyFlows.id, { onDelete: "cascade" }),
    personId: uuid("person_id").notNull().references(() => people.id, { onDelete: "cascade" }),
    setBy: uuid("set_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("holding_ask_overrides_round_flow_uq").on(t.roundKey, t.flowId),
    check("holding_ask_overrides_round", sql`${t.roundKey} ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`),
  ],
);

// ---------------------------------------------------------------------------
// AI roles: "hire" an AI agent for a role in a company (src/lib/ai-roles.ts is the
// catalogue; services/ai-roles.ts the logic). Founders only. Only the two founders are ever
// asked for data or told about reports; people records never receive anything.
// ---------------------------------------------------------------------------
export const aiTemplateStatusEnum = pgEnum("ai_template_status", ["available", "coming_soon"]);
export const aiHireStatusEnum = pgEnum("ai_hire_status", ["active", "paused"]);
export const aiRunStatusEnum = pgEnum("ai_run_status", ["waiting_for_data", "ready", "analysed", "reported", "failed"]);
export const aiRequestStatusEnum = pgEnum("ai_request_status", ["active", "done", "cancelled"]);

/** Copy of the code-defined role catalogue (seeded; the code stays the source of truth). */
export const aiRoleTemplates = pgTable("ai_role_templates", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  status: aiTemplateStatusEnum("status").notNull().default("coming_soon"),
  responsibilities: jsonb("responsibilities").$type<string[]>().notNull().default([]),
  /** { byCompanyType: { delivery: ["revenue", …] }, optionalUploads: [...] } */
  requiredData: jsonb("required_data").$type<{ byCompanyType: Record<string, string[]>; optionalUploads: string[] }>().notNull(),
  defaultSchedule: jsonb("default_schedule").$type<AiScheduleJson>().notNull(),
  reportSections: jsonb("report_sections").$type<string[]>().notNull().default([]),
  sort: integer("sort").notNull().default(100),
  updatedAt: updatedAt(),
});

/** A role hired for one company, with its tuned settings (see HireSettings in src/lib/ai-roles.ts). */
export const aiRoleHires = pgTable(
  "ai_role_hires",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateKey: text("template_key").notNull().references(() => aiRoleTemplates.key, { onDelete: "restrict" }),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "restrict" }),
    status: aiHireStatusEnum("status").notNull().default("active"),
    settings: jsonb("settings").$type<AiHireSettingsJson>().notNull(),
    notes: text("notes"),
    hiredBy: uuid("hired_by").references(() => users.id, { onDelete: "set null" }),
    /** Calendar day (Asia/Bishkek) it was hired: the first month analysed is the one before. */
    hiredOn: date("hired_on", { mode: "string" }).notNull(),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("ai_role_hires_template_company_uq").on(t.templateKey, t.companyId)],
);

export type AiScheduleJson = { kind: "monthly"; day: number } | { kind: "weekly"; weekday: number } | { kind: "off" };

export interface AiHireSettingsJson {
  schedule: AiScheduleJson;
  thresholds: { changePct: number; riskChangePct: number };
  requiredMetricKeys: string[];
  recipients: string[];
  askUserIds: string[];
  /**
   * Accept month totals for daily numbers whose days are incomplete (absent = false). New
   * Financial Analyst hires get true (founders' decision); 0016 set it on existing ones.
   */
  acceptMonthlyTotals?: boolean;
  /** Org Structure Expert only: flag a person heading more than this many departments (default 4). */
  maxDepartmentsPerHead?: number;
  /** This hire's own rule checks (absent = the role's), see src/lib/ai-role-config.ts. */
  checks?: Record<string, { enabled: boolean } & Record<string, number | boolean | null>>;
  /** This hire's own name / job description / responsibilities / instructions (absent = the role's). */
  profile?: { name?: string; description?: string; responsibilities?: string[]; instructions?: string };
}

/**
 * Role-level settings edited in the cockpit (0021): for a built-in role (key = its template
 * key) the founders' edits of its identity, default schedule / recipients and check
 * defaults; for a custom role (kind = custom, key = "custom-…") its whole definition: the
 * company, the numbers it watches, its generic checks. Custom roles also get a row in
 * ai_role_templates so hires reference them like built-ins. Founders only.
 */
export const aiRoleConfigs = pgTable(
  "ai_role_configs",
  {
    key: text("key").primaryKey(),
    kind: text("kind").$type<"builtin" | "custom">().notNull(),
    /** Custom roles: the company it works for (one company per custom role). */
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "restrict" }),
    /** Custom roles copied from a built-in role: its key. */
    basedOn: text("based_on"),
    /** See RoleConfig in src/lib/ai-role-config.ts. */
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Version of `config` (1 = created; +1 per edit or revert; see ai_role_settings_log). */
    version: integer("version").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("ai_role_configs_kind", sql`${t.kind} in ('builtin', 'custom')`),
    check("ai_role_configs_custom_company", sql`${t.kind} <> 'custom' or ${t.companyId} is not null`),
  ],
);

/**
 * Every edit of a role's or a hire's settings (who / when / before / after), numbered per
 * scope ("role:<key>" or "hire:<id>"). A revert restores an earlier version's `after` and is
 * logged as a new version itself. Rows are never changed or deleted.
 */
export const aiRoleSettingsLog = pgTable(
  "ai_role_settings_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scopeKey: text("scope_key").notNull(),
    roleKey: text("role_key").notNull(),
    hireId: uuid("hire_id").references(() => aiRoleHires.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    /** create | edit | revert | reset (back to the defaults, 0025) */
    action: text("action").notNull(),
    revertedTo: integer("reverted_to"),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown>>().notNull(),
    changedBy: uuid("changed_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("ai_role_settings_log_scope_version_uq").on(t.scopeKey, t.version),
    check("ai_role_settings_log_action", sql`${t.action} in ('create', 'edit', 'revert', 'reset')`),
  ],
);

/** One run of a hire for one month: waiting_for_data → ready → analysed → reported (or failed). */
export const aiRoleRuns = pgTable(
  "ai_role_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hireId: uuid("hire_id").notNull().references(() => aiRoleHires.id, { onDelete: "restrict" }),
    /** First day of the month analysed. */
    period: date("period", { mode: "string" }).notNull(),
    status: aiRunStatusEnum("status").notNull().default("waiting_for_data"),
    /** What is still missing: [{ metricId, key, label, detail }]. */
    missing: jsonb("missing").$type<AiRunMissing[]>().notNull().default([]),
    /** sha256 of the numbers the analysis used (a later correction changes it). */
    inputsHash: text("inputs_hash"),
    /**
     * sha256 of the settings the analysis used (required numbers, thresholds): a Tune after the
     * report says "Settings changed", not "Numbers changed". Null on rows from before 0013
     * (their inputs_hash covered both).
     */
    settingsHash: text("settings_hash"),
    /** Failed attempts in a row (reset when a run succeeds). */
    attempts: integer("attempts").notNull().default(0),
    /** After a failure: not retried by the tick before this time (1 h, 6 h, 24 h, …). */
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    /** The numbers used, per metric and month (exact decimal text). */
    inputs: jsonb("inputs").$type<AiRunInputs | null>(),
    findings: jsonb("findings").$type<unknown[]>().notNull().default([]),
    narrative: text("narrative"),
    /** narrative_skipped (no provider) | narrative_done | narrative_failed */
    narrativeStatus: text("narrative_status"),
    /** AI provider id used for the narrative ("none" until one is chosen). */
    provider: text("provider"),
    /**
     * The last error. With status failed: the run never produced a report. With analysed /
     * reported: re-analysing failed and the last good report is kept (status unchanged).
     */
    error: text("error"),
    /** schedule | manual */
    trigger: text("trigger").notNull().default("schedule"),
    analysedAt: timestamp("analysed_at", { withTimezone: true }),
    reportedAt: timestamp("reported_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("ai_role_runs_hire_period_uq").on(t.hireId, t.period),
    check("ai_role_runs_period_first", sql`extract(day from ${t.period}) = 1`),
  ],
);

export interface AiRunMissing {
  metricId: string;
  key: string;
  label: string;
  /** "no value" | "12 of 31 days missing" */
  detail: string;
}

export interface AiRunInputs {
  months: string[];
  metrics: {
    metricId: string;
    key: string;
    label: string;
    unit: string;
    values: (string | null)[];
    /**
     * Per month: true when the value is a month total a founder entered (the days were
     * incomplete and the role accepts monthly totals). Absent when no month used one.
     */
    fromMonthTotal?: boolean[];
    /** The mark the report shows next to such a value: "(month total entered)". */
    monthTotalMark?: string;
  }[];
}

/**
 * A data request: "Financial Analyst needs October numbers for Kiwi Go: …", ONE line in a
 * founder's morning summary, chased daily for 7 days and then weekly (never more than once
 * a day). A new round (month) supersedes the founder's older active request of that hire.
 */
export const aiDataRequests = pgTable(
  "ai_data_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    hireId: uuid("hire_id").notNull().references(() => aiRoleHires.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** The newest month asked for (YYYY-MM-01). */
    roundKey: text("round_key").notNull(),
    status: aiRequestStatusEnum("status").notNull().default("active"),
    /** Local day it was created (start of the daily-then-weekly cadence). */
    createdOn: date("created_on", { mode: "string" }).notNull(),
    /** Local day it was last shown in a morning summary. */
    lastShownOn: date("last_shown_on", { mode: "string" }),
    shownCount: integer("shown_count").notNull().default(0),
    outboxId: uuid("outbox_id").references(() => notificationsOutbox.id, { onDelete: "set null" }),
    reason: text("reason"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("ai_data_requests_round_uq").on(t.hireId, t.userId, t.roundKey)],
);

// ---------------------------------------------------------------------------
// Org structure (C3b): Vysotsky model — 7 divisions, 21 departments, functions (posts).
// One chart per company, optionally per company unit (e.g. Alura Style ХБК). Content is in
// Russian. Every row is archived, never deleted; every change is written to org_change_log
// (who / when / before / after), which also drives Undo. company_id is copied onto every row
// so company isolation is a single column check (src/server/services/org.ts).
// ---------------------------------------------------------------------------
export const orgCharts = pgTable(
  "org_charts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    /** Null = the whole company; set = a chart for one unit (factory). */
    companyUnitId: uuid("company_unit_id").references(() => companyUnits.id, { onDelete: "restrict" }),
    /** "vysotsky-7-21" or "kiwi-go-seed". */
    templateKey: text("template_key").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("org_charts_company_unit_uq").on(t.companyId, t.companyUnitId).nullsNotDistinct(),
    // Target of the composite foreign keys below (0020): a row's company is its chart's company.
    unique("org_charts_id_company_uq").on(t.id, t.companyId),
  ],
);

export const orgDivisions = pgTable(
  "org_divisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chartId: uuid("chart_id")
      .notNull()
      .references(() => orgCharts.id, { onDelete: "restrict" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    /** 1–7 (Vysotsky). Shown in the order 7, 1, 2, 3, 4, 5, 6. */
    number: integer("number").notNull(),
    name: text("name").notNull().default(""),
    /** True while the name is still the template's default (an edit clears it). */
    nameIsDefault: boolean("name_is_default").notNull().default(false),
    /** "Руководитель:" — the head's post title (text). */
    headTitle: text("head_title").notNull().default(""),
    /** "Подчинение:" — whom the head reports to (text). */
    reportsTo: text("reports_to").notNull().default(""),
    /** ЦКП — ценный конечный продукт. */
    ckp: text("ckp").notNull().default(""),
    headPersonId: uuid("head_person_id").references(() => people.id, { onDelete: "restrict" }),
    sort: integer("sort").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("org_divisions_chart_idx").on(t.chartId),
    check("org_divisions_number_range", sql`${t.number} between 1 and 7`),
    unique("org_divisions_id_chart_uq").on(t.id, t.chartId),
    foreignKey({ name: "org_divisions_chart_company_fk", columns: [t.chartId, t.companyId], foreignColumns: [orgCharts.id, orgCharts.companyId] }),
  ],
);

export const orgDepartments = pgTable(
  "org_departments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chartId: uuid("chart_id")
      .notNull()
      .references(() => orgCharts.id, { onDelete: "restrict" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    divisionId: uuid("division_id")
      .notNull()
      .references(() => orgDivisions.id, { onDelete: "restrict" }),
    /** 1–21 in the model; departments added later get the next free number (up to 99). */
    number: integer("number").notNull(),
    name: text("name").notNull().default(""),
    nameIsDefault: boolean("name_is_default").notNull().default(false),
    ckp: text("ckp").notNull().default(""),
    /** "Статистика:" (text). */
    statistic: text("statistic").notNull().default(""),
    /** Optional link to a company number (C4) that measures the statistic. */
    metricDefinitionId: uuid("metric_definition_id").references(() => metricDefinitions.id, { onDelete: "restrict" }),
    headPersonId: uuid("head_person_id").references(() => people.id, { onDelete: "restrict" }),
    /** Order inside the division (0, 1, 2, … after every change). */
    sort: integer("sort").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("org_departments_chart_idx").on(t.chartId),
    index("org_departments_division_idx").on(t.divisionId),
    check("org_departments_number_range", sql`${t.number} between 1 and 99`),
    /** A number is used by at most one live department of a chart (0020; archived ones keep theirs). */
    uniqueIndex("org_departments_live_number_uq").on(t.chartId, t.number).where(sql`${t.archivedAt} is null`),
    unique("org_departments_id_chart_uq").on(t.id, t.chartId),
    foreignKey({ name: "org_departments_chart_company_fk", columns: [t.chartId, t.companyId], foreignColumns: [orgCharts.id, orgCharts.companyId] }),
    foreignKey({ name: "org_departments_division_chart_fk", columns: [t.divisionId, t.chartId], foreignColumns: [orgDivisions.id, orgDivisions.chartId] }),
  ],
);

export const orgFunctions = pgTable(
  "org_functions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chartId: uuid("chart_id")
      .notNull()
      .references(() => orgCharts.id, { onDelete: "restrict" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => orgDepartments.id, { onDelete: "restrict" }),
    text: text("text").notNull(),
    responsiblePersonId: uuid("responsible_person_id").references(() => people.id, { onDelete: "restrict" }),
    /** Order inside the department (0, 1, 2, … after every change). */
    sort: integer("sort").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("org_functions_department_idx").on(t.departmentId),
    index("org_functions_chart_idx").on(t.chartId),
    foreignKey({ name: "org_functions_chart_company_fk", columns: [t.chartId, t.companyId], foreignColumns: [orgCharts.id, orgCharts.companyId] }),
    foreignKey({ name: "org_functions_department_chart_fk", columns: [t.departmentId, t.chartId], foreignColumns: [orgDepartments.id, orgDepartments.chartId] }),
  ],
);

/**
 * Every change to a chart: who, when, what (before / after). The newest 20 changes that are
 * not undone can be undone one by one (newest first); an undo is logged too (action "undo",
 * itself not undoable). Append-only apart from `undone_at` / `undone_by`.
 */
export const orgChangeLog = pgTable(
  "org_change_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chartId: uuid("chart_id")
      .notNull()
      .references(() => orgCharts.id, { onDelete: "restrict" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** chart | division | department | function */
    entity: text("entity").notNull(),
    entityId: uuid("entity_id"),
    /** apply_template | seed | create | update | move | archive | restore | undo */
    action: text("action").notNull(),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    /** One line for the History list ("Moved function “Testing” to 4 Маркетинг"). */
    summary: text("summary").notNull(),
    /** For action = undo: the change it undid. */
    undoOf: uuid("undo_of"),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
    undoneBy: uuid("undone_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    /** Insert order (two changes can share created_at inside one request). */
    seq: bigint("seq", { mode: "number" }).generatedByDefaultAsIdentity(),
  },
  (t) => [
    index("org_change_log_chart_idx").on(t.chartId, t.seq),
    foreignKey({ name: "org_change_log_chart_company_fk", columns: [t.chartId, t.companyId], foreignColumns: [orgCharts.id, orgCharts.companyId] }),
  ],
);

export type OrgChart = typeof orgCharts.$inferSelect;
export type OrgDivision = typeof orgDivisions.$inferSelect;
export type OrgDepartment = typeof orgDepartments.$inferSelect;
export type OrgFunction = typeof orgFunctions.$inferSelect;
export type OrgChangeLogRow = typeof orgChangeLog.$inferSelect;

export type AiRoleTemplateRow = typeof aiRoleTemplates.$inferSelect;
export type AiRoleHire = typeof aiRoleHires.$inferSelect;
export type AiRoleRun = typeof aiRoleRuns.$inferSelect;
export type AiDataRequest = typeof aiDataRequests.$inferSelect;
export type AiRunStatus = (typeof aiRunStatusEnum.enumValues)[number];

export type IntercompanyFlow = typeof intercompanyFlows.$inferSelect;
export type IntercompanyContract = typeof intercompanyContracts.$inferSelect;
export type IntercompanyAct = typeof intercompanyActs.$inferSelect;
export type IntercompanyLedgerEntry = typeof intercompanyLedgerEntries.$inferSelect;
export type HoldingAskItem = typeof holdingAskItems.$inferSelect;
export type HoldingFile = typeof holdingFiles.$inferSelect;
export type ActStatus = (typeof actStatusEnum.enumValues)[number];
export type ContractStatus = (typeof contractStatusEnum.enumValues)[number];
export type FlowStatus = (typeof flowStatusEnum.enumValues)[number];

export type MetricDefinition = typeof metricDefinitions.$inferSelect;
export type MetricValue = typeof metricValues.$inferSelect;
export type ConnectorRun = typeof connectorRuns.$inferSelect;
export type MetricGranularity = (typeof metricGranularityEnum.enumValues)[number];
export type MetricDirection = (typeof metricDirectionEnum.enumValues)[number];
export type MetricSource = (typeof metricSourceEnum.enumValues)[number];
export type MetricAggregation = (typeof metricAggregationEnum.enumValues)[number];

export type User = typeof users.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type CompanyUnit = typeof companyUnits.$inferSelect;
export type Person = typeof people.$inferSelect;
export type PersonCompany = typeof personCompanies.$inferSelect;
export type Salary = typeof salaries.$inferSelect;
export const EMPLOYMENT_TYPES = employmentTypeEnum.enumValues;
export const SALARY_PAY_TYPES = salaryPayTypeEnum.enumValues;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export type SalaryPayType = (typeof SALARY_PAY_TYPES)[number];
export type Project = typeof projects.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskEvent = typeof taskEvents.$inferSelect;
export type OutboxItem = typeof notificationsOutbox.$inferSelect;
export type NotificationPreferences = typeof notificationPreferences.$inferSelect;
export type TelegramLink = typeof telegramLinks.$inferSelect;
export type TaskComment = typeof taskComments.$inferSelect;
export type TaskDeadlineRequest = typeof taskDeadlineRequests.$inferSelect;
export type NotificationPriority = (typeof notificationPriorityEnum.enumValues)[number];

export const TASK_STATUSES = taskStatusEnum.enumValues;
export const TASK_PRIORITIES = taskPriorityEnum.enumValues;
export const TASK_VISIBILITIES = taskVisibilityEnum.enumValues;
export const PROJECT_STATUSES = projectStatusEnum.enumValues;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskVisibility = (typeof TASK_VISIBILITIES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Jobutify (it_services): client projects with stage, status and SLA (0027). */
export const CLIENT_PROJECT_STAGES = ["lead", "discovery", "build", "implementation", "live_sla", "paused", "closed"] as const;
export const CLIENT_PROJECT_STATUSES = ["on_track", "at_risk", "late"] as const;
export const clientProjects = pgTable(
  "client_projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    clientName: text("client_name").notNull(),
    title: text("title").notNull(),
    stage: text("stage").$type<(typeof CLIENT_PROJECT_STAGES)[number]>().notNull().default("lead"),
    status: text("status").$type<(typeof CLIENT_PROJECT_STATUSES)[number]>().notNull().default("on_track"),
    startDate: date("start_date"),
    dueDate: date("due_date"),
    slaMonthlyFee: numeric("sla_monthly_fee", { precision: 14, scale: 2 }),
    slaCurrency: text("sla_currency").notNull().default("KGS"),
    slaResponseHours: integer("sla_response_hours"),
    nextInvoiceDate: date("next_invoice_date"),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("client_projects_company_idx").on(t.companyId),
    check("client_projects_stage_ck", sql`${t.stage} in ('lead','discovery','build','implementation','live_sla','paused','closed')`),
    check("client_projects_status_ck", sql`${t.status} in ('on_track','at_risk','late')`),
    check("client_projects_currency_ck", sql`${t.slaCurrency} ~ '^[A-Z]{3}$'`),
  ],
);

/**
 * Posts inside an org department (0027): held by a person, or open ("hiring" + role title).
 * Shown as chips on the board: solid = held, dashed = hiring.
 */
export const orgPosts = pgTable(
  "org_posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chartId: uuid("chart_id")
      .notNull()
      .references(() => orgCharts.id, { onDelete: "restrict" }),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    departmentId: uuid("department_id")
      .notNull()
      .references(() => orgDepartments.id, { onDelete: "restrict" }),
    title: text("title").notNull().default(""),
    personId: uuid("person_id").references(() => people.id, { onDelete: "restrict" }),
    hiring: boolean("hiring").notNull().default(false),
    hiringRoleTitle: text("hiring_role_title"),
    sort: integer("sort").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("org_posts_department_idx").on(t.departmentId),
    check("org_posts_holder_ck", sql`not (${t.hiring} and ${t.personId} is not null)`),
    foreignKey({ name: "org_posts_chart_company_fk", columns: [t.chartId, t.companyId], foreignColumns: [orgCharts.id, orgCharts.companyId] }),
    foreignKey({ name: "org_posts_department_chart_fk", columns: [t.departmentId, t.chartId], foreignColumns: [orgDepartments.id, orgDepartments.chartId] }),
  ],
);

/** Editable "journey" strip above the org board, per company; each step may point at a department (0027). */
export const orgJourneySteps = pgTable(
  "org_journey_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "restrict" }),
    number: integer("number").notNull(),
    label: text("label").notNull(),
    departmentId: uuid("department_id").references(() => orgDepartments.id, { onDelete: "set null" }),
    sort: integer("sort").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("org_journey_steps_company_idx").on(t.companyId)],
);

// ---------------------------------------------------------------------------
// Claude connector: OAuth 2.1 for the remote MCP server (0030)
// ---------------------------------------------------------------------------

/**
 * Clients registered through dynamic client registration (RFC 7591), e.g. claude.ai.
 * Public clients (`token_endpoint_auth_method = none`, PKCE only) have no secret; confidential
 * ones get a secret that is shown once and stored as SHA-256 only.
 */
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The public `client_id` handed to the client (random, not the row id). */
  clientId: text("client_id").notNull().unique(),
  clientSecretHash: text("client_secret_hash"),
  clientName: text("client_name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull().default("none"),
  clientUri: text("client_uri"),
  createdAt: createdAt(),
});

/** One-time authorization codes (10 minutes, PKCE S256). Only the SHA-256 of the code is kept. */
export const oauthAuthCodes = pgTable(
  "oauth_auth_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codeHash: text("code_hash").notNull().unique(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    scope: text("scope").notNull(),
    resource: text("resource"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_auth_codes_expires_idx").on(t.expiresAt)],
);

/**
 * Access + refresh token pairs (opaque, SHA-256 stored). Every refresh issues a new pair in the
 * same `grant_id` and marks the old one rotated; presenting an already-rotated refresh token
 * revokes the whole grant (reuse detection). A grant is one "connected app" in Settings.
 */
export const oauthTokens = pgTable(
  "oauth_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    grantId: uuid("grant_id").notNull(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessTokenHash: text("access_token_hash").notNull().unique(),
    refreshTokenHash: text("refresh_token_hash").notNull().unique(),
    scope: text("scope").notNull(),
    resource: text("resource"),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }).notNull(),
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    /** Set when the pair was replaced by a refresh (rotation). */
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    /** Set when the grant was revoked (Settings → Connected apps, revocation endpoint, reuse). */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_tokens_grant_idx").on(t.grantId), index("oauth_tokens_user_idx").on(t.userId)],
);
