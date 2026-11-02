import Link from "next/link";
import { PreferencesForm } from "@/components/settings/PreferencesForm";
import { TelegramLinkCard } from "@/components/settings/TelegramLinkCard";
import { PageHeader } from "@/components/ui";
import { getPageContext } from "@/server/context";
import { devToolsEnabled, telegramBotToken, telegramBotUsername } from "@/server/notifications/config";
import { getMyPreferences, getMyTelegramLink } from "@/server/services/notifications";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await getPageContext();
  const [prefs, link] = await Promise.all([getMyPreferences(ctx), getMyTelegramLink(ctx)]);
  const linkedAt = link
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: ctx.timeZone }).format(link.createdAt)
    : "";

  return (
    <>
      <PageHeader eyebrow={`${ctx.user.shortName} · only you see these`} title="Settings" />

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
