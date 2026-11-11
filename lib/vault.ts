// Testnet vault client: USDC trustline, contract reads and the bounded
// deposit / withdraw / redeem flows of the flagship vault.
//
// doc-checked: @stellar/stellar-sdk 17.4.0 type defs (rpc.Server
//   simulateTransaction / prepareTransaction / sendTransaction /
//   pollTransaction, Horizon.Server loadAccount / submitTransaction,
//   Operation.changeTrust, nativeToScVal / scValToNative, humanizeEvents,
//   NotFoundError / TransactionFailedError, getTransaction
//   diagnosticEventsXdr checked on a failed testnet tx) and the
//   stellar-dev dapp skill (simulate, prepare, sign, send, poll). Vault ABI
//   from etesia-vault/contracts/vault/src/lib.rs (deposit_bounded,
//   withdraw_bounded, redeem_bounded, preview_*, balance, convert_to_assets,
//   max_withdraw, liquid_assets, state) and error codes from types.rs.
//
// Flow per action: preview_* simulation sets the bound, prepareTransaction
// simulates the call itself and assembles footprint/auth/fees, the wallet
// signs (signTx checks the wallet network first), then sendTransaction and
// pollTransaction. Only a SUCCESS status from getTransaction becomes a receipt.
// Once signed, any failure to submit or confirm reports the hash as an
// unknown outcome, because the transaction may still be included.

import {
  Account, Address, Asset, BASE_FEE, Contract, Horizon, Keypair, NotFoundError, Operation,
  TransactionBuilder, humanizeEvents, nativeToScVal, rpc, scValToNative, xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { TESTNET } from "@/lib/network";
import { signTx } from "@/components/stellar/walletKit";
import { quantRequest } from "@/lib/quant";

export const SHARE_DECIMALS = 12; // types.rs SHARE_MULTIPLIER: twelve share decimals
export const BOUND_BPS = BigInt(50); // 0.5% slippage bound against the preview
export const DEADLINE_SECONDS = 300;
// At least one second apart, so polling outlasts the transaction's time bound
// and a NOT_FOUND result means it can no longer be included.
export const POLL_ATTEMPTS = DEADLINE_SECONDS + 30;

const server = new rpc.Server(TESTNET.rpcUrl);
const horizon = new Horizon.Server(TESTNET.horizonUrl);
const vault = new Contract(TESTNET.vault);
const usdcAsset = new Asset(TESTNET.usdc.code, TESTNET.usdc.issuer);

// Vault Error enum (contracts/vault/src/types.rs).
export const VAULT_ERRORS: Record<number, string> = {
  1: "The vault rejected the request as invalid.",
  2: "The amount is too large for the vault's arithmetic.",
  3: "This account is not authorized for this action.",
  4: "Insufficient vault share balance for this exit.",
  5: "The transaction deadline passed before it was applied. Try again.",
  6: "Deposits are paused on this vault.",
  7: "The vault's price feed is stale or unavailable, so equity cannot be priced. Retry shortly.",
  8: "The vault reports insolvency; flows are blocked.",
  9: "The vault does not hold enough liquid USDC for this amount. Stay within the max withdraw shown.",
  10: "The vault has open lending exposure that must be unwound before USDC exits.",
  11: "The vault must catch up on fee accounting before this action.",
  12: "The vault is busy with another call (reentrancy guard). Try again.",
  13: "Vault shares cannot be credited to the vault itself.",
  14: "The price moved beyond the 0.5% bound between preview and execution. Preview again and retry.",
  15: "The vault's published target no longer matches (keeper execution).",
  16: "Replay protection rejected this request.",
  17: "The request exceeds a vault limit.",
  18: "A timelock is still running for this action.",
  19: "Borrowing is disabled on this vault.",
  20: "Reward accounting failed.",
};

const FAILING = "failing with contract error";
// The vault's own failure event in a simulation's event log. An inner contract
// (USDC SAC, oracle, Blend) reuses low error numbers and the vault re-reports
// its code as "contract call failed", so both the contract and the text must match.
const VAULT_FAILURE = new RegExp(`contract:${TESTNET.vault}, topics:\\[error, Error\\(Contract, #(\\d+)\\)\\], data:\\["${FAILING}"`);

// Turn any simulation, submission or wallet failure into a user message.
export function vaultError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (/trustline entry is missing/i.test(message)) return "Add the USDC trustline before depositing.";
  if (/resulting balance is not within the allowed range|balance is not sufficient/i.test(message))
    return "The USDC transfer would leave a balance out of range: not enough USDC for this deposit, or the trustline limit reached for this withdrawal.";
  const code = Number(VAULT_FAILURE.exec(message)?.[1]);
  if (VAULT_ERRORS[code]) return `${VAULT_ERRORS[code]} (vault error ${code})`;
  if (/Error\(Auth,/.test(message)) return "Authorization failed in simulation: the vault call must be signed by the connected account.";
  if (/Account not found/i.test(message)) return "This account is not funded on testnet yet. Fund it with XLM first.";
  return (message.split("\n")[0] || "Unknown error.");
}

// Decimal string <-> integer units, without floating point.
export function toUnits(amount: string, decimals: number): bigint {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(amount.trim());
  if (!match || !(match[1] || match[2])) throw new Error("Enter a valid amount.");
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) throw new Error(`At most ${decimals} decimal places.`);
  return BigInt((match[1] || "0") + fraction.padEnd(decimals, "0"));
}
export function fromUnits(units: bigint, decimals: number): string {
  const digits = units.toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return digits.slice(0, -decimals) + (fraction ? `.${fraction}` : "");
}

