"use client";

import Link from "next/link";

/**
 * The app's error screen: plain English, no stack trace or error text (it can contain
 * internals), only the short reference Next.js gives a server error ("digest") so a developer
 * can find it in the logs. Used by app/error.tsx, app/(app)/error.tsx and app/global-error.tsx.
 */
export function ErrorScreen({ digest, reset }: { digest?: string; reset?: () => void }) {
  return (
    <main className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 px-4 text-center" data-testid="error-screen">
      <p className="eyebrow">Something went wrong</p>
      <h1 className="text-[20px] font-semibold">This page could not be loaded</h1>
      <p className="max-w-[420px] text-[13px] text-muted">
        Nothing you entered was lost. Try again in a moment; if it keeps happening, tell the developer
        {digest ? " and give them the reference below" : ""}.
      </p>
      <div className="flex flex-wrap justify-center gap-2">
        {reset && (
          <button type="button" className="btn btn-primary" onClick={() => reset()}>
            Try again
          </button>
        )}
        <Link href="/" className="btn">
          Back to Today
        </Link>
      </div>
      {digest && <p className="text-[12px] text-muted">Reference: {digest}</p>}
    </main>
  );
}
