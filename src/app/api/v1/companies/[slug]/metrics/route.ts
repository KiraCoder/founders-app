import { NextResponse, type NextRequest } from "next/server";
import { handleApi } from "@/server/api";
import { companyIdBySlug, listCompanyMetricCards } from "@/server/services/metrics";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

/** GET /api/v1/companies/:slug/metrics — definitions with latest value, change, freshness and the last 12 periods. */
export async function GET(_req: NextRequest, { params }: Params) {
  const { slug } = await params;
  return handleApi(async (ctx) => {
    const companyId = await companyIdBySlug(ctx, slug);
    return NextResponse.json({ data: await listCompanyMetricCards(ctx, companyId) });
  });
}