// Bounds: floors for minimums received, ceilings for maximums paid.
export const minBound = (preview: bigint) => (preview * (BigInt(10000) - BOUND_BPS)) / BigInt(10000);
export const maxBound = (preview: bigint) => (preview * (BigInt(10000) + BOUND_BPS) + BigInt(9999)) / BigInt(10000);
export const deadline = (now = Date.now()) => BigInt(Math.floor(now / 1000) + DEADLINE_SECONDS);

const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
const u64 = (value: bigint) => nativeToScVal(value, { type: "u64" });
const address = (value: string) => Address.fromString(value).toScVal();

function buildCall(source: Account, fn: string, args: xdr.ScVal[]): Transaction {
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
    .addOperation(vault.call(fn, ...args))
    .setTimeout(DEADLINE_SECONDS)
    .build();
}

// Simulate a read-only vault call. Simulation needs no funded source account.
async function read(fn: string, args: xdr.ScVal[] = []): Promise<{ value: any; ledger: number }> {
  const source = new Account(Keypair.random().publicKey(), "0");
  const sim = await server.simulateTransaction(buildCall(source, fn, args));
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  return { value: scValToNative(sim.result!.retval), ledger: sim.latestLedger };
}

export type VaultPosition = {
  ledger: number;
  shares: bigint;
  value: bigint;
  maxWithdraw: bigint;
  liquid: bigint;
  paused: boolean;
};

// Shares and their USDC value, read from the contract (not an indexer).
// The indexed views (readIndexed below) are shown next to this read.
export async function readPosition(owner: string): Promise<VaultPosition> {
  const [balance, maxWithdraw, liquid, state] = await Promise.all([
    read("balance", [address(owner)]),
    read("max_withdraw", [address(owner)]),
    read("liquid_assets"),
    read("state"),
  ]);
  const shares = BigInt(balance.value);
  const value = shares > BigInt(0) ? BigInt((await read("convert_to_assets", [i128(shares)])).value) : BigInt(0);
  return {
    ledger: Math.max(balance.ledger, maxWithdraw.ledger, liquid.ledger, state.ledger),
    shares, value, maxWithdraw: BigInt(maxWithdraw.value), liquid: BigInt(liquid.value), paused: Boolean(state.value.paused),
  };
}

// D5-05 indexed views of the flagship vault, through the Builder proxy. Each
// carries status (fresh, stale or missing) and as_of; a failed request becomes
// status "error" so its panel says so instead of showing nothing.
export type Indexed = { status: "fresh" | "stale" | "missing" | "error"; as_of?: string | null; age_seconds?: number | null; error?: string; [field: string]: any };
export const INDEXED_LIMIT = 288; // snapshots every 300 s: about 24 h
export const EVENTS_LIMIT = 100; // newest rebalance and yield events

