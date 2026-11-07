import { NextResponse } from "next/server";
import { handleApi } from "@/server/api";
import { listCompanyCards } from "@/server/services/companies";

export const dynamic = "force-dynamic";

/** GET /api/v1/companies — companies with task/project counts. */
export async function GET() {
  return handleApi(async (ctx) => NextResponse.json({ data: await listCompanyCards(ctx) }));
}
