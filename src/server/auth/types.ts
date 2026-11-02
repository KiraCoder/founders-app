import type { Db } from "@/server/db/connect";

export type AuthMode = "local" | "supabase";

/** The signed-in user as seen by services. Never contains the password hash. */
export interface SessionUser {
  id: string;
  email: string;
  name: string;
  shortName: string;
  role: "founder" | "staff";
}

export interface SignInResult {
  user: SessionUser;
  /** Value for the session cookie. */
  token: string;
  expiresAt: Date;
}

/**
 * Pluggable authentication. `local` is implemented now; `supabase` is a stub so the
 * app can move to Supabase Auth later by setting AUTH_MODE=supabase.
 */
export interface AuthProvider {
  readonly mode: AuthMode;
  signIn(
    db: Db,
    email: string,
    password: string,
    meta?: { userAgent?: string | null },
  ): Promise<SignInResult | null>;
  getUser(db: Db, token: string | undefined): Promise<SessionUser | null>;
  signOut(db: Db, token: string | undefined): Promise<void>;
}
