"use client";

import "./globals.css";
import { ErrorScreen } from "@/components/ErrorScreen";

/** Last resort: the root layout itself failed. Renders its own <html> and <body>. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <head>
        <title>Something went wrong · Founder Cockpit</title>
      </head>
      <body className="min-h-dvh text-[14px] leading-5">
        <ErrorScreen digest={error.digest} reset={reset} />
      </body>
    </html>
  );
}