export async function readIndexed(owner?: string | null): Promise<Record<string, Indexed>> {
  const base = "vaults/flagship";
  const paths: Record<string, string> = {
    summary: `${base}/summary`, history: `${base}/history?limit=${INDEXED_LIMIT}`,
    allocations: `${base}/allocations?limit=${INDEXED_LIMIT}`, performance: `${base}/performance`, events: `${base}/events?limit=${EVENTS_LIMIT}`,
    ...(owner ? { position: `${base}/positions/${owner}` } : {}),
  };
  const settled = await Promise.allSettled(Object.values(paths).map((path) => quantRequest(path)));
  return Object.fromEntries(Object.keys(paths).map((key, i) => {
    const result = settled[i];
    return [key, result.status === "fulfilled" ? result.value
      : { status: "error", error: result.reason instanceof Error ? result.reason.message : String(result.reason) }];
  }));
}

export function freshness(view?: Indexed): string {
  if (!view) return "Reading the indexer…";
  if (view.status === "error") return `Unavailable · ${view.error}`;
  if (view.status === "missing") return "Missing · the indexer has no data for this view yet";
  const age = view.age_seconds == null ? "" : ` · ${Math.round(view.age_seconds / 60)} min old`;
  return `${view.status === "stale" ? "Stale" : "Fresh"} · indexed as of ${view.as_of}${age}`;
}

// Evenly spaced items, always keeping the first and the last.
export function sample<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  return Array.from({ length: count }, (_, i) => items[Math.round((i * (items.length - 1)) / (count - 1))]);
}

export const assetSymbol = (contract: string) =>
  Object.values(TESTNET.assets).find((asset) => asset.address === contract)?.symbol ?? contract;
export const targetLabel = (t: { assets: string[]; weights_bps: number[]; yield_bps: number }) =>
  `${t.assets.map((asset, i) => `${assetSymbol(asset)} ${t.weights_bps[i] / 100}%`).join(" · ")} · Blend yield ${t.yield_bps / 100}% of the residual reserve`;

// Blend request types used by the vault's position event (execution.rs).
const BLEND_REQUEST = ["supply", "withdraw", "supply collateral", "withdraw collateral", "borrow", "repay"];

// One readable line per rebalance or Blend-yield event; plan and target rows
// reuse the decoded USDC equity and weights of the history and allocations views.
export function eventDetail(event: { kind: string; tx_hash: string; data: any }, history?: Indexed, allocations?: Indexed): string {
  const equity = history?.plan_equity?.find((p: any) => p.tx_hash === event.tx_hash && p.kind === event.kind);
  if (equity) return `nonce ${equity.nonce} · equity ${equity.before_usdc} → ${equity.after_usdc} USDC`;
  const target = event.kind === "target" && allocations?.targets?.find((t: any) => t.tx_hash === event.tx_hash);
  if (target) return `epoch ${target.epoch} · ${targetLabel(target)}`;
  if (event.kind === "position" && Array.isArray(event.data)) {
    const [kind, asset, amount] = event.data;
    const decimals = Object.values(TESTNET.assets).find((a) => a.address === asset)?.decimals;
    const value = decimals == null ? String(amount) : fromUnits(BigInt(amount), decimals);
    return `Blend ${BLEND_REQUEST[kind] ?? `request ${kind}`} ${value} ${assetSymbol(asset)}`;
  }
  return JSON.stringify(event.data);
}

// Blend interest per asset supplied in the latest snapshot: the change in its
// Blend-supplied balance summed over consecutive snapshot intervals. Every
// vault supply or withdraw emits a position event (execution.rs pool_action),
// so an interval is skipped when it holds one for that asset, when the events
// view does not cover it (older than the events returned, or at or past the
// indexer's next ledger), or when either snapshot lacks the asset.
type Holding = { captured_at: string; ledger: number | null; assets: { asset: string; symbol: string; supply: number }[] | null };
export function supplyAccrual(holdings: Holding[] = [], events?: Indexed, nextLedger?: number | null) {
  const priced = holdings.filter((h) => h.assets && h.ledger != null);
  const list: { ledger: number; kind: string; data: any }[] | undefined = events?.events;
  if (priced.length < 2 || !Array.isArray(list) || nextLedger == null) return [];
  const reach = list.length >= EVENTS_LIMIT ? list[0].ledger : -Infinity;
  return priced.at(-1)!.assets!.filter((a) => a.supply > 0).map(({ asset, symbol }) => {
    let change = 0, counted = 0;
    for (let i = 1; i < priced.length; i++) {
      const [a, b] = [priced[i - 1], priced[i]];
      const start = a.assets!.find((x) => x.asset === asset), end = b.assets!.find((x) => x.asset === asset);
      const moved = list.some((e) => e.kind === "position" && Array.isArray(e.data) && e.data[1] === asset && e.ledger > a.ledger! && e.ledger <= b.ledger!);
      if (!start || !end || moved || a.ledger! < reach || b.ledger! >= nextLedger) continue;
      change += end.supply - start.supply;
      counted++;
    }
    return { symbol, from: priced[0].captured_at, to: priced.at(-1)!.captured_at, change, counted, intervals: priced.length - 1 };
  });
}

