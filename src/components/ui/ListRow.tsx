/**
 * ListRow — one row of a control-center list (Tasks and Routines look the same):
 *
 *   Title  [Status] [badges…]                          [aside tag]  ▷ ✎ ⏸ 🗄 💬 ↗
 *   who · company · schedule / project · next …
 *   (below: e.g. the task's activity line)
 *
 * Plain markup (server and client components). `meta` items are joined with "·"; empty ones are
 * skipped. Extra attributes (data-testid, data-task-id) go on the <li>.
 */
import { Fragment, type ReactNode } from "react";

export function ListRow({
  title,
  badges,
  meta = [],
  below,
  aside,
  actions,
  ...attrs
}: {
  title: ReactNode;
  badges?: ReactNode;
  meta?: ReactNode[];
  below?: ReactNode;
  aside?: ReactNode;
  actions?: ReactNode;
} & Record<`data-${string}`, string>) {
  const shown = meta.filter((m) => m !== null && m !== undefined && m !== false && m !== "");
  return (
    <li className="flex flex-col gap-2 px-4 py-3 text-[13px] md:flex-row md:items-center" {...attrs}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {title}
          {badges}
        </div>
        {shown.length > 0 && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted">
            {shown.map((m, i) => (
              <Fragment key={i}>
                {i > 0 && <span aria-hidden>·</span>}
                {m}
              </Fragment>
            ))}
          </div>
        )}
        {below}
      </div>
      {(aside || actions) && (
        <div className="flex flex-wrap items-center gap-2 md:justify-end">
          {aside}
          {actions}
        </div>
      )}
    </li>
  );
}

/** The title link of a row (same weight on every list). */
export const ROW_TITLE = "font-semibold hover:underline";
