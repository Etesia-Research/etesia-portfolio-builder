import { ASSET_CONTRACTS } from "@/lib/assets";
import type { VaultNetworkConfig } from "@/lib/network";
import { quantRequest, type Allocation } from "@/lib/quant";
import { VAULTS } from "@/lib/vaults";

const SCALE = BigInt(10000000);
export function tokenUnits(amount: string | bigint): string {
  const value = BigInt(amount);
  return `${value / SCALE}.${(value % SCALE).toString().padStart(7, "0")}`;
}

// ---------- Rebalance ----------
// A source is the selected part of one holding: percent of it, quantity in its
// units (seven decimals; vault shares twelve). Its valuation is the selected
// part's USDC value when built (units): expected value, the minimum it sells
// for (on testnet, XLM and tRESERVE count it at the reference rate until the
// run quotes their sells), for vault shares the owner's max withdraw, and for
// XLM and tRESERVE on testnet the reference quote they were valued at.
export type Source = { symbol: string; percent: number; quantity: bigint };
export type Valuation = { quantity: bigint; value: bigint; minOut: bigint; maxWithdraw?: bigint; ref?: { amountIn: bigint; amountOut: bigint } };
export type Sourced = Allocation & { sources: Source[]; valuation: Record<string, Valuation> };

// Smaller differences between a bucket's current value and its target are not traded.
export const TOLERANCE = BigInt(100000); // 0.01 USDC

// One bucket per asset: positions served, the selected part (quantity, current
// USDC value), its USDC target and the net trade. A sell's amountIn is in the
// bucket's units (a withdraw in USDC), its minOut the USDC it counts on; a
// buy's amountIn is USDC. cap: the vault's max withdraw, when it binds.
export type Row = { symbol: string; ids: string[]; quantity: bigint; current: bigint; target: bigint;
  trade: "sell" | "buy" | "none"; amountIn: bigint; minOut: bigint; redeem: boolean; cap: bigint | null };

const sum = (values: bigint[]) => values.reduce((total, value) => total + value, BigInt(0));

// Net trades from the selected parts of the holdings to the allocation's
// targets; unselected holdings are untouched. capital is the selected parts'
// value. Targets are integer budgets of it (the rounding dust stays in USDC).
// A bucket above its target sells the excess: a swap sells that share of the
// selected quantity, counting on the same share of its valued minimum; the
// vault withdraws the excess in USDC (capped at its max withdraw), or redeems
// every share when its target is 0 and all of them are selected. Buys spend
// the selected USDC and the sells' minimums beyond the USDC target, scaled
// down together when they are short. sold, when given, replaces a sell's
// minimum with the USDC its quote returns at least. kept is the USDC left
// unspent (at least, counting the sells at their minimums).
export function rebalance(allocation: Sourced, bucketOf: (id: string) => string, sold: Record<string, bigint> = {}) {
  const capital = sum(Object.values(allocation.valuation).map((v) => v.value));
  const positions = Object.entries(allocation.positions ?? {}).filter(([, p]) => p.allocation_fraction > 0);
  const budgets = positions.map(([, p]) => capital * BigInt(Math.floor(p.allocation_fraction * 1e12)) / BigInt(1000000000000));
  const cashIndex = positions.findIndex(([id]) => id === "usdc");
  if (cashIndex < 0) throw new Error("Allocation is missing its USDC buffer");
  budgets[cashIndex] += capital - sum(budgets);
  const rows = new Map<string, Row>();
  const row = (symbol: string) => {
    const valued = allocation.valuation[symbol];
    if (!rows.has(symbol)) rows.set(symbol, { symbol, ids: [], quantity: valued?.quantity ?? BigInt(0), current: valued?.value ?? BigInt(0), target: BigInt(0),
      trade: "none", amountIn: BigInt(0), minOut: BigInt(0), redeem: false, cap: null });
    return rows.get(symbol)!;
  };
  positions.forEach(([id], index) => {
    const bucket = row(bucketOf(id));
    bucket.ids.push(id);
    bucket.target += budgets[index];
  });
  allocation.sources.forEach((source) => row(source.symbol));
  const cash = row("USDC");
  const traded = [...rows.values()].filter((r) => r !== cash);
  let available = cash.quantity;
  for (const r of traded) {
    const excess = r.current - r.target, valued = allocation.valuation[r.symbol];
    if (excess < TOLERANCE) continue;
    if (valued.maxWithdraw == null) {
      r.amountIn = r.quantity * excess / r.current;
      r.minOut = valued.minOut * r.amountIn / r.quantity;
    } else if (r.target === BigInt(0) && allocation.sources.find((s) => s.symbol === r.symbol)?.percent === 100) {
      [r.redeem, r.amountIn, r.minOut] = [true, r.quantity, valued.minOut];
    } else {
      r.amountIn = r.minOut = excess < valued.maxWithdraw ? excess : valued.maxWithdraw;
      if (excess > valued.maxWithdraw) r.cap = valued.maxWithdraw;
    }
    if (r.symbol in sold) r.minOut = sold[r.symbol];
    if (r.amountIn <= BigInt(0)) continue;
    r.trade = "sell";
    available += r.minOut;
  }
  const buys = traded.filter((r) => r.target - r.current >= TOLERANCE);
  const wanted = sum(buys.map((r) => r.target - r.current));
  const spendable = available > cash.target ? available - cash.target : BigInt(0);
  for (const r of buys) {
    r.amountIn = wanted > spendable ? (r.target - r.current) * spendable / wanted : r.target - r.current;
    if (r.amountIn > BigInt(0)) r.trade = "buy";
  }
  return { capital, rows: [...rows.values()], kept: available - sum(buys.map((r) => r.amountIn)) };
}

