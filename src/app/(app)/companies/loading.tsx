import { Skeleton } from "@/components/ui";

/**
 * Companies catalog page loading skeleton.
 */
export default function CompaniesLoading() {
  return (
    <div className="animate-pulse space-y-5" aria-busy="true" aria-label="Loading companies">
      {/* Header */}
      <div className="mb-5">
        <Skeleton width={110} height={14} className="mb-2" />
        <Skeleton width={160} height={28} />
      </div>

      {/* Grid of company cards */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="card flex flex-col gap-3 p-4">
            <div className="flex items-start gap-2.5">
              <Skeleton width={10} height={10} className="rounded-full mt-1.5" />
              <div className="min-w-0 flex-1 space-y-1">
                <Skeleton width={120} height={18} />
                <Skeleton width={80} height={14} />
              </div>
              <Skeleton width={60} height={20} className="rounded-full" />
            </div>
            <Skeleton width="90%" height={14} />
            <div className="mt-auto grid grid-cols-3 gap-2 border-t border-line pt-3">
              <div>
                <Skeleton width={40} height={11} className="mb-1" />
                <Skeleton width={24} height={20} />
              </div>
              <div>
                <Skeleton width={40} height={11} className="mb-1" />
                <Skeleton width={24} height={20} />
              </div>
              <div>
                <Skeleton width={40} height={11} className="mb-1" />
                <Skeleton width={24} height={20} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
