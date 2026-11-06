import Link from "next/link";
import { notFound } from "next/navigation";
import {
  saveStaffDefaultsAction,
  setPersonBotAction,
  setPersonChaseAction,
  setPersonPauseAction,
  unlinkPersonAction,
} from "@/app/(app)/staff-actions";
import { ActionForm } from "@/components/staff/ActionForm";
import { InvitePicker } from "@/components/staff/InviteToTelegram";
import { PageHeader, Tag, type Tone } from "@/components/ui";
import { todayInTimeZone } from "@/lib/dates";
import type { StaffSettings } from "@/lib/staff-schemas";
import type { OutboxItem } from "@/server/db/schema";
import { getPageContext } from "@/server/context";
import { KIND_LABELS, type NeutralMessage, type NotificationKind } from "@/server/notifications/types";
import { canManageStaffBot } from "@/server/services/access";
import { listPeople } from "@/server/services/people";
import { getStaffDefaults, listPersonMessages, listTeamOnTelegram, type TeamMember } from "@/server/services/staff";

export const metadata = { title: "Team on Telegram" };
export const dynamic = "force-dynamic";

const STATE: Record<TeamMember["state"], { label: string; tone: Tone }> = {
  not_linked: { label: "Not linked", tone: "neutral" },
  invited: { label: "Invited", tone: "warn" },
  linked: { label: "Linked", tone: "ok" },
  stopped: { label: "Stopped the bot", tone: "risk" },
};

const STATUS_TONE: Record<OutboxItem["status"], Tone> = {
  sent: "ok",
  pending: "info",
  parked: "warn",
  failed: "risk",
  cancelled: "neutral",
  sending: "info",
  not_linked: "warn",
};

/** Inputs for the chase settings: `defaults` fills the placeholders, `values` the fields. */
function SettingsFields({ values, defaults, required }: { values: Partial<StaffSettings>; defaults: StaffSettings; required: boolean }) {
  const time = (name: keyof StaffSettings, label: string) => (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <input
        type="time"
        name={name}
        className="input"
        required={required}
        defaultValue={(values[name] as string | undefined) ?? ""}
        aria-label={label}
      />
      {!required && <span className="text-[11px] text-muted">default {String(defaults[name] ?? "off")}</span>}
    </label>
  );
  const num = (name: keyof StaffSettings, label: string, min: number, max: number) => (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <input
        type="number"
        name={name}
        min={min}
        max={max}
        className="input"
        required={required}
        defaultValue={values[name] === undefined ? "" : String(values[name])}
        placeholder={String(defaults[name])}
        aria-label={label}
      />
    </label>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {time("quietStart", "Quiet from")}
      {time("quietEnd", "Quiet until")}
      {time("workStart", "Chase from")}
      {time("workEnd", "Chase until")}
      {num("chaseEveryMinutes", "Chase every (min)", 15, 1440)}
      {num("maxPerDay", "Max messages / day", 1, 50)}
      {num("escalateAfterChases", "Tell founder after N unanswered (0 = never)", 0, 50)}
      <label className="flex flex-col gap-1">
        <span className="label">Tell founder if still open at</span>
        <input
          type="time"
          name="escalateAt"
          className="input"
          defaultValue={values.escalateAt ?? ""}
          aria-label="Tell founder if still open at"
        />
        <span className="text-[11px] text-muted">{required ? "empty = off" : `default ${defaults.escalateAt ?? "off"}`}</span>
      </label>
      {required ? (
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" name="morningList" defaultChecked={values.morningList} /> Morning list of their tasks
        </label>
      ) : (
        <label className="flex flex-col gap-1">
          <span className="label">Morning list</span>
          <select name="morningList" className="input" defaultValue={values.morningList === undefined ? "" : values.morningList ? "on" : "false"}>
            <option value="">Default ({defaults.morningList ? "on" : "off"})</option>
            <option value="on">On</option>
            <option value="false">Off</option>
          </select>
        </label>
      )}
      {time("morningListTime", "Morning list at")}
    </div>
  );
}

function MessageLog({ items, timeZone }: { items: OutboxItem[]; timeZone: string }) {
  const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone });
  if (!items.length) return <p className="text-[12px] text-muted">Nothing sent yet.</p>;
  return (
    <ul className="space-y-1.5 text-[12px]" aria-label="Messages sent">
      {items.map((i) => (
        <li key={i.id} className="flex flex-wrap items-baseline gap-x-2">
          <span className="num text-muted">{fmt.format(i.sentAt ?? i.scheduledFor)}</span>
          <Tag tone={STATUS_TONE[i.status]}>{i.status}</Tag>
          <span className="font-medium">{KIND_LABELS[i.kind as NotificationKind] ?? i.kind}</span>
          <span>{(i.message as NeutralMessage | null)?.title ?? ""}</span>
          {i.status !== "sent" && i.lastError && <span className="text-muted">({i.lastError})</span>}
        </li>
      ))}
    </ul>
  );
}

