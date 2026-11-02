/**
 * Database schema (Drizzle ORM, PostgreSQL).
 *
 * Rules baked in here:
 * - Every company-owned row carries `company_id`. Services always filter by it.
 * - Personal todos are tasks with visibility = 'private'; only `owner_user_id` may see them.
 * - People ↔ companies has NO salary columns. Salaries will live in a separate,
 *   access-restricted table in a later chunk.
 *
 * This file is imported by app code, CLI scripts and tests, so it must stay free of
 * runtime side effects (no `server-only`, no connections).
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
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
export const outboxStatusEnum = pgEnum("outbox_status", [
  "pending",
  "sent",
  "failed",
  "cancelled",
  "parked",
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
export const people = pgTable("people", {
  id: uuid("id").primaryKey().defaultRandom(),
  fullName: text("full_name").notNull(),
  phone: text("phone"),
  telegramHandle: text("telegram_handle"),
  notes: text("notes"),
  /** Set when this person is also an app user (e.g. a founder). */
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Person ↔ company link with role/title. Deliberately NO salary columns. */
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
    startedOn: date("started_on", { mode: "string" }),
    endedOn: date("ended_on", { mode: "string" }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("person_companies_uq").on(t.personId, t.companyId, t.role),
    index("person_companies_company_idx").on(t.companyId),
  ],
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
});

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

export type User = typeof users.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type CompanyUnit = typeof companyUnits.$inferSelect;
export type Person = typeof people.$inferSelect;
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
