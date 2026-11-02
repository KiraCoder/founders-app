import Link from "next/link";
import { PreferencesForm } from "@/components/settings/PreferencesForm";
import { SalaryAccessCard } from "@/components/settings/SalaryAccessCard";
import { TelegramLinkCard } from "@/components/settings/TelegramLinkCard";
import { PageHeader } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { devToolsEnabled, telegramBotToken, telegramBotUsername } from "@/server/notifications/config";
import { getMyPreferences, getMyTelegramLink } from "@/server/services/notifications";
import { canViewSalaries, listSalaryAccessLog, listSalaryViewers } from "@/server/services/salaries";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await getPageContext();
  const [prefs, link, viewers, isViewer] = await Promise.all([
    getMyPreferences(ctx),
    getMyTelegramLink(ctx),
    listSalaryViewers(ctx),
    canViewSalaries(ctx),
  ]);
  const log = isViewer ? await listSalaryAccessLog(ctx, 15) : [];
  const fmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: ctx.timeZone });
  const linkedAt = link
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: ctx.timeZone }).format(link.createdAt)
    : "";

  return (
    <>
      <PageHeader eyebrow={`${ctx.user.shortName} · your Telegram and notifications are private`} title="Settings" />

      <section className="card mb-5 p-4 md:p-5" aria-labelledby="tg-heading">
        <h2 id="tg-heading" className="eyebrow mb-3">
          Telegram
        </h2>
        <TelegramLinkCard
          link={link ? { username: link.username, firstName: link.firstName, linkedAt } : null}
          botUsername={telegramBotUsername()}
          botConfigured={!!telegramBotToken()}
          timeZone={ctx.timeZone}
        />
      </section>

      <section className="card mb-5 p-4 md:p-5" aria-labelledby="prefs-heading">
        <h2 id="prefs-heading" className="eyebrow mb-3">
          Notifications
        </h2>
        <PreferencesForm prefs={prefs} timeZone={ctx.timeZone} />
      </section>

      <section className="card mb-5 p-4 md:p-5" aria-labelledby="access-heading">
        <h2 id="access-heading" className="eyebrow mb-3">
          Access · salaries
        </h2>
        <SalaryAccessCard viewers={viewers} canEdit={isViewer} currentUserId={ctx.user.id} />
        {isViewer && log.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-[13px] text-muted">Salary access log (latest {log.length})</summary>
            <ul className="mt-2 space-y-1 text-[12px]">
              {log.map((l) => (
                <li key={l.id} className="flex flex-wrap gap-x-2">
                  <span className="num text-muted">{fmt.format(new Date(l.at))}</span>
                  <span className="font-medium">{l.actor ?? "?"}</span>
                  <span>{l.action.replace("_", " ")}</span>
                  <span className="text-muted">{l.personName ?? l.targetName ?? ""}</span>
                  <span className="text-muted">· {l.scope}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {devToolsEnabled() && (
        <p className="text-[13px] text-muted">
          Developer tools:{" "}
          <Link href="/dev/notifications" className="text-accent hover:underline">
            see what you would have received
          </Link>
          .
        </p>
      )}
    </>
  );
}
