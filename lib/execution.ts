import { ASSET_CONTRACTS } from "@/lib/assets";
import type { VaultNetworkConfig } from "@/lib/network";
import { quantRequest, type Allocation } from "@/lib/quant";
import { VAULTS } from "@/lib/vaults";

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

// ---------- Testnet execution plan ----------
// On a vault network (testnet mode) every leg of an allocation is a real
// transaction: a USDC swap on the manifest's Soroswap router per market asset,
// the vault's deposit_bounded, and the USDC kept in the wallet.

const baseId = (id: string) => id.replace(/_(?:buffer|reserve)$/, "");

// A position can be held on this network when it is USDC, has a market of the
// same asset in the manifest (net.markets), or is a vault deployed here.
export function testnetSelectable(id: string, net: VaultNetworkConfig): boolean {
  const base = baseId(id);
  return base === "usdc" || base in net.markets || VAULTS.some((v) => v.coin === base && Object.values(v.networks).some((d) => d?.vault === net.vault));
}

export type Leg = {
  key: string; // stable within an allocation, for the pending-hash record
  kind: "funding" | "trustline" | "swap" | "vault";
  symbol: string; // asset received (trustline: asset trusted; vault: the vault product)
  ids: string[]; // allocation positions served by the leg
  amountIn: bigint; // input units (XLM for funding, USDC otherwise; 0 for a trustline)
  path: string[]; // router path for funding and swaps
  minOut: bigint; // funding only: the USDC the plan was budgeted from
};

// Legs in run order: the XLM→USDC funding swap (when XLM funds the allocation),
// a trustline for each non-native asset bought, one USDC swap per distinct
// asset (xlm and xlm_buffer are one XLM swap), then the vault deposit. capital
// is the USDC the legs spend (with XLM funding, the funding swap's minimum out).
// Integer budgets conserve it as executionQuotes does; usdc, usdc_reserve and
// the rounding dust are kept as USDC, with no transaction. fundingIn is the XLM
// the funding swap spends (default: the amount entered).
export function testnetLegs(allocation: Allocation & { funding?: { symbol: string; amount: string } }, capital: bigint, net: VaultNetworkConfig, fundingIn?: bigint) {
  const positions = Object.entries(allocation.positions ?? {}).filter(([, p]) => p.allocation_fraction > 0);
  const blocked = positions.map(([id]) => id).filter((id) => !testnetSelectable(id, net));
  if (blocked.length) throw new Error(`Not selectable on ${net.label}: ${blocked.map((id) => baseId(id).toUpperCase()).join(", ")} (no Soroswap testnet market).`);
  const budgets = positions.map(([, p]) => capital * BigInt(Math.floor(p.allocation_fraction * 1e12)) / BigInt(1000000000000));
  const cashIndex = positions.findIndex(([id]) => id === "usdc");
  if (cashIndex < 0) throw new Error("Allocation is missing its USDC buffer");
  budgets[cashIndex] += capital - budgets.reduce((sum, value) => sum + value, BigInt(0));
  const leg = (key: string, kind: Leg["kind"], symbol: string, path: string[] = []): Leg => ({ key, kind, symbol, ids: [], amountIn: BigInt(0), path, minOut: BigInt(0) });
  const swaps = new Map<string, Leg>();
  const vaults: Leg[] = [];
  let kept = BigInt(0);
  positions.forEach(([id], index) => {
    const base = baseId(id), symbol = net.markets[base];
    let target: Leg;
    if (base === "usdc") { kept += budgets[index]; return; }
    if (symbol) {
      if (!swaps.has(symbol)) swaps.set(symbol, leg(`swap:${symbol}`, "swap", symbol, [net.usdc.contract, net.assets[symbol].address]));
      target = swaps.get(symbol)!;
    } else {
      target = leg(`vault:${base}`, "vault", base.toUpperCase());
      vaults.push(target);
    }
    target.ids.push(id);
    target.amountIn += budgets[index];
  });
  const trustlines = [...swaps.values()].filter((swap) => net.assets[swap.symbol].classic !== "native")
    .map((swap) => ({ ...leg(`trustline:${swap.symbol}`, "trustline", swap.symbol), ids: swap.ids }));
  const legs = [...trustlines, ...swaps.values(), ...vaults];
  const funding = allocation.funding;
  if (funding && funding.symbol !== "USDC") {
    if (funding.symbol !== "XLM") throw new Error(`${funding.symbol} cannot fund an allocation on ${net.label}; use USDC or XLM.`);
    legs.unshift({ ...leg("funding", "funding", "USDC", [net.assets.XLM.address, net.usdc.contract]), amountIn: fundingIn ?? atomicAmount(funding.amount), minOut: capital });
  }
  return { legs, kept };
}

