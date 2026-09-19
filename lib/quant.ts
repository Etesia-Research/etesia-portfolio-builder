import type { PriceInfo } from "@/lib/prices";

export type Metric = {
  status: "available" | "unavailable";
  reason: string | null;
  stale: boolean;
  window_start: string;
  window_end: string;
  simulated: boolean;
  vault_run_id: string | null;
  sharpe_annualized?: number | null;
  correlation?: number | null;
};
export type Coin = {
  id: string; tk: string; name: string; simulated: boolean; allocationSupported: boolean;
  color: string; glyph: string; logo: string | null; mcap: number | null;
  marketCap: { basis?: string; stale?: boolean; as_of?: string; reason?: string };
  sharpe: number | null; analytics: Metric | null; analyticsError: string | null;
};
export type Allocation = {
  status: "valid" | "blocked";
  model_version: string; generated_at: string; market_data_as_of: string;
  portfolio_value_usdc: number; allocated_sleeve_volatility: number | null;
  positions: Record<string, { quantity: number; mark_usdc: number | null; notional_usdc: number; allocation_fraction: number }> | null;
  binding_constraints: string[]; diagnostics: string[];
};

export async function quantRequest(path: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(`/api/quant/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store", signal,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Quant request failed (${response.status})`);
  return result;
}

const palette: Record<string, [string, string]> = {
  XLM: ["#1d1a14", "✦"], AQUA: ["#1f8fc0", "≈"], ETH: ["#5b6470", "♦"], BTC: ["#b8761a", "₿"],
  SHX: ["#874422", "S"], USDC: ["#0a3b66", "$"], EURC: ["#244a80", "€"], USTRY: ["#1f5e4a", "U"], "ETESIA-TF": ["#b14820", "E"],
};

export async function fetchUniverse(signal?: AbortSignal) {
  const catalog = await quantRequest("tokens", undefined, signal);
  const [caps, details] = await Promise.all([
    quantRequest("market-caps", undefined, signal).catch(() => null),
    Promise.all(catalog.tokens.map(async (token: { id: string; symbol: string; name: string; simulated: boolean; allocation_supported?: boolean }) => {
      const [close, analytics] = await Promise.allSettled([
        quantRequest(`tokens/${token.id}/last-close`, undefined, signal),
        quantRequest(`tokens/${token.id}/sharpe`, undefined, signal),
      ]);
      return { token, close, analytics };
    })),
  ]);
  const prices: Record<string, PriceInfo> = {};
  const coins: Coin[] = details.map(({ token, close, analytics }) => {
    const price = close.status === "fulfilled" ? close.value : null;
    prices[token.symbol] = { price: price?.price_usd ?? null, ts: price?.as_of ?? null, stale: price?.stale ?? true,
      reason: price?.reason ?? (close.status === "rejected" ? "Daily close unavailable" : null) };
    const metric = analytics.status === "fulfilled" ? analytics.value : null;
    const cap = caps?.market_caps.find((c: { token: string }) => c.token === token.id);
    const [color, glyph] = palette[token.symbol] ?? ["#5b6470", token.symbol[0]];
    return { id: token.id, tk: token.symbol, name: token.name, simulated: token.simulated,
      allocationSupported: token.allocation_supported ?? ["xlm", "aqua", "eth", "btc"].includes(token.id),
      color, glyph, logo: ({ xlm: "/logos/xlm.svg", aqua: "/logos/aqua.png", eth: "/logos/eth.svg", btc: "/logos/btc.png", shx: "/logos/shx.png", usdc: "/logos/usdc.svg", eurc: "/logos/eurc.svg", ustry: "/logos/ustry.png", "etesia-tf": "/logos/etesia.svg" } as Record<string, string>)[token.id] ?? null, mcap: cap?.market_cap_usd ?? null, marketCap: cap ?? { reason: "Market cap unavailable" },
      sharpe: metric?.status === "available" ? metric.sharpe_annualized : null, analytics: metric,
      analyticsError: analytics.status === "rejected" ? "Sharpe unavailable" : null };
  });
  return { coins, prices, cashReserveAssets: catalog.cash_reserve_assets ?? ["ustry"] };
}

export function simulationWeights(positions: Allocation["positions"]): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const [id, position] of Object.entries(positions ?? {})) {
    if (position.allocation_fraction <= 0) continue;
    const token = id.replace(/_(?:buffer|reserve)$/, "");
    weights[token] = (weights[token] ?? 0) + position.allocation_fraction;
  }
  return weights;
}
