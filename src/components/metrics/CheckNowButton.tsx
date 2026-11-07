"use client";

import { useState, useTransition } from "react";
import { checkConnectorAction } from "@/app/(app)/companies/actions";

export function CheckNowButton({ connectorId }: { connectorId: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className="btn btn-sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await checkConnectorAction(connectorId);
            setMsg(r.error ?? r.message ?? null);
          })
        }
      >
        {pending ? "Checking…" : "Check now"}
      </button>
      {msg && <span role="status">{msg}</span>}
    </>
  );
}
