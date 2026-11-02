import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/server/auth";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const { next } = await searchParams;
  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-[10px] bg-accent text-[18px] font-bold text-accent-ink">F</span>
          <div>
            <p className="eyebrow">Asqa Zou group</p>
            <h1 className="text-[20px] font-semibold">Founder Cockpit</h1>
          </div>
        </div>
        <div className="card-raised p-6">
          <LoginForm next={next} />
        </div>
        <p className="mt-4 text-center text-[12px] text-muted">For Nuraaly and Talant only.</p>
      </div>
    </main>
  );
}
