import { ASSET_CONTRACTS } from "@/lib/assets";
import type { PriceInfo } from "@/lib/prices";

export type Metric = {
  status: "available" | "unavailable";
  reason: string | null;
  stale: boolean;
  window_end: string;
  simulated: boolean;
  vault_run_id: string | null;
  sharpe_1y?: number | null;
  correlation?: number | null;
};
export type Coin = {
  id: string; tk: string; name: string; simulated: boolean; allocationSupported: boolean;
  color: string; glyph: string; mcap: number | null;
  marketCap: { basis?: string; stale?: boolean; as_of?: string; reason?: string };
  sharpe: number | null; analytics: Metric | null; analyticsError: string | null;
};
export type RouteCheck = { available: boolean; reason: string; fetchedAt: string | null };
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
      color, glyph, mcap: cap?.market_cap_usd ?? null, marketCap: cap ?? { reason: "Market cap unavailable" },
      sharpe: metric?.status === "available" ? metric.sharpe_1y : null, analytics: metric,
      analyticsError: analytics.status === "rejected" ? "Sharpe unavailable" : null };
  });
  return { coins, prices, cashReserveAssets: catalog.cash_reserve_assets ?? ["ustry"] };
}

export async function checkRoute(symbol: string, signal?: AbortSignal): Promise<RouteCheck> {
  const contract = ASSET_CONTRACTS[symbol]?.contract;
  if (!contract) return { available: false, reason: "No verified Stellar instrument", fetchedAt: null };
  if (symbol === "USDC") return { available: true, reason: "Settlement asset", fetchedAt: null };
  try {
    const buy = await quantRequest("quotes", { asset_in: ASSET_CONTRACTS.USDC.contract, asset_out: contract, amount: "10000000" }, signal);
    const sell = await quantRequest("quotes", { asset_in: contract, asset_out: ASSET_CONTRACTS.USDC.contract, amount: String(buy.quote.amountOut) }, signal);
    return { available: true, reason: "Buy/sell routes quoted at 1 USDC; execution remains simulated", fetchedAt: sell.fetched_at };
  } catch {
    return { available: false, reason: "Soroswap route unavailable; retry after refresh", fetchedAt: null };
  }
}
