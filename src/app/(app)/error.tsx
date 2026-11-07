"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

/** Errors inside a signed-in page: shown within the shell, so the sidebar stays usable. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen digest={error.digest} reset={reset} />;
}
