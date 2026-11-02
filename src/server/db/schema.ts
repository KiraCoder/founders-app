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
    kind: taskEventKindEnum("kind").notNull(),
    field: text("field"),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    createdAt: createdAt(),
  },
  (t) => [index("task_events_task_idx").on(t.taskId)],
);

// ---------------------------------------------------------------------------
// Notifications (channel layer arrives next chunk; table only)
// ---------------------------------------------------------------------------
export const notificationsOutbox = pgTable(
  "notifications_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** e.g. "telegram", later "push". */
    channel: text("channel").notNull(),
    /** e.g. "morning_summary", "overdue_chase", "agent_request". */
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull().default({}),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    status: outboxStatusEnum("status").notNull().default("pending"),
    /** Prevents sending the same reminder twice. */
    dedupeKey: text("dedupe_key").unique(),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_outbox_due_idx").on(t.status, t.scheduledFor)],
);

export type User = typeof users.$inferSelect;
export type Company = typeof companies.$inferSelect;
export type CompanyUnit = typeof companyUnits.$inferSelect;
export type Person = typeof people.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Task = typeof tasks.$inferSelect;
export type TaskEvent = typeof taskEvents.$inferSelect;

export const TASK_STATUSES = taskStatusEnum.enumValues;
export const TASK_PRIORITIES = taskPriorityEnum.enumValues;
export const TASK_VISIBILITIES = taskVisibilityEnum.enumValues;
export const PROJECT_STATUSES = projectStatusEnum.enumValues;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type TaskVisibility = (typeof TASK_VISIBILITIES)[number];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