// XLM kept back for the account's minimum balance and the run's fees: two base
// reserves plus one per subentry, including the trustlines the run adds
// (0.5 XLM each, developers.stellar.org "Lumens · Minimum balance"), plus a fee
// allowance per transaction still to sign, so a Continue after fees were paid
// still passes.
const BASE_RESERVE = SCALE / BigInt(2);
export const FEE_ALLOWANCE = SCALE;
export const xlmKeep = (subentries: number, added: number, transactions: number) => BigInt(2 + subentries + added) * BASE_RESERVE + BigInt(transactions) * FEE_ALLOWANCE;

// Horizon balance string (seven decimals) -> units; null -> 0.
const balanceUnits = (value: string | null) => {
  if (value == null) return BigInt(0);
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt((fraction + "0000000").slice(0, 7));
};

type Account = { funded: boolean; trustline: boolean; balance: string | null; xlm: string | null; subentries: number; lines: Record<string, string> };

// The XLM the remaining legs keep back: trustlines already present need no transaction.
export function runKeep(legs: Leg[], account: Account): bigint {
  const added = legs.filter((l) => l.kind === "trustline" && !(l.symbol in account.lines)).length;
  return xlmKeep(account.subentries, added, legs.filter((l) => l.kind !== "trustline").length + added);
}

// The XLM the funding swap spends: the amount entered, capped so the account
// keeps runKeep back (MAX funding then swaps the rest).
export function xlmFundingIn(entered: bigint, legs: Leg[], account: Account): bigint {
  const spare = balanceUnits(account.xlm) - runKeep(legs, account);
  return spare > BigInt(0) && spare < entered ? spare : entered;
}

// The checks before the remaining legs run: a funded account, the USDC
// trustline, enough XLM for the funding swap while keeping XLM back, and
// enough USDC for the swaps and the deposit. Returns the first problem, or null.
export function testnetCheck(legs: Leg[], account: Account): string | null {
  if (!account.funded) return "This account is not funded on testnet yet. Fund it with testnet XLM (Friendbot) first.";
  if (!account.trustline) return "Add the USDC trustline on the vault page first: every leg settles in USDC.";
  const funding = legs.find((l) => l.kind === "funding");
  const keep = runKeep(legs, account);
  const xlm = balanceUnits(account.xlm), needXlm = keep + (funding?.amountIn ?? BigInt(0));
  if (xlm < needXlm)
    return `Not enough XLM: ${funding ? `funding with ${tokenUnits(funding.amountIn)} XLM while keeping` : "the run keeps"} ${tokenUnits(keep)} XLM back for fees and the account reserve needs ${tokenUnits(needXlm)} XLM; the account holds ${tokenUnits(xlm)}.${funding ? " Rebuild the allocation to size the funding swap again." : ""}`;
  const spend = legs.filter((l) => l.kind === "swap" || l.kind === "vault").reduce((sum, l) => sum + l.amountIn, BigInt(0)) - (funding?.minOut ?? BigInt(0));
  const usdc = balanceUnits(account.balance);
  if (usdc < spend) return `Not enough USDC: the remaining legs spend ${tokenUnits(spend)} USDC; the account holds ${tokenUnits(usdc)}.`;
  return null;
}
