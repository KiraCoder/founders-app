"use client";

import { createContext, useContext, type ReactNode } from "react";

/** Whether document uploads work on this deployment (see fileUploadStatus on the server). */
export interface UploadsState {
  available: boolean;
  message?: string;
}

const UploadsContext = createContext<UploadsState>({ available: true });

export function UploadsProvider({ value, children }: { value: UploadsState; children: ReactNode }) {
  return <UploadsContext.Provider value={value}>{children}</UploadsContext.Provider>;
}

export function useUploads(): UploadsState {
  return useContext(UploadsContext);
}

/** Shown instead of the file field when uploads are off ("File uploads arrive with Supabase storage"). */
export function UploadsUnavailableNote({ message }: { message?: string }) {
  return (
    <p className="text-[12px] text-muted" data-testid="uploads-unavailable">
      {message ?? "File uploads arrive with Supabase storage"}
    </p>
  );
}
