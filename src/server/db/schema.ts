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
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const userRoleEnum = pgEnum("user_role", ["founder", "staff"]);
export const companyKindEnum = pgEnum("company_kind", ["operating", "service", "holding"]);
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
  kind: companyKindEnum("kind").notNull().default("operating"),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("people_full_name_idx").on(t.fullName)],
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

/** Users allowed to see and edit salaries. Default: only Nuraaly (seeded). */
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
    status: taskStatusEnum("status").notNull().default("todo"),
    priority: taskPriorityEnum("priority").notNull().default("normal"),
    /** Calendar date in APP_TIMEZONE (Asia/Bishkek). */
    dueDate: date("due_date", { mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_company_idx").on(t.companyId),
    index("tasks_project_idx").on(t.projectId),
    index("tasks_owner_idx").on(t.ownerUserId),
    index("tasks_assignee_user_idx").on(t.assigneeUserId),
    index("tasks_due_idx").on(t.dueDate),
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
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
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
    uniqueIndex("notifications_outbox_user_dedupe_uq").on(t.userId, t.dedupeKey),
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
  updatedAt: updatedAt(),
}, (t) => [
  check("notification_preferences_morning_hm", sql`${t.morningSummaryTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check("notification_preferences_evening_hm", sql`${t.eveningCheckTime} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check("notification_preferences_quiet_start_hm", sql`${t.quietStart} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check("notification_preferences_quiet_end_hm", sql`${t.quietEnd} ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
  check("notification_preferences_max_other_range", sql`${t.maxOtherPerDay} between 0 and 10`),
]);

/** A founder's linked Telegram private chat. One per user, one user per chat. */
export const telegramLinks = pgTable("telegram_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  chatId: text("chat_id").notNull().unique(),
  telegramUserId: text("telegram_user_id").notNull(),
  username: text("username"),
  firstName: text("first_name"),
  createdAt: createdAt(),
});

/** One-time codes for `/start CODE`. Only a SHA-256 hash is stored. */
export const telegramLinkCodes = pgTable(
  "telegram_link_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("telegram_link_codes_user_idx").on(t.userId)],
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
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** "done" | "snooze_1d" | "move_1d" | "move_3d" */
    action: text("action").notNull(),
    outboxId: uuid("outbox_id").references(() => notificationsOutbox.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notification_action_tokens_user_idx").on(t.userId)],
);

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
export const metricSourceEnum = pgEnum("metric_source", ["manual", "upload", "connector"]);
export const connectorRunStatusEnum = pgEnum("connector_run_status", ["ok", "not_configured", "error"]);

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
    connectorRunId: uuid("connector_run_id"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("metric_values_current_uq").on(t.metricId, t.periodStart).where(sql`${t.isCurrent}`),
    index("metric_values_metric_period_idx").on(t.metricId, t.periodStart),
  ],
);

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
    triggeredBy: uuid("triggered_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("connector_runs_connector_idx").on(t.connectorId, t.startedAt)],
);

export type MetricDefinition = typeof metricDefinitions.$inferSelect;
export type MetricValue = typeof metricValues.$inferSelect;
export type ConnectorRun = typeof connectorRuns.$inferSelect;
export type MetricGranularity = (typeof metricGranularityEnum.enumValues)[number];
export type MetricDirection = (typeof metricDirectionEnum.enumValues)[number];
export type MetricSource = (typeof metricSourceEnum.enumValues)[number];

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
export type NotificationPriority = (typeof notificationPriorityEnum.enumValues)[number];

export const TASK_STATUSES = taskStatusEnum.enumValues;
export const TASK_PRIORITIES = taskPriorityEnum.enumValues;
export const TASK_VISIBILITIES = taskVisibilityEnum.enumValues;
export const PROJECT_STATUSES = projectStatusEnum.enumValues;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskVisibility = (typeof TASK_VISIBILITIES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
