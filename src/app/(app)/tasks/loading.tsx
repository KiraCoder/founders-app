import { Skeleton } from "@/components/ui";

/**
 * Tasks page loading skeleton.
 */
export default function TasksLoading() {
  return (
    <div className="animate-pulse space-y-5" role="status" aria-busy="true" aria-label="Loading tasks">
      <span className="sr-only">Loading tasks…</span>
      {/* Header */}
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Skeleton width={80} height={14} className="mb-2" />
          <Skeleton width={180} height={28} />
        </div>
        <Skeleton width={110} height={36} className="rounded-[8px]" />
      </div>

      {/* Tabs */}
      <div className="flex gap-4 border-b border-line pb-2">
        <Skeleton width={90} height={24} />
        <Skeleton width={120} height={24} />
        <Skeleton width={140} height={24} />
        <Skeleton width={80} height={24} />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Skeleton width={140} height={32} className="rounded-[8px]" />
        <Skeleton width={110} height={32} className="rounded-[8px]" />
        <Skeleton width={110} height={32} className="rounded-[8px]" />
      </div>

      {/* Task rows card */}
      <div className="card divide-y divide-line">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="flex items-center gap-3 p-3.5">
            <Skeleton width={18} height={18} className="rounded-[5px] shrink-0" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton width="60%" height={16} />
              <div className="flex items-center gap-2">
                <Skeleton width={80} height={14} className="rounded-full" />
                <Skeleton width={90} height={14} />
              </div>
            </div>
            <Skeleton width={60} height={26} className="rounded-[6px] shrink-0" />
          </div>
        ))}
      </div>
    </div>
  );
}