// Mainnet simulation of the net trades: current values at the daily close,
// sells quoted asset → USDC and buys USDC → asset through the quant API, the
// vault at a simulated $1 per share. The sells are quoted first and the buys
// spend the USDC their quotes return at least, not their daily-close value.
// Nothing is signed.
export async function executionQuotes(allocation: Sourced, usdcUsd: number, signal?: AbortSignal) {
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
  const bucket = (id: string) => baseId(id).toUpperCase();
  const quote = async (row: Row) => {
    const base = { symbol: row.symbol, ids: row.ids, trade: row.trade, current: String(row.current), target: String(row.target), amountIn: String(row.amountIn) };
    if (row.trade === "none") return { ...base, kind: row.symbol === "USDC" ? "cash" : "none", amountOut: null, minimumOut: null, fetchedAt: null, error: null };
    if (row.symbol === "ETESIA-TF") return { ...base, kind: "vault", amountOut: String(row.amountIn * BigInt(Math.round(usdcUsd * 1e12)) / BigInt(1000000000000)), minimumOut: null, fetchedAt: null, error: null };
    try {
      return { ...base, kind: "swap", ...await (row.trade === "sell" ? swap(row.symbol, "USDC", row.amountIn) : swap("USDC", row.symbol, row.amountIn)), error: null };
    } catch (error) {
      return { ...base, kind: "swap", amountOut: null, minimumOut: null, fetchedAt: null, error: error instanceof Error ? error.message : "Quote unavailable" };
    }
  };
  const sells = await Promise.all(rebalance(allocation, bucket).rows.filter((row) => row.trade === "sell").map(quote));
  const sold = Object.fromEntries(sells.filter((row) => row.minimumOut != null).map((row) => [row.symbol, BigInt(row.minimumOut!)]));
  const { capital, rows } = rebalance(allocation, bucket, sold);
  const quoted = await Promise.all(rows.map((row) => row.trade === "sell" ? sells.find((sell) => sell.symbol === row.symbol)! : quote(row)));
  const fetched = quoted.map((row) => row.fetchedAt).filter((stamp): stamp is string => !!stamp);
  return { capital: String(capital), rows: quoted,
    expiresAt: Math.min(Date.now(), ...fetched.map(stamp => new Date(stamp).getTime())) + 60000 };
}

// ---------- Testnet execution plan ----------
// On a vault network (testnet mode) every trade of a rebalance is a real
// transaction: Soroswap swaps (quoted and built by the Soroswap API) and the
// vault's withdraw_bounded, redeem_bounded and deposit_bounded.

const baseId = (id: string) => id.replace(/_(?:buffer|reserve)$/, "");

