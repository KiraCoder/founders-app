import { Skeleton } from "@/components/ui";

/**
 * Org board streaming loading skeleton.
 */
export default function OrgLoading() {
  return (
    <div className="animate-pulse space-y-6" role="status" aria-busy="true" aria-label="Loading org structure">
      <span className="sr-only">Loading org structure…</span>
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Skeleton width={110} height={14} className="mb-2" />
          <Skeleton width={180} height={28} />
          <Skeleton width={280} height={16} className="mt-2" />
        </div>
        <div className="flex gap-2">
          <Skeleton width={130} height={36} className="rounded-[8px]" />
          <Skeleton width={90} height={36} className="rounded-[8px]" />
        </div>
      </div>

      {/* Org board grid columns skeleton */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3 xl:grid-cols-7 overflow-x-auto pb-4">
        {[1, 2, 3, 4, 5, 6, 7].map((div) => (
          <div key={div} className="card p-3 space-y-3 min-w-[200px]">
            <div className="border-b border-line pb-2 space-y-1">
              <Skeleton width={60} height={12} />
              <Skeleton width="90%" height={16} />
            </div>
            {[1, 2, 3].map((dept) => (
              <div key={dept} className="rounded-[8px] bg-sunk/60 p-2 space-y-1.5">
                <Skeleton width="80%" height={14} />
                <Skeleton width="50%" height={12} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
