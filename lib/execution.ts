import { ASSET_CONTRACTS } from "@/lib/assets";
import { quantRequest, type Allocation } from "@/lib/quant";

const SCALE = BigInt(10000000);
export function atomicAmount(value: string): bigint {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) throw new Error("Invalid funding amount");
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole || "0") * SCALE + BigInt((fraction + "0000000").slice(0, 7));
  if (amount <= BigInt(0)) throw new Error("Amount is below one atomic unit");
  return amount;
}
export function tokenUnits(amount: string | bigint): string {
  const value = BigInt(amount);
  return `${value / SCALE}.${(value % SCALE).toString().padStart(7, "0")}`;
}

export async function executionQuotes(allocation: Allocation, funding: { symbol: string; amount: string }, usdcUsd: number, signal?: AbortSignal) {
  if (!Number.isFinite(usdcUsd) || usdcUsd <= 0) throw new Error("USDC/USD reference unavailable");
  const swap = async (from: string, to: string, amount: bigint) => {
    const assetIn = ASSET_CONTRACTS[from]?.contract, assetOut = ASSET_CONTRACTS[to]?.contract;
    if (!assetIn || !assetOut) throw new Error("No verified Stellar instrument");
    const result = await quantRequest("quotes", { asset_in: assetIn, asset_out: assetOut, amount: String(amount) }, signal);
    const q = result.quote;
    if (q.assetIn !== assetIn || q.assetOut !== assetOut || q.amountIn !== String(amount) || !/^[1-9]\d*$/.test(q.amountOut) || !Number.isFinite(Date.parse(result.fetched_at))) {
      throw new Error("Quote does not match the simulated trade");
    }
    return { amountIn: String(amount), amountOut: q.amountOut as string,
      minimumOut: String(q.otherAmountThreshold ?? q.amountOutMin ?? BigInt(q.amountOut) * BigInt(9950) / BigInt(10000)), fetchedAt: result.fetched_at as string };
  };
  const input = atomicAmount(funding.amount);
  const fundingQuote = funding.symbol === "USDC" ? null : await swap(funding.symbol, "USDC", input);
  const capital = fundingQuote ? BigInt(fundingQuote.amountOut) : input;
  const positions = Object.entries(allocation.positions ?? {}).filter(([, p]) => p.allocation_fraction > 0);
  // Integer budgets conserve the quoted capital; rounding dust stays in the USDC buffer.
  const budgets = positions.map(([, p]) => capital * BigInt(Math.floor(p.allocation_fraction * 1e12)) / BigInt(1000000000000));
  const cashIndex = positions.findIndex(([id]) => id === "usdc");
  if (cashIndex < 0) throw new Error("Allocation is missing its USDC buffer");
  budgets[cashIndex] += capital - budgets.reduce((sum, value) => sum + value, BigInt(0));
  const rows = await Promise.all(positions.map(async ([id], index) => {
    const symbol = id.replace(/_(?:buffer|reserve)$/, "").toUpperCase();
    const budget = budgets[index];
    const base = { id, symbol, amountIn: String(budget) };
    if (symbol === "ETESIA-TF") return { ...base, kind: "vault", amountOut: String(budget * BigInt(Math.round(usdcUsd * 1e12)) / BigInt(1000000000000)), minimumOut: null, fetchedAt: null, error: null };
    if (symbol === "USDC") return { ...base, kind: "cash", amountOut: String(budget), minimumOut: null, fetchedAt: null, error: null };
    try {
      if (budget <= BigInt(0)) throw new Error("Trade amount is below one atomic unit");
      return { ...base, kind: "swap", ...await swap("USDC", symbol, budget), error: null };
    } catch (error) {
      return { ...base, kind: "swap", amountOut: null, minimumOut: null, fetchedAt: null, error: error instanceof Error ? error.message : "Quote unavailable" };
    }
  }));
  const fetched = [fundingQuote?.fetchedAt, ...rows.map(row => row.fetchedAt)].filter((stamp): stamp is string => !!stamp);
  return { funding: fundingQuote, capital: String(capital), rows,
    expiresAt: Math.min(Date.now(), ...fetched.map(stamp => new Date(stamp).getTime())) + 60000 };
}