export type UsdcLine = { funded: boolean; trustline: boolean; balance: string | null; xlm: string | null };

export async function readUsdcLine(owner: string): Promise<UsdcLine> {
  let account;
  try {
    account = await horizon.loadAccount(owner);
  } catch (err: any) {
    if (err instanceof NotFoundError) return { funded: false, trustline: false, balance: null, xlm: null };
    throw err;
  }
  const line = account.balances.find((b: any) => b.asset_code === TESTNET.usdc.code && b.asset_issuer === TESTNET.usdc.issuer);
  const xlm = account.balances.find((b: any) => b.asset_type === "native");
  return { funded: true, trustline: Boolean(line), balance: line ? line.balance : null, xlm: xlm ? xlm.balance : null };
}

export type Receipt = { action: string; hash: string; ledger: number; returned?: string };
type Returned = { decimals: number; unit: string };
const SHARES: Returned = { decimals: SHARE_DECIMALS, unit: "shares" };
const USDC: Returned = { decimals: TESTNET.usdc.decimals, unit: "USDC" };

// SDK 17 returns the hash as a Uint8Array.
const txHash = (tx: { hash(): Uint8Array }) => Array.from(tx.hash(), (byte) => byte.toString(16).padStart(2, "0")).join("");
const unknownOutcome = (hash: string, why: string) =>
  new Error(`Transaction ${hash} ${why}. Its outcome is unknown; check the explorer before retrying.`);

export async function addUsdcTrustline(owner: string): Promise<Receipt> {
  const account = await horizon.loadAccount(owner);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: TESTNET.passphrase })
    .addOperation(Operation.changeTrust({ asset: usdcAsset }))
    .setTimeout(DEADLINE_SECONDS)
    .build();
  const signed = TransactionBuilder.fromXDR(await signTx(tx.toXDR()), TESTNET.passphrase);
  const hash = txHash(signed);
  try {
    const result = await horizon.submitTransaction(signed);
    return { action: "Add USDC trustline", hash: result.hash, ledger: result.ledger };
  } catch (err: any) {
    // SDK 17: TransactionFailedError / BadResponseError carry {status, data}.
    const codes = err?.response?.data?.extras?.result_codes;
    if (codes?.operations?.includes("op_low_reserve"))
      throw new Error("Fund the account with more testnet XLM: the trustline raises its minimum balance by 0.5 XLM.");
    if (codes) throw new Error(`Trustline transaction ${hash} was rejected (${[codes.transaction, ...(codes.operations ?? [])].join(", ")}).`);
    throw unknownOutcome(hash, `could not be confirmed (${vaultError(err)})`);
  }
}

// The vault's own error code from an included transaction's diagnostic events.
export function onchainVaultCode(events: xdr.DiagnosticEvent[] = []): number | undefined {
  const failure = humanizeEvents(events).find((e) => e.contractId === TESTNET.vault && e.topics[0] === "error"
    && Array.isArray(e.data) && e.data[0] === FAILING);
  return failure?.topics[1]?.code;
}

// A resource or footprint failure is fixed by simulating again, so the
// transaction is re-prepared and re-signed once.
export function needsResimulation(result: xdr.TransactionResult | undefined): boolean {
  const outcome = result?.result;
  if (outcome?.type === "txSorobanInvalid") return true;
  if (outcome?.type !== "txFailed") return false;
  const op = outcome.results[0];
  return op?.type === "opInner" && op.tr.type === "invokeHostFunction"
    && op.tr.invokeHostFunctionResult.type === "invokeHostFunctionResourceLimitExceeded";
}

