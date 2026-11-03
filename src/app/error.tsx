"use client";

import { ErrorScreen } from "@/components/ErrorScreen";

/** Errors in any page or layout below the root (incl. the signed-in shell). */
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorScreen digest={error.digest} reset={reset} />;
}
