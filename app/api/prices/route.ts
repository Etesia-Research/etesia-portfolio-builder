import { NextResponse } from "next/server";
import { ASSET_CONTRACTS } from "@/lib/prices";

// Server-side proxy for the Soroswap price API. Keeps SOROSWAP_API_KEY off the
// client and is the only server piece (one service). Returns raw Soroswap USD
// prices per ticker; the client applies the reliability guard (lib/prices.ts).
//
// doc-checked: Soroswap API 1.0 — GET /price?network=mainnet&asset=<c>&referenceCurrency=USD
// Bearer auth; response: [{ asset, price, timestamp }]

export const dynamic = "force-dynamic"; // never cache; prices must be fresh

const SOROSWAP_API = "https://api.soroswap.finance";

export async function GET() {
  const key = process.env.SOROSWAP_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "SOROSWAP_API_KEY not configured" },
      { status: 503 }
    );
  }

  const entries = Object.entries(ASSET_CONTRACTS);
  const params = new URLSearchParams();
  params.set("network", "mainnet");
  params.set("referenceCurrency", "USD");
  for (const [, a] of entries) params.append("asset", a.contract);

  try {
    const res = await fetch(`${SOROSWAP_API}/price?${params.toString()}`, {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `soroswap responded ${res.status}` },
        { status: 502 }
      );
    }
    const rows = (await res.json()) as Array<{
      asset: string;
      price: number | null;
      timestamp: string | null;
    }>;
    const byContract = new Map(rows.map((r) => [r.asset, r]));

    const prices: Record<string, { price: number | null; ts: string | null }> = {};
    for (const [tk, a] of entries) {
      const r = byContract.get(a.contract);
      prices[tk] = {
        price: r && typeof r.price === "number" ? r.price : null,
        ts: r?.timestamp ?? null,
      };
    }
    return NextResponse.json({ prices, fetchedAt: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "price fetch failed" },
      { status: 502 }
    );
  }
}
