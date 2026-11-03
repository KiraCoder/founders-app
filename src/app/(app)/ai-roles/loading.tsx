import { Skeleton } from "@/components/ui";

/**
 * AI Roles page streaming loading skeleton.
 */
export default function AiRolesLoading() {
  return (
    <div className="animate-pulse space-y-6" role="status" aria-busy="true" aria-label="Loading AI roles">
      <span className="sr-only">Loading AI roles…</span>
      {/* Header */}
      <div>
        <Skeleton width={90} height={14} className="mb-2" />
        <Skeleton width={140} height={28} />
        <Skeleton width={320} height={16} className="mt-2" />
      </div>

      {/* AI Provider banner skeleton */}
      <div className="card p-4 flex items-center justify-between">
        <div className="space-y-1">
          <Skeleton width={160} height={16} />
          <Skeleton width={260} height={14} />
        </div>
        <Skeleton width={80} height={24} className="rounded-full" />
      </div>

      {/* Hired AI roles section */}
      <div className="space-y-3">
        <Skeleton width={120} height={16} />
        <div className="grid gap-3 sm:grid-cols-2">
          {[1, 2].map((i) => (
            <div key={i} className="card p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <Skeleton width={130} height={18} />
                  <Skeleton width={80} height={14} />
                </div>
                <Skeleton width={60} height={20} className="rounded-full" />
              </div>
              <Skeleton width="90%" height={14} />
              <div className="border-t border-line pt-2 flex items-center justify-between">
                <Skeleton width={110} height={14} />
                <Skeleton width={80} height={24} className="rounded-[6px]" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
