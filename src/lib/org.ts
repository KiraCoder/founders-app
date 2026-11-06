/**
 * Org structure (C3b): the Vysotsky model — 7 divisions, 21 departments, functions (posts) —
 * its template, the Kiwi Go chart transcribed from the founders' old cockpit, input schemas
 * and the Org Structure Expert's deterministic rules (no AI).
 *
 * Pure (no DB, no clock). Org content is in Russian; the interface is in English.
 */
import { z } from "zod";
import { personCreateSchema } from "./people-schemas";

/** Divisions are shown in this order (the model puts the administrative division 7 first). */
export const DIVISION_DISPLAY_ORDER = [7, 1, 2, 3, 4, 5, 6] as const;

export function divisionDisplayRank(number: number): number {
  const i = (DIVISION_DISPLAY_ORDER as readonly number[]).indexOf(number);
  return i === -1 ? 99 : i;
}

export const VYSOTSKY_TEMPLATE_KEY = "vysotsky-7-21";
export const KIWI_GO_TEMPLATE_KEY = "kiwi-go-old-cockpit";

export interface TemplateDepartment {
  number: number;
  name: string;
  /** Name is the template default (shown as "default name" until edited). */
  nameIsDefault?: boolean;
  ckp?: string;
  statistic?: string;
  functions?: string[];
}

export interface TemplateDivision {
  number: number;
  name: string;
  nameIsDefault?: boolean;
  headTitle?: string;
  reportsTo?: string;
  ckp?: string;
  departments: TemplateDepartment[];
}

const dept = (number: number, name: string): TemplateDepartment => ({ number, name, nameIsDefault: true });

/**
 * "Vysotsky 7/21 (empty)": standard division names (editable defaults) and departments 1–21
 * numbered and placed (19–21 in 7, 1–3 in 1, 4–6 in 2, … 16–18 in 6). No ЦКП, statistics or
 * functions — the founders fill those in.
 */
export const VYSOTSKY_TEMPLATE: TemplateDivision[] = [
  { number: 7, name: "Административное", nameIsDefault: true, departments: [dept(21, "Отдел владельца"), dept(20, "Официальные вопросы"), dept(19, "Офис руководителя")] },
  { number: 1, name: "Персонал", nameIsDefault: true, departments: [dept(1, "Найм и ввод в должность"), dept(2, "Коммуникации"), dept(3, "Инспекции и статистики")] },
  { number: 2, name: "Коммерческое", nameIsDefault: true, departments: [dept(4, "Маркетинг"), dept(5, "Продажи"), dept(6, "Приём заказов")] },
  { number: 3, name: "Финансы", nameIsDefault: true, departments: [dept(7, "Доходы"), dept(8, "Расходы"), dept(9, "Учёт и активы")] },
  { number: 4, name: "Производство", nameIsDefault: true, departments: [dept(10, "Планирование производства"), dept(11, "Производство"), dept(12, "Выпуск продукции")] },
  { number: 5, name: "Качество", nameIsDefault: true, departments: [dept(13, "Контроль качества"), dept(14, "Обучение"), dept(15, "Коррекция")] },
  { number: 6, name: "Расширение", nameIsDefault: true, departments: [dept(16, "Связи с общественностью"), dept(17, "Привлечение клиентов"), dept(18, "Развитие и новые направления")] },
];

/**
 * Kiwi Go, transcribed from the old cockpit (docs/reference/old-cockpit-org-board-kiwi-go.png).
 * Divisions 7, 1, 2, 3 are complete. Division 4 is cut off in the screenshot: only the visible
 * starts of the department names are kept, marked "(уточнить)". Divisions 5 and 6 have the
 * template names and empty departments 13–18.
 */
