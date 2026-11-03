import { Skeleton } from "@/components/ui";

/**
 * Global App shell loading skeleton.
 * Displayed automatically by Next.js streaming while server components fetch data.
 */
export default function AppLoading() {
  return (
    <div className="animate-pulse space-y-6" aria-busy="true" aria-label="Loading page">
      {/* Page Header skeleton */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Skeleton width={140} height={14} className="mb-2" />
          <Skeleton width={260} height={28} />
          <Skeleton width={180} height={16} className="mt-2" />
        </div>
        <Skeleton width={90} height={36} className="rounded-[8px]" />
      </div>

      {/* Action / Search skeleton */}
      <Skeleton height={44} className="w-full rounded-[10px]" />

      {/* Two-column layout matching Today page */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Skeleton width={100} height={16} />
              <Skeleton width={28} height={20} className="rounded-full" />
            </div>
            <Skeleton height={48} className="w-full rounded-[8px]" />
            <Skeleton height={48} className="w-full rounded-[8px]" />
            <Skeleton height={48} className="w-full rounded-[8px]" />
          </div>

          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Skeleton width={110} height={16} />
              <Skeleton width={28} height={20} className="rounded-full" />
            </div>
            <Skeleton height={48} className="w-full rounded-[8px]" />
            <Skeleton height={48} className="w-full rounded-[8px]" />
          </div>
        </div>

        <div className="space-y-6">
          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Skeleton width={120} height={16} />
              <Skeleton width={28} height={20} className="rounded-full" />
            </div>
            <Skeleton height={48} className="w-full rounded-[8px]" />
            <Skeleton height={48} className="w-full rounded-[8px]" />
          </div>

          <div className="card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Skeleton width={130} height={16} />
              <Skeleton width={28} height={20} className="rounded-full" />
            </div>
            <Skeleton height={60} className="w-full rounded-[8px]" />
          </div>
        </div>
      </div>
    </div>
  );
}