// A position can be held on this network when it is USDC, has a market of the
// same asset in the manifest (net.markets), or is a vault deployed here.
export function testnetSelectable(id: string, net: VaultNetworkConfig): boolean {
  const base = baseId(id);
  return base === "usdc" || base in net.markets || VAULTS.some((v) => v.coin === base && Object.values(v.networks).some((d) => d?.vault === net.vault));
}

export type Leg = {
  key: string; // stable within an allocation, for the pending-hash record
  kind: "trustline" | "sell" | "withdraw" | "redeem" | "swap" | "vault";
  symbol: string; // asset sold (sell), bought (swap) or trusted (trustline); the vault product otherwise
  ids: string[]; // allocation positions of the asset's bucket
  amountIn: bigint; // the asset sold (sell), shares (redeem), USDC otherwise (withdraw: USDC withdrawn); 0 for a trustline
  path: string[]; // swaps: [asset in, asset out], quoted through the Soroswap API
  minOut: bigint; // the USDC a sell, withdraw or redeem counts on (a sell is signed only above it)
  cap?: bigint; // withdraw: the vault's max withdraw, when it binds
};

// Legs in run order: a trustline for each non-native asset bought, the sells
// (swaps to USDC, then the vault withdraw or redeem), then the buys (swaps
// from USDC, then the vault deposit). Buckets: USDC (usdc, usdc_reserve), XLM
// (xlm, xlm_buffer), the market asset of each other position (ustry →
// tRESERVE) and the vault. kept is the USDC left in the wallet with no transaction.
// sold, when given, sets the sells' minimums (rebalance).
export function testnetLegs(allocation: Sourced, net: VaultNetworkConfig, sold: Record<string, bigint> = {}) {
  const positions = Object.entries(allocation.positions ?? {}).filter(([, p]) => p.allocation_fraction > 0);
  const blocked = positions.map(([id]) => id).filter((id) => !testnetSelectable(id, net));
  if (blocked.length) throw new Error(`Not selectable on ${net.label}: ${blocked.map((id) => baseId(id).toUpperCase()).join(", ")} (no Soroswap testnet market).`);
  const plan = rebalance(allocation, (id) => {
    const base = baseId(id);
    return base === "usdc" ? "USDC" : net.markets[base] ?? base.toUpperCase();
  }, sold);
  const leg = (key: string, kind: Leg["kind"], symbol: string, ids: string[], path: string[] = []): Leg => ({ key, kind, symbol, ids, amountIn: BigInt(0), path, minOut: BigInt(0) });
  const trustlines: Leg[] = [], sells: Leg[] = [], exits: Leg[] = [], buys: Leg[] = [], deposits: Leg[] = [];
  for (const r of plan.rows) {
    const asset = net.assets[r.symbol], vault = r.symbol.toLowerCase(); // a symbol outside the manifest assets is the vault
    if (r.trade === "sell") {
      if (asset) sells.push({ ...leg(`sell:${r.symbol}`, "sell", r.symbol, r.ids, [asset.address, net.usdc.contract]), amountIn: r.amountIn, minOut: r.minOut });
      else exits.push({ ...leg(`${r.redeem ? "redeem" : "withdraw"}:${vault}`, r.redeem ? "redeem" : "withdraw", r.symbol, r.ids), amountIn: r.amountIn, minOut: r.minOut, ...(r.cap != null && { cap: r.cap }) });
    } else if (r.trade === "buy") {
      if (!asset) { deposits.push({ ...leg(`vault:${vault}`, "vault", r.symbol, r.ids), amountIn: r.amountIn }); continue; }
      if (asset.classic !== "native") trustlines.push(leg(`trustline:${r.symbol}`, "trustline", r.symbol, r.ids));
      buys.push({ ...leg(`swap:${r.symbol}`, "swap", r.symbol, r.ids, [net.usdc.contract, asset.address]), amountIn: r.amountIn });
    }
  }
  return { legs: [...trustlines, ...sells, ...exits, ...buys, ...deposits], kept: plan.kept, rows: plan.rows, capital: plan.capital };
}

// Price impact guard. A swap's reference rate is a Soroswap API quote of one
// whole unit (or of the swap's amount, if smaller) of the same pair and
// direction. The pool fee is in both quotes, so their ratio isolates the
// price impact. The testnet pools are shallow: a swap above the limit is not signed.
export const IMPACT_LIMIT_BPS = 200;
export const referenceIn = (amount: bigint) => amount < SCALE ? amount : SCALE;