export const KIWI_GO_ORG: TemplateDivision[] = [
  {
    number: 7,
    name: "Административное",
    headTitle: "Генеральный директор",
    reportsTo: "Генеральный директор",
    ckp: "Скоординированная, растущая и прибыльная компания, работающая по планам учредителей.",
    departments: [
      {
        number: 21,
        name: "Отдел владельца",
        ckp: "Планы учредителей, превращённые в утверждённые цели компании.",
        statistic: "% выполненных целей квартала",
        functions: ["Связь с учредителями и Asqa Zou", "Стратегия и решения об открытии новых городов", "Контроль договора с Jobutify (развитие платформы)"],
      },
      {
        number: 20,
        name: "Официальные вопросы",
        ckp: "Юридически защищённая компания без штрафов и проигранных споров.",
        statistic: "Открытые юр. риски, сумма штрафов",
        functions: [
          "Юрист: договоры с мерчантами, перевозчиками, курьерами",
          "Регулирование COD и платежей",
          "Разрешения и госорганы в городах",
          "Охрана труда и безопасность на дороге",
        ],
      },
      {
        number: 19,
        name: "Офис генерального директора",
        ckp: "Решения исполнительного совета, выполненные в срок.",
        statistic: "% решений, выполненных в срок",
        functions: ["Исполнительный совет", "Недельное планирование и распределение фондов", "Владелец продукта платформы: требования, приёмка релизов"],
      },
    ],
  },
  {
    number: 1,
    name: "Персонал",
    headTitle: "Директор по персоналу",
    reportsTo: "Генеральный директор",
    ckp: "Укомплектованные посты с введёнными в должность сотрудниками, производящими свои статистики.",
    departments: [
      {
        number: 1,
        name: "Найм и ввод в должность",
        ckp: "Курьеры и сотрудники, прошедшие испытательный срок.",
        statistic: "Курьеры, отработавшие 30 дней",
        functions: [
          "Массовый найм курьеров — рекрутеры по городам",
          "Найм офисного персонала",
          "Оформление и кадровый учёт",
          "Ввод: договор, экипировка, доступ в приложение",
        ],
      },
      {
        number: 2,
        name: "Коммуникации",
        ckp: "Каждое обращение быстро попадает к нужному посту.",
        statistic: "% обращений, переданных в срок",
        functions: [
          "Маршрутизация звонков и сообщений (бот, IVR) по функциям",
          "Внутренние каналы и оповещения",
          "Доступы к платформе и устройства: телефоны, сканеры, терминалы",
          "Офисы и хозяйственная часть в городах",
        ],
      },
      {
        number: 3,
        name: "Инспекции и статистики",
        ckp: "Достоверные статистики и раскрытые нарушения.",
        statistic: "% постов, сдавших статистику в срок",
        functions: [
          "Статистики всех постов — из системы, сдача по четвергам",
          "Расчёт переменной части оплаты → передача в отдел 8",
          "Безопасность: расследование недостач и утрат",
          "Дисциплина, поощрения, взыскания",
        ],
      },
    ],
  },
  {
    number: 2,
    name: "Коммерческое",
    headTitle: "Коммерческий директор",
    reportsTo: "Коммерческий директор",
    ckp: "Выручка от доставки по плану продаж.",
    departments: [
      {
        number: 4,
        name: "Маркетинг",
        ckp: "Новые отправители по плановой стоимости привлечения.",
        statistic: "Новые отправители, стоимость привлечения",
        functions: ["Бренд Kiwi Go и контент", "Маркетинг приложения для частных отправителей", "Тарифы и аналитика спроса по городам и направлениям"],
      },
      {
        number: 5,
        name: "Продажи",
        ckp: "Договоры с мерчантами, начавшими отгрузку.",
        statistic: "Мерчанты с первой отгрузкой за неделю",
        functions: ["Менеджеры по продажам в городах", "Ключевые клиенты: крупные магазины, маркетплейсы", "Межгородская логистика для бизнеса", "Testing"],
      },
      {
        number: 6,
        name: "Приём заказов и сервис",
        ckp: "Правильно оформленные и оплаченные заказы.",
        statistic: "Принятые заказы, % ошибок оформления",
        functions: [
          "Пункты приёма в городах: оформление, тариф, оплата",
          "Поддержка отправителей и получателей (статусы, вопросы)",
          "Подключение мерчантов по API и интеграции",
        ],
      },
    ],
  },
  {
    number: 3,
    name: "Финансы",
    headTitle: "Финансовый директор",
    reportsTo: "Финансовый директор",
    ckp: "Сохранённые и учтённые деньги компании и клиентов. Деньги COD — только на отдельном счёте.",
    departments: [
      {
        number: 7,
        name: "Доходы и COD",
        ckp: "Вся выручка и COD на счетах в день сбора.",
        statistic: "% COD, сданного в день сбора",
        functions: [
          "Счета мерчантам и дебиторка",
          "Контролёр COD: реестр собранных денег",
          "Кассиры городов: приём наличных от курьеров ежедневно",
          "Сверка QR, карт и эквайринга",
        ],
      },
      {
        number: 8,
        name: "Расходы и выплаты",
        ckp: "Обязательства оплачены в срок и полностью.",
        statistic: "% выплат мерчантам в срок",
        functions: [
          "Выплаты мерчантам по реестру с COD-счёта",
          "Сдельная оплата курьеров — еженедельно",
          "Оплата перевозчиков после подтверждения хаба",
          "Закупки: экипировка, пломбы, упаковка, устройства",
        ],
      },
      {
        number: 9,
        name: "Учёт и активы",
        ckp: "Полностью учтённые активы и своевременная отчётность.",
        statistic: "Расхождения инвентаризации",
        functions: ["Бухгалтерия и налоги", "Финансовое планирование: фонды каждую неделю", "Учёт имущества: транспорт, устройства, хабы"],
      },
    ],
  },
  {
    number: 4,
    name: "Операции",
    departments: [
      { number: 10, name: "Пл… ди… (уточнить)" },
      { number: 11, name: "Ха… (уточнить)" },
      { number: 12, name: "До… (уточнить)" },
    ],
  },
  { number: 5, name: "Качество", nameIsDefault: true, departments: [13, 14, 15].map((n) => ({ number: n, name: "" })) },
  { number: 6, name: "Расширение", nameIsDefault: true, departments: [16, 17, 18].map((n) => ({ number: n, name: "" })) },
];

