import Link from "next/link";
import { DataSources } from "@/components/metrics/DataSources";
import { PreferencesForm } from "@/components/settings/PreferencesForm";
import { SalaryAccessCard } from "@/components/settings/SalaryAccessCard";
import { ReminderClockCard } from "@/components/settings/ReminderClockCard";
import { TelegramBotSetupCard } from "@/components/settings/TelegramBotSetupCard";
import { TelegramLinkCard } from "@/components/settings/TelegramLinkCard";
import { PageHeader } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { devToolsEnabled, telegramBotToken, telegramBotUsername } from "@/server/notifications/config";
import { canSetUpApp, getReminderClockConfig, getTelegramSetupConfig } from "@/server/services/app-setup";
import { listConnectorStatuses } from "@/server/services/connectors";
import { getMyPreferences, getMyTelegramLink } from "@/server/services/notifications";
import { canViewSalaries, listSalaryAccessLog, listSalaryViewers } from "@/server/services/salaries";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await getPageContext();
  const [prefs, link, viewers, isViewer, sources] = await Promise.all([
    getMyPreferences(ctx),
    getMyTelegramLink(ctx),
    listSalaryViewers(ctx),
    canViewSalaries(ctx),
    listConnectorStatuses(ctx),
  ]);
  const log = isViewer ? await listSalaryAccessLog(ctx, 15) : [];
  const founder = canSetUpApp(ctx);
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

      {founder && (
        <section className="card mb-5 p-4 md:p-5" aria-labelledby="tg-setup-heading">
          <h2 id="tg-setup-heading" className="eyebrow mb-3">
            Telegram bot · setup
          </h2>
          <TelegramBotSetupCard config={getTelegramSetupConfig(ctx)} timeZone={ctx.timeZone} />
        </section>
      )}

      {founder && (
        <section className="card mb-5 p-4 md:p-5" aria-labelledby="clock-heading">
          <h2 id="clock-heading" className="eyebrow mb-3">
            Reminder clock · setup
          </h2>
          <ReminderClockCard config={getReminderClockConfig(ctx)} timeZone={ctx.timeZone} />
        </section>
      )}

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

      <section className="card mb-5 p-4 md:p-5" aria-labelledby="sources-heading">
        <h2 id="sources-heading" className="eyebrow mb-1">
          Data sources
        </h2>
        <p className="mb-2 text-[12px] text-muted">
          Numbers are pulled automatically once a source is connected. Until then, enter or upload them on each company page.
          Keys are added only as environment variables in Vercel (see README), never here.
        </p>
        <DataSources sources={sources} timeZone={ctx.timeZone} showCompany />
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
