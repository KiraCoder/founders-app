import { Skeleton } from "@/components/ui";

/**
 * Holding page streaming loading skeleton.
 */
export default function HoldingLoading() {
  return (
    <div className="animate-pulse space-y-6" role="status" aria-busy="true" aria-label="Loading holding">
      <span className="sr-only">Loading holding…</span>
      {/* Header */}
      <div>
        <Skeleton width={80} height={14} className="mb-2" />
        <Skeleton width={140} height={28} />
        <Skeleton width={320} height={16} className="mt-2" />
      </div>

      {/* 3 Stats cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="card p-4 space-y-1.5">
            <Skeleton width={90} height={12} />
            <Skeleton width={60} height={26} />
            <Skeleton width="80%" height={14} />
          </div>
        ))}
      </div>

      {/* Ask for акты section skeleton */}
      <div className="space-y-2">
        <Skeleton width={110} height={16} />
        <div className="card p-4 space-y-3">
          <Skeleton width="70%" height={16} />
          <Skeleton height={60} className="w-full rounded-[8px]" />
        </div>
      </div>

      {/* Acts grid skeleton */}
      <div className="space-y-2">
        <Skeleton width={130} height={16} />
        <div className="card p-4">
          <Skeleton height={140} className="w-full rounded-[8px]" />
        </div>
      </div>
    </div>
  );
}
