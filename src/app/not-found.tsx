import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-[60dvh] flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="eyebrow">404</p>
      <h1 className="text-[20px] font-semibold">Not found</h1>
      <p className="text-[13px] text-muted">It does not exist, or you do not have access to it.</p>
      <Link href="/" className="btn">
        Back to Today
      </Link>
    </main>
  );
}
