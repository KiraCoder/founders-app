import { Skeleton } from "@/components/ui";

/**
 * People directory loading skeleton.
 */
export default function PeopleLoading() {
  return (
    <div className="animate-pulse space-y-6" aria-busy="true" aria-label="Loading people">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Skeleton width={90} height={14} className="mb-2" />
          <Skeleton width={160} height={28} />
          <Skeleton width={240} height={16} className="mt-2" />
        </div>
        <div className="flex gap-2">
          <Skeleton width={110} height={36} className="rounded-[8px]" />
          <Skeleton width={110} height={36} className="rounded-[8px]" />
        </div>
      </div>

      {/* Headcount overview chips */}
      <div className="flex flex-wrap gap-2">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} width={100} height={28} className="rounded-full" />
        ))}
      </div>

      {/* People table skeleton */}
      <div className="card overflow-hidden">
        <div className="border-b border-line bg-sunk/40 px-4 py-2.5 flex items-center justify-between">
          <Skeleton width={80} height={14} />
          <Skeleton width={120} height={14} />
          <Skeleton width={100} height={14} />
        </div>
        <div className="divide-y divide-line">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton width={30} height={30} className="rounded-full shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <Skeleton width={140} height={16} />
                <Skeleton width={90} height={12} />
              </div>
              <Skeleton width={120} height={16} />
              <Skeleton width={100} height={16} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