// 1 − (amountOut / amountIn) / (refOut / refIn) in basis points, rounded up;
// 0 when the swap does at least as well as its reference.
export function priceImpactBps(amountIn: bigint, amountOut: bigint, refIn: bigint, refOut: bigint): number {
  const ratio = amountOut * refIn * BigInt(10000) / (amountIn * refOut);
  return ratio >= BigInt(10000) ? 0 : 10000 - Number(ratio);
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

// The most XLM a run keeps back: runKeep with every market asset and the
// vault traded and every missing trustline added. The XLM source's
// selectable maximum leaves it, so its sell passes testnetCheck.
export function xlmSourceKeep(account: Account, net: VaultNetworkConfig): bigint {
  const added = Object.values(net.markets).filter((symbol) => net.assets[symbol].classic !== "native" && !(symbol in account.lines)).length;
  return xlmKeep(account.subentries, added, Object.keys(net.markets).length + 1 + added);
}

// The vault position the vault legs need (lib/vault.ts readPosition).
type Position = { shares: bigint; maxWithdraw: bigint; paused: boolean };

// The checks before the remaining legs run: a funded account, the USDC
// trustline, enough XLM for the XLM sold while keeping XLM back, each other
// sold asset held, an unpaused vault with the shares and max withdraw its
// legs take, and enough USDC for the buys beyond the sells' minimums.
// Returns the first problem, or null.
export function testnetCheck(legs: Leg[], account: Account, position?: Position | null): string | null {
  if (!account.funded) return "This account is not funded on testnet yet. Fund it with testnet XLM (Friendbot) first.";
  if (!account.trustline) return "Add the USDC trustline on the vault page first: every leg settles in USDC.";
  const keep = runKeep(legs, account);
  const sold = legs.find((l) => l.kind === "sell" && l.symbol === "XLM")?.amountIn ?? BigInt(0);
  const xlm = balanceUnits(account.xlm), needXlm = keep + sold;
  if (xlm < needXlm)
    return `Not enough XLM: ${sold ? `selling ${tokenUnits(sold)} XLM while keeping` : "the run keeps"} ${tokenUnits(keep)} XLM back for fees and the account reserve needs ${tokenUnits(needXlm)} XLM; the account holds ${tokenUnits(xlm)}.${sold ? " Rebuild the allocation to size the XLM source again." : ""}`;
  for (const leg of legs.filter((l) => l.kind === "sell" && l.symbol !== "XLM")) {
    const held = balanceUnits(account.lines[leg.symbol] ?? null);
    if (held < leg.amountIn) return `Not enough ${leg.symbol}: the run sells ${tokenUnits(leg.amountIn)} ${leg.symbol}; the account holds ${tokenUnits(held)}.`;
  }
  if (position && legs.some((l) => l.kind === "vault" || l.kind === "withdraw" || l.kind === "redeem")) {
    if (position.paused) return "The vault is paused: its withdraw, redeem and deposit legs cannot run.";
    const exit = legs.find((l) => l.kind === "withdraw" || l.kind === "redeem");
    if (exit?.kind === "withdraw" && position.maxWithdraw < exit.amountIn)
      return `Not enough vault liquidity: the run withdraws ${tokenUnits(exit.amountIn)} USDC; the vault's max withdraw for this account is ${tokenUnits(position.maxWithdraw)} USDC. Rebuild the allocation.`;
    if (exit?.kind === "redeem" && position.shares < exit.amountIn) return "Not enough vault shares: the account holds fewer shares than the run redeems. Rebuild the allocation.";
  }
  const spend = sum(legs.filter((l) => l.kind === "swap" || l.kind === "vault").map((l) => l.amountIn))
    - sum(legs.filter((l) => l.kind === "sell" || l.kind === "withdraw" || l.kind === "redeem").map((l) => l.minOut));
  const usdc = balanceUnits(account.balance);
  if (usdc < spend) return `Not enough USDC: the remaining legs spend ${tokenUnits(spend)} USDC; the account holds ${tokenUnits(usdc)}.`;
  return null;
}
