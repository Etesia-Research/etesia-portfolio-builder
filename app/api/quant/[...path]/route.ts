import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const TOKEN = "(?:xlm|aqua|eth|btc|shx|usdc|eurc|ustry|etesia-tf)";
const GET_PATH = new RegExp(`^(tokens|market-caps|tokens/${TOKEN}/(?:last-close|sharpe))$`);
const POST_PATH = /^(correlations|basket\/analytics|builder\/(?:targets|simulation)|quotes)$/;

const REPORT_PATH = /^vault\/backtests\/([a-f0-9]{20})\/files\/(pdf|xlsx)$/;

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const endpoint = path.join("/");
  const report = request.method === "GET" ? REPORT_PATH.exec(endpoint) : null;
  if (!report && !(request.method === "GET" ? GET_PATH : POST_PATH).test(endpoint)) {
    return NextResponse.json({ error: "Unknown quant endpoint" }, { status: 404 });
  }
  const configured = process.env.ETESIA_API_URL?.trim();
  const key = process.env.ETESIA_API_KEY;
  if (!configured || !key) {
    return NextResponse.json({ error: "Quant API is not configured" }, { status: 503 });
  }
  let body: string | undefined;
  if (request.method === "POST") {
    try {
      body = JSON.stringify(await request.json());
      if (body.length > 4096) return NextResponse.json({ error: "Request too large" }, { status: 413 });
    } catch {
      return NextResponse.json({ error: "Invalid JSON request" }, { status: 400 });
    }
  }
  try {
    const base = new URL(configured.includes("://") ? configured : `https://${configured}`);
    const response = await fetch(new URL(`/v1/${endpoint}`, base), {
      method: request.method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(35000),
    });
    if (!response.ok) {
      const error = response.status === 422 ? "The quant API does not accept this selection or amount. Check that the expanded Builder API is deployed."
        : response.status === 401 ? "Quant API authentication failed"
        : response.status === 404 ? "Quant data is unavailable"
        : "Quant service is temporarily unavailable";
      return NextResponse.json({ error }, { status: response.status === 401 ? 502 : response.status });
    }
    if (report) {
      return new NextResponse(response.body, { headers: {
        "Content-Type": report[2] === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="etesia-tf-${report[1]}.${report[2]}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      } });
    }
    return NextResponse.json(await response.json(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return NextResponse.json({ error: timeout ? "Quant request timed out" : "Could not reach the quant API" }, { status: timeout ? 504 : 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