/** Org charts the seed creates (only when the company has no chart yet; edits are never overwritten). */
export const ORG_SEED: Record<string, { templateKey: string; divisions: TemplateDivision[] }> = {
  "kiwi-go": { templateKey: KIWI_GO_TEMPLATE_KEY, divisions: KIWI_GO_ORG },
};

// ---------------------------------------------------------------------------
// Input schemas (server actions; the service validates again)
// ---------------------------------------------------------------------------

const text = (max: number) => z.string().trim().max(max);
const nullableUuid = z.preprocess((v) => (v === "" ? null : v), z.uuid().nullable());

export const divisionPatchSchema = z
  .object({
    name: text(120).optional(),
    headTitle: text(200).optional(),
    reportsTo: text(200).optional(),
    ckp: text(1000).optional(),
    headPersonId: nullableUuid.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });
export type DivisionPatch = z.input<typeof divisionPatchSchema>;

export const departmentPatchSchema = z
  .object({
    name: text(160).optional(),
    number: z.coerce.number().int().min(1).max(99).optional(),
    ckp: text(1000).optional(),
    statistic: text(500).optional(),
    metricDefinitionId: nullableUuid.optional(),
    headPersonId: nullableUuid.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });
export type DepartmentPatch = z.input<typeof departmentPatchSchema>;

export const departmentCreateSchema = z
  .object({
    divisionId: z.uuid(),
    name: text(160).min(1, "Give the department a name"),
  })
  .strict();

export const functionPatchSchema = z
  .object({
    text: text(500).min(1, "A function needs a text").optional(),
    responsiblePersonId: nullableUuid.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });
export type FunctionPatch = z.input<typeof functionPatchSchema>;

export const functionCreateSchema = z
  .object({
    departmentId: z.uuid(),
    text: text(500).min(1, "A function needs a text"),
  })
  .strict();

/** Where "+ New person" assigns the person it creates. */
export const ORG_ASSIGN_TARGETS = ["division", "department", "function", "post"] as const;
export type OrgAssignTarget = (typeof ORG_ASSIGN_TARGETS)[number];

/**
 * "+ New person" on the org board: a person (same field rules as the People page) created,
 * linked to the chart's company with `role` and assigned to a division / department head, a
 * function or a post (the post stops "hiring") in one step.
 */
export const orgNewPersonSchema = personCreateSchema
  .pick({ fullName: true, shortName: true, phone: true, telegramHandle: true })
  .extend({
    target: z.enum(ORG_ASSIGN_TARGETS),
    targetId: z.uuid(),
    role: z.string().trim().min(1, "Role / title is required").max(120),
  })
  .strict();
export type OrgNewPersonInput = z.input<typeof orgNewPersonSchema>;

/** Default role of a new person: the department's or function's name (role field limit 120). */
export function defaultOrgRole(text: string): string {
  const t = text.trim();
  return t.length > 120 ? `${t.slice(0, 119)}…` : t;
}

