import { notFound } from "next/navigation";
import { EmptyState, PageHeader, Tag, type Tone } from "@/components/ui";
import { getPageContext } from "@/server/context";
import type { OutboxItem } from "@/server/db/schema";
import { devToolsEnabled, telegramBotToken } from "@/server/notifications/config";
import { actionKey, KIND_LABELS, type ActionCallbacks, type NeutralMessage, type NotificationKind } from "@/server/notifications/types";
import { canManageStaffBot } from "@/server/services/access";
import { listRecentStaffMessages } from "@/server/services/staff";
import { getMyTelegramLink, listMyNotifications } from "@/server/services/notifications";
import { runTickAction } from "./actions";

export const metadata = { title: "Dev inbox" };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<OutboxItem["status"], Tone> = {
  sent: "ok",
  pending: "info",
  parked: "warn",
  failed: "risk",
  cancelled: "neutral",
  sending: "info",
  not_linked: "warn",
};

/** `callbacks`: dev-channel staff rows keep their button data so a developer (or e2e) can "press" via the webhook. */
function Message({ m, callbacks }: { m: NeutralMessage; callbacks?: ActionCallbacks }) {
  return (
    <div className="mt-2 rounded-[8px] border border-line bg-sunk p-3 text-[13px]">
      <p className="font-semibold">{m.title}</p>
      {m.lines.map((l, i) =>
        l.style === "heading" ? (
          <p key={i} className="mt-2 font-semibold">
            {l.text}
          </p>
        ) : l.style === "item" ? (
          <p key={i} className="pl-3">
            • {l.text}
          </p>
        ) : (
          <p key={i} className={l.style === "muted" ? "italic text-muted" : ""}>
            {l.text}
          </p>
        ),
      )}
      {!!m.actions?.length && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {m.actions.map((a) => (
            <span key={actionKey(a)} className="btn btn-sm pointer-events-none" data-callback={callbacks?.[actionKey(a)]}>
              {a.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export default async function DevNotificationsPage() {
  if (!devToolsEnabled()) notFound();
  const ctx = await getPageContext();
  const [items, link] = await Promise.all([listMyNotifications(ctx), getMyTelegramLink(ctx)]);
  const team = canManageStaffBot(ctx) ? await listRecentStaffMessages(ctx, 30) : [];
  const fmt = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: ctx.timeZone,
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const route = !telegramBotToken() ? "this dev inbox" : link ? "Telegram" : "nowhere yet: they wait until you link Telegram";

  return (
    <>
      <PageHeader
        eyebrow="Developer tools · not shown in production"
        title="Dev inbox"
        actions={
          <form action={runTickAction} className="flex flex-wrap gap-2">
            <button type="submit" name="mode" value="now" className="btn btn-primary">
              Run tick now
            </button>
            <button type="submit" name="mode" value="morning" className="btn">
              Simulate morning
            </button>
            <button type="submit" name="mode" value="evening" className="btn">
              Simulate evening
            </button>
          </form>
        }
      >
        <p className="mt-1 text-[13px] text-muted">
          What {ctx.user.shortName} would have received. Only your own messages are shown. Scheduled messages go to{" "}
          <strong>{route}</strong>
          {link ? ` (Telegram linked${link.username ? ` as @${link.username}` : ""})` : " (Telegram not linked)"}. The
          buttons here run the scheduler for you only and always deliver into this inbox, never to Telegram.
        </p>
      </PageHeader>

      {items.length === 0 ? (
        <EmptyState>Nothing yet. Press “Simulate morning” to build today’s morning summary.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Notifications">
          {items.map((item) => {
            const payload = item.payload as { summaryLine?: string };
            const bundled = item.bundledIntoId ? byId.get(item.bundledIntoId) : undefined;
            return (
              <li key={item.id} className="card p-3 md:p-4">
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="text-[13px] font-semibold">{KIND_LABELS[item.kind as NotificationKind] ?? item.kind}</span>
                  <Tag tone={STATUS_TONE[item.status]}>{item.status}</Tag>
                  {item.status === "sent" && <Tag tone="info">via {item.channel}</Tag>}
                  {item.priority !== "normal" && <Tag tone={item.priority === "urgent" ? "risk" : "warn"}>{item.priority}</Tag>}
                  <span className="ml-auto text-muted">
                    {item.sentAt ? `sent ${fmt.format(item.sentAt)}` : `for ${fmt.format(item.scheduledFor)}`}
                  </span>
                </div>
                {item.message ? (
                  <Message m={item.message as NeutralMessage} />
                ) : (
                  payload.summaryLine && <p className="mt-1 text-[13px]">{payload.summaryLine}</p>
                )}
                {item.status === "sent" && bundled && (
                  <p className="mt-1 text-[12px] text-muted">Listed in the grouped overdue push (not sent on its own).</p>
                )}
                {item.status === "not_linked" && (
                  <p className="mt-1 text-[12px] text-warn">Held: Telegram is not linked yet. Sent once you link, if still valid.</p>
                )}
                {item.status === "parked" && item.lastError === "staff_line" && (
                  <p className="mt-1 text-[12px] text-muted">
                    {bundled ? "Listed in a summary." : "A line for your next summary (not sent on its own)."}
                  </p>
                )}
                {item.status === "parked" && item.lastError !== "staff_line" && (
                  <p className="mt-1 text-[12px] text-warn">
                    Daily budget was full, so this was parked
                    {bundled ? ` and listed in the ${KIND_LABELS[bundled.kind as NotificationKind]?.toLowerCase()}` : " for the next summary"}.
                  </p>
                )}
                {item.lastError && item.status !== "parked" && item.status !== "not_linked" && (
                  <p className="mt-1 text-[12px] text-muted">
                    {item.status === "pending" ? "Last error" : "Reason"}: {item.lastError}
                    {item.attempts > 0 ? ` · attempts ${item.attempts}` : ""}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <section className="mt-8" aria-labelledby="team-messages-heading">
        <h2 id="team-messages-heading" className="eyebrow mb-2">
          Team messages (staff on Telegram, in Russian)
        </h2>
        {team.length === 0 ? (
          <EmptyState>No staff messages yet. Invite someone in Settings → Team on Telegram.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Team messages">
            {team.map(({ item, name, short }) => (
              <li key={item.id} className="card p-3 md:p-4" data-testid="team-message">
                <div className="flex flex-wrap items-center gap-2 text-[12px]">
                  <span className="text-[13px] font-semibold">To {short || name}</span>
                  <span>{KIND_LABELS[item.kind as NotificationKind] ?? item.kind}</span>
                  <Tag tone={STATUS_TONE[item.status]}>{item.status}</Tag>
                  {item.status === "sent" && <Tag tone="info">via {item.channel}</Tag>}
                  <span className="ml-auto text-muted">
                    {item.sentAt ? `sent ${fmt.format(item.sentAt)}` : `for ${fmt.format(item.scheduledFor)}`}
                  </span>
                </div>
                {item.message ? (
                  <Message
                    m={item.message as NeutralMessage}
                    callbacks={item.channel === "dev" ? (item.payload as { devCallbacks?: ActionCallbacks }).devCallbacks : undefined}
                  />
                ) : null}
                {item.lastError && item.status !== "sent" && <p className="mt-1 text-[12px] text-muted">Reason: {item.lastError}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