async function invoke(owner: string, action: string, fn: string, args: xdr.ScVal[], returns: Returned, retried = false): Promise<Receipt> {
  const prepared = await server.prepareTransaction(buildCall(await server.getAccount(owner), fn, args));
  const signed = TransactionBuilder.fromXDR(await signTx(prepared.toXDR()), TESTNET.passphrase);
  const hash = txHash(signed);
  let sent;
  try {
    sent = await server.sendTransaction(signed);
  } catch (err) {
    throw unknownOutcome(hash, `could not be confirmed as submitted (${vaultError(err)})`);
  }
  if (sent.status === "ERROR") {
    if (!retried && needsResimulation(sent.errorResult)) return invoke(owner, action, fn, args, returns, true);
    const type = sent.errorResult?.result.type ?? "unknown";
    if (type === "txTooLate") throw new Error(`The signature took longer than the transaction's ${DEADLINE_SECONDS}-second window, so it was not submitted. Preview again and retry.`);
    throw new Error(`Transaction rejected before inclusion (${type}).`);
  }
  if (sent.status === "TRY_AGAIN_LATER") throw new Error("The network did not queue the transaction. Try again.");
  let final;
  try {
    final = await server.pollTransaction(hash, { attempts: POLL_ATTEMPTS });
  } catch (err) {
    throw unknownOutcome(hash, `was submitted but its status could not be read (${vaultError(err)})`);
  }
  if (final.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    const returned = final.returnValue ? `${fromUnits(BigInt(scValToNative(final.returnValue)), returns.decimals)} ${returns.unit}` : undefined;
    return { action, hash, ledger: final.ledger, returned };
  }
  if (final.status === rpc.Api.GetTransactionStatus.FAILED) {
    if (!retried && needsResimulation(final.resultXdr)) return invoke(owner, action, fn, args, returns, true);
    const code = onchainVaultCode(final.diagnosticEventsXdr);
    if (code && VAULT_ERRORS[code]) throw new Error(`${VAULT_ERRORS[code]} (vault error ${code}) Transaction ${hash} failed onchain; only the fee was charged.`);
    throw new Error(`Transaction ${hash} failed onchain (${final.resultXdr.result.type}).`);
  }
  throw unknownOutcome(hash, `was not found within ${POLL_ATTEMPTS} seconds, past its time bound`);
}

// Preview for the form, shown before anything is signed; the flows below
// re-read it so the bound reflects the latest ledger.
export async function preview(kind: "deposit" | "withdraw", amount: string): Promise<bigint> {
  const assets = toUnits(amount, TESTNET.usdc.decimals);
  return BigInt((await read(kind === "deposit" ? "preview_deposit" : "preview_withdraw", [i128(assets)])).value);
}

// receiver, from/owner and operator are all the connected account.
export async function deposit(owner: string, amount: string): Promise<Receipt> {
  const minShares = minBound(await preview("deposit", amount));
  return invoke(owner, `Deposit ${amount} USDC`, "deposit_bounded",
    [i128(toUnits(amount, USDC.decimals)), address(owner), address(owner), address(owner), i128(minShares), u64(deadline())], SHARES);
}

export async function withdraw(owner: string, amount: string): Promise<Receipt> {
  const maxShares = maxBound(await preview("withdraw", amount));
  return invoke(owner, `Withdraw ${amount} USDC`, "withdraw_bounded",
    [i128(toUnits(amount, USDC.decimals)), address(owner), address(owner), address(owner), i128(maxShares), u64(deadline())], SHARES);
}

// Full exit: redeem the whole share balance for USDC.
export async function exitAll(owner: string): Promise<Receipt> {
  const shares = BigInt((await read("balance", [address(owner)])).value);
  if (shares <= BigInt(0)) throw new Error("This account holds no vault shares.");
  const redeemable = BigInt((await read("preview_redeem", [i128(shares)])).value);
  return invoke(owner, `Full exit: redeem ${fromUnits(shares, SHARE_DECIMALS)} shares`, "redeem_bounded",
    [i128(shares), address(owner), address(owner), address(owner), i128(minBound(redeemable)), u64(deadline())], USDC);
}