/** "Тест Курьеров" → "ТК"; "Elmurat" → "EL"; "" → "?". */
export function personInitials(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** Move a function to a department (same or another) at a position (0 = first; past the end = last). */
export const functionMoveSchema = z.object({ functionId: z.uuid(), departmentId: z.uuid(), index: z.coerce.number().int().min(0).max(10_000) }).strict();
/** Move a department to a division (same or another) at a position. */
export const departmentMoveSchema = z.object({ departmentId: z.uuid(), divisionId: z.uuid(), index: z.coerce.number().int().min(0).max(10_000) }).strict();

/** Returns `list` with `item` moved to `index` (clamped). The item is removed first if present. */
export function placeAt<T>(list: readonly T[], item: T, index: number): T[] {
  const rest = list.filter((x) => x !== item);
  const i = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, i), item, ...rest.slice(i)];
}

// ---------------------------------------------------------------------------
// Posts (chips on a department card): held by a person, or open — "hiring" + role title
// ---------------------------------------------------------------------------

/**
 * A post is held by a person OR hiring (the database refuses both, 0027), or empty. Hiring
 * needs the role being hired for ("Менеджер по продажам").
 */
const postFields = {
  title: text(160).optional(),
  personId: nullableUuid.optional(),
  hiring: z.boolean().optional(),
  hiringRoleTitle: z.preprocess((v) => (v === "" ? null : v), text(160).nullable()).optional(),
};
const holderRule = (v: { personId?: string | null; hiring?: boolean }) => !(v.hiring && v.personId);
const HOLDER_MESSAGE = { message: "A post is held by a person or open for hiring — not both", path: ["hiring"] };

export const postCreateSchema = z
  .object({ departmentId: z.uuid(), ...postFields })
  .strict()
  .refine(holderRule, HOLDER_MESSAGE)
  .refine((v) => !v.hiring || !!v.hiringRoleTitle, { message: "Which role are you hiring for?", path: ["hiringRoleTitle"] });
export type PostCreateInput = z.input<typeof postCreateSchema>;

export const postPatchSchema = z
  .object(postFields)
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" })
  .refine(holderRule, HOLDER_MESSAGE);
export type PostPatch = z.input<typeof postPatchSchema>;

export interface PostHolder {
  title: string;
  personId: string | null;
  hiring: boolean;
  hiringRoleTitle: string | null;
}

/**
 * The post after a patch: picking a person ends "hiring" (and drops its role title), marking
 * it hiring takes the person off. The service validates the result (hiring needs a role title).
 */
export function mergePost(current: PostHolder, patch: { title?: string; personId?: string | null; hiring?: boolean; hiringRoleTitle?: string | null }): PostHolder {
  const next: PostHolder = { title: current.title, personId: current.personId, hiring: current.hiring, hiringRoleTitle: current.hiringRoleTitle };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.hiringRoleTitle !== undefined) next.hiringRoleTitle = patch.hiringRoleTitle;
  if (patch.personId !== undefined) {
    next.personId = patch.personId;
    if (patch.personId) {
      next.hiring = false;
      if (patch.hiringRoleTitle === undefined) next.hiringRoleTitle = null;
    }
  }
  if (patch.hiring !== undefined) {
    next.hiring = patch.hiring;
    if (patch.hiring) next.personId = null;
    else if (patch.hiringRoleTitle === undefined) next.hiringRoleTitle = null;
  }
  return next;
}

/** What a post chip says: the holder's name, the role being hired for, or the post title. */
export function postChipLabel(p: { title: string; personName: string | null; hiring: boolean; hiringRoleTitle: string | null }): string {
  if (p.personName) return p.personName;
  if (p.hiring) return p.hiringRoleTitle || p.title || "Найм";
  return p.title || "Пост";
}

// ---------------------------------------------------------------------------
// Journey strip (numbered steps of the company's work, above the board)
// ---------------------------------------------------------------------------

export const journeyStepCreateSchema = z
  .object({
    label: text(160).min(1, "A step needs a name"),
    departmentId: nullableUuid.optional(),
  })
  .strict();
export type JourneyStepCreateInput = z.input<typeof journeyStepCreateSchema>;