export default async function TeamTelegramPage() {
  const ctx = await getPageContext();
  if (!canManageStaffBot(ctx)) notFound();
  const [defaults, team, everyone] = await Promise.all([getStaffDefaults(ctx), listTeamOnTelegram(ctx), listPeople(ctx, { status: "active" })]);
  const logs = await Promise.all(team.map((m) => listPersonMessages(ctx, m.id, 10)));
  const today = todayInTimeZone(ctx.now, ctx.timeZone);
  const fmtDay = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: ctx.timeZone });
  const invitable = everyone.filter((p) => !p.isUser && !p.leftAt).map((p) => ({ id: p.id, name: p.shortName || p.fullName }));

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/settings" className="hover:underline">
            Settings
          </Link>
        }
        title="Team on Telegram"
      >
        <p className="mt-1 max-w-[760px] text-[13px] text-muted">
          The bot messages a person (in Russian) only when they opened your invite link themselves <em>and</em> you switch on
          “Bot may message”. They get new tasks, reminders on the due day and after (until done), and can answer with buttons
          or text. /stop always works. Times are {ctx.timeZone}.
        </p>
      </PageHeader>

      <section className="card mb-5 p-4 md:p-5" aria-labelledby="staff-defaults-heading">
        <h2 id="staff-defaults-heading" className="eyebrow mb-1">
          Defaults for everyone
        </h2>
        <p className="mb-3 text-[12px] text-muted">
          Staff are chased persistently on purpose (one reminder per task per slot while working hours last, on the due day and
          after), never in quiet hours, at most the daily maximum. Each person and each task can override these.
        </p>
        <ActionForm action={saveStaffDefaultsAction} label="Staff defaults" className="flex flex-col gap-3">
          <SettingsFields values={defaults} defaults={defaults} required />
          <div>
            <button type="submit" className="btn btn-primary">
              Save defaults
            </button>
          </div>
        </ActionForm>
      </section>

      <section className="card mb-5 p-4 md:p-5" aria-labelledby="staff-invite-heading">
        <h2 id="staff-invite-heading" className="eyebrow mb-3">
          Invite
        </h2>
        <InvitePicker people={invitable} />
      </section>

      <section aria-labelledby="staff-team-heading">
        <h2 id="staff-team-heading" className="eyebrow mb-2">
          People ({team.length})
        </h2>
        {team.length === 0 && <div className="card px-4 py-6 text-center text-[13px] text-muted">Nobody invited yet.</div>}
        <ul className="flex flex-col gap-3">
          {team.map((m, i) => (
            <li key={m.id} className="card p-4" data-testid="team-member" aria-label={m.name}>
              <div className="flex flex-wrap items-center gap-2">
                <Link href={`/people/${m.id}`} className="text-[15px] font-semibold hover:underline">
                  {m.name}
                </Link>
                <Tag tone={STATE[m.state].tone}>{STATE[m.state].label}</Tag>
                {m.link?.username && <span className="text-[12px] text-muted">@{m.link.username}</span>}
                {m.state === "invited" && m.inviteExpiresAt && (
                  <span className="text-[12px] text-muted">invite valid until {new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: ctx.timeZone }).format(m.inviteExpiresAt)}</span>
                )}
                {m.reachable ? <Tag tone="ok">Bot messages them</Tag> : <Tag>Bot sends nothing</Tag>}
                {m.paused && m.pausedUntil && <Tag tone="warn">Paused until {fmtDay.format(new Date(m.pausedUntil.getTime() - 1))}</Tag>}
              </div>

              <div className="mt-3 flex flex-wrap items-start gap-4">
                <ActionForm action={setPersonBotAction} label={`Bot switch for ${m.name}`} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="personId" value={m.id} />
                  <input type="hidden" name="enabled" value={m.botEnabled ? "0" : "1"} />
                  <span className="text-[13px]">
                    Bot may message: <strong>{m.botEnabled ? "on" : "off"}</strong>
                  </span>
                  <button type="submit" className={`btn btn-sm ${m.botEnabled ? "" : "btn-primary"}`}>
                    {m.botEnabled ? "Switch off" : "Switch on"}
                  </button>
                </ActionForm>

                <ActionForm action={setPersonPauseAction} label={`Pause ${m.name}`} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="personId" value={m.id} />
                  <label className="flex flex-col gap-1">
                    <span className="label">Pause until (incl.)</span>
                    <input type="date" name="until" min={today} className="input h-[30px] w-[160px]" aria-label={`Pause ${m.name} until`} />
                  </label>
                  <button type="submit" className="btn btn-sm">
                    Pause
                  </button>
                  {m.paused && (
                    <button type="submit" name="resume" value="1" className="btn btn-sm">
                      Resume now
                    </button>
                  )}
                </ActionForm>

                {(m.state === "linked" || m.state === "stopped") && (
                  <ActionForm action={unlinkPersonAction} label={`Unlink ${m.name}`} className="ml-auto">
                    <input type="hidden" name="personId" value={m.id} />
                    <button type="submit" className="btn btn-ghost btn-sm text-risk">
                      Unlink
                    </button>
                  </ActionForm>
                )}
              </div>

              <details className="mt-3">
                <summary className="cursor-pointer text-[13px] text-muted">
                  Chase settings for {m.name} {Object.keys(m.override).length ? `(${Object.keys(m.override).length} changed)` : "(defaults)"}
                </summary>
                <ActionForm action={setPersonChaseAction} label={`Chase settings for ${m.name}`} className="mt-2 flex flex-col gap-3">
                  <input type="hidden" name="personId" value={m.id} />
                  <p className="text-[12px] text-muted">Empty = the default.</p>
                  <SettingsFields values={m.override} defaults={defaults} required={false} />
                  <div className="flex gap-2">
                    <button type="submit" className="btn btn-sm btn-primary">
                      Save for {m.name}
                    </button>
                    <button type="submit" name="clear" value="1" className="btn btn-sm">
                      Back to defaults
                    </button>
                  </div>
                </ActionForm>
              </details>

              <details className="mt-2">
                <summary className="cursor-pointer text-[13px] text-muted">Last messages ({logs[i]!.length})</summary>
                <div className="mt-2">
                  <MessageLog items={logs[i]!} timeZone={ctx.timeZone} />
                </div>
              </details>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