export const journeyStepPatchSchema = z
  .object({
    label: text(160).min(1, "A step needs a name").optional(),
    departmentId: nullableUuid.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to change" });
export type JourneyStepPatch = z.input<typeof journeyStepPatchSchema>;

export const journeyMoveSchema = z.object({ stepId: z.uuid(), index: z.coerce.number().int().min(0).max(10_000) }).strict();

/** "01", "02", … "10". */
export const journeyNumber = (n: number) => String(n).padStart(2, "0");

/** Journey templates ("Use Upsell template"); departments stay unlinked until the founders pick them. */
export const JOURNEY_TEMPLATES = {
  upsell: {
    label: "Upsell",
    companySlug: "upsell-group",
    steps: ["Фабрика найдена", "Переговоры", "Образцы", "Договор", "Производство", "Контроль качества", "Отгрузка", "Продажи на маркетплейсах", "Деньги и 5% Upsell"],
  },
} as const;
export type JourneyTemplateKey = keyof typeof JOURNEY_TEMPLATES;
export const JOURNEY_TEMPLATE_KEYS = Object.keys(JOURNEY_TEMPLATES) as JourneyTemplateKey[];

/** The template offered to a company with no journey yet (by slug), if any. */
export function journeyTemplateFor(companySlug: string): JourneyTemplateKey | null {
  return JOURNEY_TEMPLATE_KEYS.find((k) => JOURNEY_TEMPLATES[k].companySlug === companySlug) ?? null;
}

// ---------------------------------------------------------------------------
// Board look: one tint per division (theme-safe: mixed with the surface colour)
// ---------------------------------------------------------------------------

/** Mid-tone hues readable on light and dark surfaces (the column number is large bold text). */
export const DIVISION_TINTS: Readonly<Record<number, string>> = {
  7: "#6d5bd0",
  1: "#2f8f5b",
  2: "#2b7bc0",
  3: "#c27a1f",
  4: "#c0464f",
  5: "#1f9a96",
  6: "#a8509a",
};

export function divisionTint(number: number): string {
  return DIVISION_TINTS[number] ?? "#7a8580";
}

// ---------------------------------------------------------------------------
// «Показать посты»: where a person sits on a chart (heads, functions, posts)
// ---------------------------------------------------------------------------

interface FootprintChart {
  divisions: {
    id: string;
    headPersonId: string | null;
    headName?: string | null;
    departments: {
      id: string;
      headPersonId: string | null;
      headName?: string | null;
      functions: { id: string; responsiblePersonId: string | null; responsibleName?: string | null }[];
      posts: { id: string; personId: string | null; personName?: string | null }[];
    }[];
  }[];
}

export interface PersonFootprint {
  divisions: Set<string>;
  departments: Set<string>;
  functions: Set<string>;
  posts: Set<string>;
  /** Departments where the person appears at all (head, function or post). */
  touched: Set<string>;
}

/** The ids a person holds on a chart, to highlight them (and dim everything else). */
export function personFootprint(chart: FootprintChart, personId: string): PersonFootprint {
  const out: PersonFootprint = { divisions: new Set(), departments: new Set(), functions: new Set(), posts: new Set(), touched: new Set() };
  for (const div of chart.divisions) {
    if (div.headPersonId === personId) out.divisions.add(div.id);
    for (const d of div.departments) {
      let hit = false;
      if (d.headPersonId === personId) {
        out.departments.add(d.id);
        hit = true;
      }
      for (const f of d.functions) {
        if (f.responsiblePersonId === personId) {
          out.functions.add(f.id);
          hit = true;
        }
      }
      for (const p of d.posts) {
        if (p.personId === personId) {
          out.posts.add(p.id);
          hit = true;
        }
      }
      if (hit) out.touched.add(d.id);
    }
  }
  return out;
}

/** People on a chart (heads, responsible people, post holders) with how many places each holds; most first. */
export function peopleOnChart(chart: FootprintChart): { id: string; name: string; count: number }[] {
  const map = new Map<string, { id: string; name: string; count: number }>();
  const add = (id: string | null, name: string | null | undefined) => {
    if (!id) return;
    const cur = map.get(id) ?? { id, name: "", count: 0 };
    cur.count += 1;
    if (!cur.name && name) cur.name = name;
    map.set(id, cur);
  };
  for (const div of chart.divisions) {
    add(div.headPersonId, div.headName);
    for (const d of div.departments) {
      add(d.headPersonId, d.headName);
      for (const f of d.functions) add(f.responsiblePersonId, f.responsibleName);
      for (const p of d.posts) add(p.personId, p.personName);
    }
  }
  return [...map.values()].map((p) => ({ ...p, name: p.name || "?" })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Org Structure Expert (deterministic rules; the narrative waits for the AI provider)
// ---------------------------------------------------------------------------

/** Default: one person heading more than this many departments is flagged. */
export const DEFAULT_MAX_DEPARTMENTS_PER_HEAD = 4;
/** A department with at least this many overdue tasks is flagged. */
export const OVERDUE_TASKS_THRESHOLD = 5;

export type OrgRule =
  | "no_chart"
  | "division_no_head"
  | "department_no_head"
  | "head_overloaded"
  | "department_no_ckp"
  | "department_no_statistic"
  | "metric_stale"
  | "overdue_tasks"
  | "function_no_responsible";

export type OrgSeverity = "warning" | "info";

export interface OrgFinding {
  rule: OrgRule;
  severity: OrgSeverity;
  /** Short English sentence; names of departments stay in Russian. */
  text: string;
  /** How many divisions / departments / functions / people it is about. */
  count: number;
  /** "7 Административное", "21 Отдел владельца", … (at most a few, for the strip). */
  items: string[];
  /** Ids of the departments / divisions it is about (the board highlights them). */
  ids: string[];
}

export interface OrgCheckInput {
  hasChart: boolean;
  divisions: { id: string; number: number; name: string; headPersonId: string | null }[];
  departments: {
    id: string;
    number: number;
    name: string;
    headPersonId: string | null;
    ckp: string;
    statistic: string;
    /** Linked metric and its freshness (C4): fresh | stale | very_stale | missing. */
    metric: { label: string; freshness: string } | null;
    overdueTasks: number;
  }[];
  functions: { id: string; text: string; responsiblePersonId: string | null }[];
  /** Person id → display name (for "Асель heads 5 departments"). */
  personNames: Record<string, string>;
}

export const deptLabel = (d: { number: number; name: string }) => `${d.number} ${d.name || "(без названия)"}`.trim();

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Findings for one chart, warnings first. Every rule produces at most ONE finding (grouped),
 * so the strip and the weekly summary line stay short however large the chart is.
 */
export interface OrgExpertOptions {
  maxDepartmentsPerHead?: number;
  /** A department with at least this many overdue tasks is flagged (default 5). */
  overdueTasksMin?: number;
  /** Checks turned off in the AI role editor (rule ids). */
  disabled?: readonly string[];
}

export function orgExpertFindings(input: OrgCheckInput, opts: OrgExpertOptions = {}): OrgFinding[] {
  if (!input.hasChart) {
    return [{ rule: "no_chart", severity: "info", text: "No org chart yet — apply the Vysotsky template to start", count: 0, items: [], ids: [] }];
  }
  const max = opts.maxDepartmentsPerHead ?? DEFAULT_MAX_DEPARTMENTS_PER_HEAD;
  const overdueMin = opts.overdueTasksMin ?? OVERDUE_TASKS_THRESHOLD;
  const off = new Set(opts.disabled ?? []);
  const out: OrgFinding[] = [];
  const depts = [...input.departments].sort((a, b) => a.number - b.number);
  const add = (rule: OrgRule, severity: OrgSeverity, list: { id: string; label: string }[], sentence: (n: number) => string) => {
    if (!list.length || off.has(rule)) return;
    out.push({ rule, severity, text: sentence(list.length), count: list.length, items: list.slice(0, 5).map((x) => x.label), ids: list.map((x) => x.id) });
  };

  const divNoHead = [...input.divisions]
    .sort((a, b) => divisionDisplayRank(a.number) - divisionDisplayRank(b.number))
    .filter((d) => !d.headPersonId)
    .map((d) => ({ id: d.id, label: deptLabel(d) }));
  add("division_no_head", "warning", divNoHead, (n) => `${plural(n, "division has", "divisions have")} no head assigned`);
  add(
    "department_no_head",
    "warning",
    depts.filter((d) => !d.headPersonId).map((d) => ({ id: d.id, label: deptLabel(d) })),
    (n) => `${plural(n, "department has", "departments have")} no head assigned`,
  );

  const byHead = new Map<string, string[]>();
  for (const d of depts) if (d.headPersonId) byHead.set(d.headPersonId, [...(byHead.get(d.headPersonId) ?? []), d.id]);
  const overloaded = [...byHead.entries()].filter(([, ids]) => ids.length > max);
  if (overloaded.length && !off.has("head_overloaded")) {
    const names = overloaded.map(([pid, ids]) => `${input.personNames[pid] ?? "Someone"} (${ids.length})`);
    out.push({
      rule: "head_overloaded",
      severity: "warning",
      text: `${names.join(", ")} ${overloaded.length === 1 ? "heads" : "head"} more than ${max} departments`,
      count: overloaded.length,
      items: names,
      ids: overloaded.flatMap(([, ids]) => ids),
    });
  }

  add(
    "department_no_ckp",
    "warning",
    depts.filter((d) => !d.ckp.trim()).map((d) => ({ id: d.id, label: deptLabel(d) })),
    (n) => `${plural(n, "department has", "departments have")} no ЦКП`,
  );
  add(
    "department_no_statistic",
    "warning",
    depts.filter((d) => !d.statistic.trim()).map((d) => ({ id: d.id, label: deptLabel(d) })),
    (n) => `${plural(n, "department has", "departments have")} no statistic`,
  );
  add(
    "metric_stale",
    "warning",
    depts.filter((d) => d.metric && d.metric.freshness !== "fresh").map((d) => ({ id: d.id, label: `${deptLabel(d)} · ${d.metric!.label}` })),
    (n) => `${plural(n, "department's", "departments'")} linked number is not up to date`,
  );
  add(
    "overdue_tasks",
    "warning",
    depts.filter((d) => d.overdueTasks >= overdueMin).map((d) => ({ id: d.id, label: `${deptLabel(d)} (${d.overdueTasks})` })),
    (n) => `${plural(n, "department has", "departments have")} ${overdueMin}+ overdue tasks`,
  );
  add(
    "function_no_responsible",
    "info",
    input.functions.filter((f) => !f.responsiblePersonId).map((f) => ({ id: f.id, label: f.text })),
    (n) => `${plural(n, "function has", "functions have")} no responsible person`,
  );
  return out;
}

/** Rules left out of the weekly summary line: info only, and stale numbers ("Numbers waiting" already asks for those). */
const SUMMARY_SKIP: ReadonlySet<OrgRule> = new Set(["metric_stale", "function_no_responsible", "no_chart"]);

const SHORT: Record<OrgRule, (n: number) => string> = {
  no_chart: () => "no chart",
  division_no_head: (n) => `${n} without a head (divisions)`,
  department_no_head: (n) => `${n} without a head`,
  head_overloaded: (n) => `${n} overloaded head${n === 1 ? "" : "s"}`,
  department_no_ckp: (n) => `${n} without ЦКП`,
  department_no_statistic: (n) => `${n} without a statistic`,
  metric_stale: (n) => `${n} stale number${n === 1 ? "" : "s"}`,
  overdue_tasks: (n) => `${n} with ${OVERDUE_TASKS_THRESHOLD}+ overdue tasks`,
  function_no_responsible: (n) => `${n} functions without a responsible person`,
};

/**
 * The Org Structure Expert's weekly (Monday) line in the morning summary: ONE line for all
 * companies it works for, or null when nothing needs attention. Info findings and stale
 * numbers are left out (the latter are asked for by "Numbers waiting" — one source per ask).
 */
export function orgExpertSummaryLine(
  companies: readonly { companyName: string; findings: readonly OrgFinding[] }[],
  href: string,
  cadence: "weekly" | "monthly" = "weekly",
): string | null {
  const parts: string[] = [];
  for (const c of companies) {
    const relevant = c.findings.filter((f) => f.severity === "warning" && !SUMMARY_SKIP.has(f.rule));
    if (!relevant.length) continue;
    // A tuned overdue threshold ("3+ overdue tasks") is read from the finding's own sentence.
    const shown = relevant.slice(0, 2).map((f) => (f.rule === "overdue_tasks" ? SHORT[f.rule](f.count).replace(/\d+\+/, f.text.match(/(\d+)\+/)?.[0] ?? `${OVERDUE_TASKS_THRESHOLD}+`) : SHORT[f.rule](f.count)));
    parts.push(`${c.companyName}: ${shown.join(", ")}${relevant.length > 2 ? ` +${relevant.length - 2} more` : ""}`);
  }
  if (!parts.length) return null;
  const listed = parts.slice(0, 3).join("; ") + (parts.length > 3 ? `; +${parts.length - 3} more companies` : "");
  return `Org Structure Expert (${cadence}): ${listed} — ${href}`;
}
