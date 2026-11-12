// Vault client: trustlines, contract reads, the bounded deposit / withdraw /
// redeem flows of the flagship vault, and testnet swaps quoted and built by the
// Soroswap Aggregator API (through the Builder's /api/soroswap route).
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
//   Router ABI and CombinedRouterError codes from soroswap-docs
//   amm/technical-reference/contracts/soroswap-router and error-codes:
//   swap_exact_tokens_for_tokens(amount_in: i128, amount_out_min: i128,
//   path: Vec<Address>, to: Address, deadline: u64) -> Vec<i128>. Soroswap
//   API flow from soroswap-docs api/quickstart, api-reference/quote/quote and
//   build, api/stellar-gotchas and api/errors: /quote, then /quote/build with
//   the quote unchanged and from = the signer; the built XDR is already
//   simulated (never re-prepared) and valid 180 s; 428 CREATE_TRUSTLINE; 429
//   with Retry-After. A testnet build decoded on 2026-11-11 invokes the
//   manifest router's swap_exact_tokens_for_tokens with source-account auth.
//
// Flow per vault action: preview_* simulation sets the bound, prepareTransaction
// simulates the call itself and assembles footprint/auth/fees, the wallet
// signs (signTx checks the wallet network first), then sendTransaction and
// pollTransaction. A swap is quoted and built by the API, checked against its
// quote, then signed, sent and polled the same way (submitted through our own
// RPC, not the API's /send, so the pending-hash rules below apply unchanged).
// Only a SUCCESS status from getTransaction becomes a receipt.
// Once signed, any failure to submit or confirm reports the hash as an
// unknown outcome, because the transaction may still be included.

import {
  Account, Address, Asset, BASE_FEE, Contract, Horizon, Keypair, NotFoundError, Operation,
  TransactionBuilder, humanizeEvents, nativeToScVal, rpc, scValToNative, xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { VaultNetworkConfig } from "@/lib/network";
import { signTx } from "@/components/stellar/walletKit";
import { quantRequest } from "@/lib/quant";

export const SHARE_DECIMALS = 12; // types.rs SHARE_MULTIPLIER: twelve share decimals
export const BOUND_BPS = BigInt(50); // 0.5% slippage bound against the preview
export const DEADLINE_SECONDS = 300;
// At least one second apart, so polling outlasts the transaction's time bound
// and a NOT_FOUND result means it can no longer be included.
export const POLL_ATTEMPTS = DEADLINE_SECONDS + 30;
// Time bound of an API-built Soroban swap (soroswap-docs api/stellar-gotchas).
export const API_TX_SECONDS = 180;
// 429 answers waited out (Retry-After) before a Soroswap call gives up.
export const SOROSWAP_RETRIES = 3;
// Clock difference allowed between the API's build and this browser.
export const API_TX_SLACK = 30;
// Highest fee accepted on an API-built swap, in stroops: the 1 XLM per
// transaction the run keeps back for fees (lib/execution.ts FEE_ALLOWANCE).
export const MAX_SWAP_FEE = BigInt(10000000);

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

// Soroswap router CombinedRouterError codes (soroswap-docs error-codes).
export const ROUTER_ERRORS: Record<number, string> = {
  502: "The swap amount must not be negative.",
  503: "The swap deadline passed before it was applied. Quote again and retry.",
  507: "The pool price moved beyond the 0.5% minimum between the quote and execution. Quote again and retry.",
  509: "There is no Soroswap pair for this route.",
  510: "The swap amount is too small.",
  511: "The Soroswap pool does not have enough liquidity for this swap.",
  512: "The swap input amount is too small.",
  513: "The swap output would be zero.",
  514: "The swap route is invalid.",
};

// A contract's own error, as the host reports it: a panic with an error code,
// or (observed from the Soroswap router on testnet) a returned Err.
const FAILING = "failing with contract error";
const ESCALATED = "escalating Ok(ScErrorType::Contract) frame-exit to Err";

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

export type VaultPosition = {
  ledger: number;
  shares: bigint;
  value: bigint;
  maxWithdraw: bigint;
  liquid: bigint;
  paused: boolean;
};

// D5-05 indexed views of the flagship vault, through the Builder proxy. Each
// carries status (fresh, stale or missing) and as_of; a failed request becomes
// status "error" so its panel says so instead of showing nothing.
export type Indexed = { status: "fresh" | "stale" | "missing" | "error"; as_of?: string | null; age_seconds?: number | null; error?: string; [field: string]: any };
export const INDEXED_LIMIT = 288; // snapshots every 300 s: about 24 h
export const EVENTS_LIMIT = 100; // newest rebalance and yield events

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

// Blend request types used by the vault's position event (execution.rs).
const BLEND_REQUEST = ["supply", "withdraw", "supply collateral", "withdraw collateral", "borrow", "repay"];

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

// lines: balances of the manifest's classic assets the account trusts, by symbol.
export type UsdcLine = { funded: boolean; trustline: boolean; balance: string | null; xlm: string | null; subentries: number; lines: Record<string, string> };

export type Receipt = { action: string; hash: string; ledger: number; returned?: string };
export type Returned = { decimals: number; unit: string };
// A signed envelope: its hash and the end of its time bound (unix seconds).
export type Signed = { hash: string; maxTime: number };
export type OnSigned = (signed: Signed) => void;
const SHARES: Returned = { decimals: SHARE_DECIMALS, unit: "shares" };
// A Soroswap API quote: its expected and minimum output (otherAmountThreshold),
// and the response itself, sent back unchanged to /quote/build.
export type SwapQuote = { amountOut: bigint; minOut: bigint; quote: Record<string, unknown> };

// SDK 17 returns the hash as a Uint8Array.
const txHash = (tx: { hash(): Uint8Array }) => Array.from(tx.hash(), (byte) => byte.toString(16).padStart(2, "0")).join("");
const signedOf = (tx: Transaction): Signed => ({ hash: txHash(tx), maxTime: Number(tx.timeBounds?.maxTime ?? 0) });
// Carries the signed envelope, so a caller never signs again while it could still be included.
const unknownOutcome = (signed: Signed, why: string) =>
  Object.assign(new Error(`Transaction ${signed.hash} ${why}. Its outcome is unknown; check the explorer before retrying.`), { unknown: signed });

// A resource, footprint or refundable-fee failure is fixed by simulating
// again, so the transaction is re-prepared (a swap re-quoted and rebuilt) and
// re-signed once.
export function needsResimulation(result: xdr.TransactionResult | undefined): boolean {
  const outcome = result?.result;
  if (outcome?.type === "txSorobanInvalid") return true;
  if (outcome?.type !== "txFailed") return false;
  const op = outcome.results[0];
  return op?.type === "opInner" && op.tr.type === "invokeHostFunction"
    && ["invokeHostFunctionResourceLimitExceeded", "invokeHostFunctionInsufficientRefundableFee"].includes(op.tr.invokeHostFunctionResult.type);
}

// Every network-bound read and flow of one vault deployment. A page builds the
// client of its own network, so it reads, builds and signs only on that network.
export function vaultClient(net: VaultNetworkConfig) {
  const server = new rpc.Server(net.rpcUrl);
  const horizon = new Horizon.Server(net.horizonUrl);
  const vault = new Contract(net.vault);
  const usdcAsset = new Asset(net.usdc.code, net.usdc.issuer);
  const USDC: Returned = { decimals: net.usdc.decimals, unit: "USDC" };

  // The vault's own failure event in a simulation's event log. An inner contract
  // (USDC SAC, oracle, Blend) reuses low error numbers and the vault re-reports
  // its code as "contract call failed", so both the contract and the text must match.
  const failure = (contract: string) => new RegExp(`contract:${contract}, topics:\\[error, Error\\(Contract, #(\\d+)\\)\\], data:(?:\\["${FAILING}"|"${ESCALATED.replace(/[()]/g, "\\$&")}")`);
  const VAULT_FAILURE = failure(net.vault);
  const ROUTER_FAILURE = failure(net.router);

  // Turn any simulation, submission or wallet failure into a user message.
  function vaultError(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err ?? "");
    const untrusted = /contract:(\w+), topics:\[error, Error\(Contract, #\d+\)\], data:\["trustline entry is missing/.exec(message)?.[1];
    const symbol = untrusted && assetSymbol(untrusted);
    if (symbol && symbol !== untrusted && symbol !== "USDC") return `Add the ${symbol} trustline before this swap.`;
    if (/trustline entry is missing/i.test(message)) return "Add the USDC trustline before depositing.";
    if (/resulting balance is not within the allowed range|balance is not sufficient/i.test(message))
      return "The USDC transfer would leave a balance out of range: not enough USDC for this deposit, or the trustline limit reached for this withdrawal.";
    const code = Number(VAULT_FAILURE.exec(message)?.[1]);
    if (VAULT_ERRORS[code]) return `${VAULT_ERRORS[code]} (vault error ${code})`;
    const routerCode = Number(ROUTER_FAILURE.exec(message)?.[1]);
    if (routerCode) return `${ROUTER_ERRORS[routerCode] ?? "The Soroswap router rejected the swap."} (router ${net.router} error ${routerCode})`;
    if (/Error\(Auth,/.test(message)) return "Authorization failed in simulation: the vault call must be signed by the connected account.";
    if (/Account not found/i.test(message)) return `This account is not funded on ${net.label} yet. Fund it with XLM first.`;
    return (message.split("\n")[0] || "Unknown error.");
  }

  function buildCall(source: Account, fn: string, args: xdr.ScVal[], contract = vault): Transaction {
    return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: net.passphrase })
      .addOperation(contract.call(fn, ...args))
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

  // Shares and their USDC value, read from the contract (not an indexer).
  // The indexed views (readIndexed below) are shown next to this read.
  async function readPosition(owner: string): Promise<VaultPosition> {
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

  async function readIndexed(owner?: string | null): Promise<Record<string, Indexed>> {
    const base = net.indexer;
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

  const assetSymbol = (contract: string) =>
    Object.values(net.assets).find((asset) => asset.address === contract)?.symbol ?? contract;

  const targetLabel = (t: { assets: string[]; weights_bps: number[]; yield_bps: number }) =>
    `${t.assets.map((asset, i) => `${assetSymbol(asset)} ${t.weights_bps[i] / 100}%`).join(" · ")} · Blend yield ${t.yield_bps / 100}% of the residual reserve`;

  // One readable line per rebalance or Blend-yield event; plan and target rows
  // reuse the decoded USDC equity and weights of the history and allocations views.
  function eventDetail(event: { kind: string; tx_hash: string; data: any }, history?: Indexed, allocations?: Indexed): string {
    const equity = history?.plan_equity?.find((p: any) => p.tx_hash === event.tx_hash && p.kind === event.kind);
    if (equity) return `nonce ${equity.nonce} · equity ${equity.before_usdc} → ${equity.after_usdc} USDC`;
    const target = event.kind === "target" && allocations?.targets?.find((t: any) => t.tx_hash === event.tx_hash);
    if (target) return `epoch ${target.epoch} · ${targetLabel(target)}`;
    if (event.kind === "position" && Array.isArray(event.data)) {
      const [kind, asset, amount] = event.data;
      const decimals = Object.values(net.assets).find((a) => a.address === asset)?.decimals;
      const value = decimals == null ? String(amount) : fromUnits(BigInt(amount), decimals);
      return `Blend ${BLEND_REQUEST[kind] ?? `request ${kind}`} ${value} ${assetSymbol(asset)}`;
    }
    return JSON.stringify(event.data);
  }

  async function readUsdcLine(owner: string): Promise<UsdcLine> {
    let account;
    try {
      account = await horizon.loadAccount(owner);
    } catch (err: any) {
      if (err instanceof NotFoundError) return { funded: false, trustline: false, balance: null, xlm: null, subentries: 0, lines: {} };
      throw err;
    }
    const line = account.balances.find((b: any) => b.asset_code === net.usdc.code && b.asset_issuer === net.usdc.issuer);
    const xlm = account.balances.find((b: any) => b.asset_type === "native");
    const lines: Record<string, string> = {};
    for (const asset of Object.values(net.assets)) {
      const held = account.balances.find((b: any) => `${b.asset_code}:${b.asset_issuer}` === asset.classic);
      if (held) lines[asset.symbol] = held.balance;
    }
    return { funded: true, trustline: Boolean(line), balance: line ? line.balance : null, xlm: xlm ? xlm.balance : null,
      subentries: Number(account.subentry_count ?? 0), lines };
  }

  // A classic manifest asset's trustline (USDC by default; tRESERVE before a reserve swap).
  async function addUsdcTrustline(owner: string, symbol = "USDC", onSigned?: OnSigned): Promise<Receipt> {
    const [code, issuer] = (net.assets[symbol]?.classic ?? "").split(":");
    if (!issuer) throw new Error(`${symbol} is not a classic asset of this deployment.`);
    const account = await horizon.loadAccount(owner);
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: net.passphrase })
      .addOperation(Operation.changeTrust({ asset: symbol === "USDC" ? usdcAsset : new Asset(code, issuer) }))
      .setTimeout(DEADLINE_SECONDS)
      .build();
    const signed = TransactionBuilder.fromXDR(await signTx(tx.toXDR(), net.passphrase), net.passphrase) as Transaction;
    const envelope = signedOf(signed);
    const hash = envelope.hash;
    onSigned?.(envelope);
    try {
      const result = await horizon.submitTransaction(signed);
      return { action: `Add ${symbol} trustline`, hash: result.hash, ledger: result.ledger };
    } catch (err: any) {
      // SDK 17: TransactionFailedError / BadResponseError carry {status, data}.
      const codes = err?.response?.data?.extras?.result_codes;
      if (codes?.operations?.includes("op_low_reserve"))
        throw new Error(`Fund the account with more ${net.label} XLM: the trustline raises its minimum balance by 0.5 XLM.`);
      if (codes) throw new Error(`Trustline transaction ${hash} was rejected (${[codes.transaction, ...(codes.operations ?? [])].join(", ")}).`);
      throw unknownOutcome(envelope, `could not be confirmed (${vaultError(err)})`);
    }
  }

  // The vault's (or another contract's) own error code from an included transaction's diagnostic events.
  function onchainVaultCode(events: xdr.DiagnosticEvent[] = [], contract = net.vault): number | undefined {
    const failure = humanizeEvents(events).find((e) => e.contractId === contract && e.topics[0] === "error"
      && ((Array.isArray(e.data) && e.data[0] === FAILING) || e.data === ESCALATED));
    return failure?.topics[1]?.code;
  }

  // onSigned receives each signed envelope before it is submitted. args builds
  // the call's arguments for each attempt, so a re-simulated retry carries a
  // fresh deadline; its minimum stays the bound shown before signing.
  async function invoke(owner: string, action: string, contract: Contract, fn: string, args: () => xdr.ScVal[], returns: Returned, onSigned?: OnSigned, retried = false): Promise<Receipt> {
    const prepared = await server.prepareTransaction(buildCall(await server.getAccount(owner), fn, args(), contract));
    return submit(prepared, action, returns, DEADLINE_SECONDS, onSigned,
      retried ? null : () => invoke(owner, action, contract, fn, args, returns, onSigned, true));
  }

  // Sign, send and poll a built transaction. retry (once) builds it again after
  // a resource or footprint failure; window is its time bound in seconds.
  async function submit(tx: Transaction, action: string, returns: Returned, window: number, onSigned?: OnSigned, retry?: (() => Promise<Receipt>) | null): Promise<Receipt> {
    const signed = TransactionBuilder.fromXDR(await signTx(tx.toXDR(), net.passphrase), net.passphrase) as Transaction;
    const envelope = signedOf(signed);
    const hash = envelope.hash;
    onSigned?.(envelope);
    let sent;
    try {
      sent = await server.sendTransaction(signed);
    } catch (err) {
      throw unknownOutcome(envelope, `could not be confirmed as submitted (${vaultError(err)})`);
    }
    if (sent.status === "ERROR") {
      if (retry && needsResimulation(sent.errorResult)) return retry();
      const type = sent.errorResult?.result.type ?? "unknown";
      if (type === "txTooLate") throw new Error(`The signature took longer than the transaction's ${window}-second window, so it was not submitted. Preview again and retry.`);
      throw new Error(`Transaction rejected before inclusion (${type}).`);
    }
    if (sent.status === "TRY_AGAIN_LATER") throw new Error("The network did not queue the transaction. Try again.");
    let final;
    try {
      final = await server.pollTransaction(hash, { attempts: POLL_ATTEMPTS });
    } catch (err) {
      throw unknownOutcome(envelope, `was submitted but its status could not be read (${vaultError(err)})`);
    }
    if (final.status === rpc.Api.GetTransactionStatus.SUCCESS)
      return { action, hash, ledger: final.ledger, returned: returnedText(final.returnValue, returns) };
    if (final.status === rpc.Api.GetTransactionStatus.FAILED) {
      if (retry && needsResimulation(final.resultXdr)) return retry();
      const code = onchainVaultCode(final.diagnosticEventsXdr);
      if (code && VAULT_ERRORS[code]) throw new Error(`${VAULT_ERRORS[code]} (vault error ${code}) Transaction ${hash} failed onchain; only the fee was charged.`);
      const routerCode = onchainVaultCode(final.diagnosticEventsXdr, net.router);
      if (routerCode) throw new Error(`${ROUTER_ERRORS[routerCode] ?? "The Soroswap router rejected the swap."} (router ${net.router} error ${routerCode}) Transaction ${hash} failed onchain; only the fee was charged.`);
      throw new Error(`Transaction ${hash} failed onchain (${final.resultXdr.result.type}).`);
    }
    throw unknownOutcome(envelope, `was not found within ${POLL_ATTEMPTS} seconds, past its time bound`);
  }

  // A contract's returned amount: an i128, or the last of a router's Vec<i128>.
  function returnedText(value: xdr.ScVal | undefined, returns: Returned): string | undefined {
    if (!value) return undefined;
    const native = scValToNative(value);
    return `${fromUnits(BigInt(Array.isArray(native) ? native.at(-1) : native), returns.decimals)} ${returns.unit}`;
  }

  // The status of a signed envelope whose outcome was unknown. NOT_FOUND within
  // its time bound stays pending: it could still be included. Past the time
  // bound it can no longer be included; it counts as expired when the RPC
  // history reaches back to before it was signed, and otherwise its outcome is
  // outside the retained history (it may have been included earlier).
  async function checkTransaction(signed: Signed, action: string, returns: Returned):
    Promise<{ status: "SUCCESS"; receipt: Receipt } | { status: "FAILED" | "EXPIRED" | "OUTSIDE_HISTORY" | "PENDING" }> {
    const tx = await server.getTransaction(signed.hash);
    if (tx.status === rpc.Api.GetTransactionStatus.SUCCESS)
      return { status: "SUCCESS", receipt: { action, hash: signed.hash, ledger: tx.ledger, returned: returnedText(tx.returnValue, returns) } };
    if (tx.status === rpc.Api.GetTransactionStatus.FAILED) return { status: "FAILED" };
    if (!(signed.maxTime > 0 && tx.latestLedgerCloseTime > signed.maxTime)) return { status: "PENDING" };
    return { status: tx.oldestLedgerCloseTime < signed.maxTime - DEADLINE_SECONDS ? "EXPIRED" : "OUTSIDE_HISTORY" };
  }

  const assetOf = (contract: string) => Object.values(net.assets).find((asset) => asset.address === contract);
  const swapReturns = (path: string[]): Returned => ({ decimals: assetOf(path.at(-1)!)?.decimals ?? 7, unit: assetSymbol(path.at(-1)!) });

  // A call to the Builder's Soroswap route, which holds the API key. A 429 is
  // waited out for its Retry-After seconds, at most SOROSWAP_RETRIES times.
  async function soroswap(step: "quote" | "build", body: object, attempt = 0): Promise<any> {
    const response = await fetch(`/api/soroswap/${step}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok) return data;
    const wait = Number(response.headers.get("Retry-After") ?? data.retryAfter) || 1;
    if (response.status === 429 && attempt < SOROSWAP_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      return soroswap(step, body, attempt + 1);
    }
    if (response.status === 428) {
      // The trustline legs add the manifest's assets before their swaps; a
      // trustline asked for here is reported, never signed from the API's XDR.
      const { assetCode, assetIssuer } = data.actionData ?? {};
      const asset = Object.values(net.assets).find((a) => a.classic === `${assetCode}:${assetIssuer}`);
      throw new Error(`Add the ${asset?.symbol ?? `${assetCode}:${assetIssuer}`} trustline before this swap (Soroswap API 428 ${data.action ?? "CREATE_TRUSTLINE"}).`);
    }
    if (response.status === 429) throw new Error(`The Soroswap API rate limit was reached. Try again in ${wait} seconds.`);
    const detail = [data.message ?? data.error, data.detail].flat().filter(Boolean).join(" · ");
    // Only "No path found" means the pair has no route; any other failure is the API's or ours.
    throw Object.assign(new Error(`Soroswap API ${response.status}${detail ? `: ${detail}` : ""}`), { noPath: response.status === 400 && /No path found/i.test(detail) });
  }

  // API quote of an exact input from path[0] to its last asset (nothing
  // signed). The minimum is the API's otherAmountThreshold at the network's
  // slippage. noPath marks an API answer that the pair has no route.
  async function quoteSwap(amountIn: bigint, path: string[]): Promise<SwapQuote> {
    const [assetIn, assetOut] = [path[0], path.at(-1)!];
    try {
      const quote = await soroswap("quote", { network: net.soroswap.network, assetIn, assetOut, amount: String(amountIn) });
      const [amountOut, minOut] = [String(quote.amountOut), String(quote.otherAmountThreshold)];
      if (quote.assetIn !== assetIn || quote.assetOut !== assetOut || quote.amountIn !== String(amountIn) || quote.tradeType !== "EXACT_IN"
        || !/^\d+$/.test(amountOut) || !/^[1-9]\d*$/.test(minOut) || BigInt(minOut) > BigInt(amountOut))
        throw new Error("the quote does not match the requested swap or its output would be zero");
      return { amountOut: BigInt(amountOut), minOut: BigInt(minOut), quote };
    } catch (err) {
      throw Object.assign(new Error(`No Soroswap testnet quote for ${assetSymbol(assetIn)} → ${assetSymbol(assetOut)}: ${vaultError(err)}`), { noPath: (err as { noPath?: boolean }).noPath === true });
    }
  }

  // The built transaction must be the quoted swap and nothing else: the
  // owner's single swap_exact_tokens_for_tokens on the manifest router, with
  // its five arguments: the quote's amount in, its minimum out, its two assets,
  // and to = owner. Its time bound ends within API_TX_SECONDS (plus clock
  // slack), so the pending and expiry rules hold, and its fee is at most MAX_SWAP_FEE.
  function checkBuilt(tx: Transaction, owner: string, quoted: SwapQuote, path: string[]) {
    const op = tx.operations[0];
    const call = tx.operations.length === 1 && op.type === "invokeHostFunction" && op.func.type === "hostFunctionTypeInvokeContract" ? op.func.invokeContract : null;
    const [amountIn, minOut, route, to] = call ? call.args.map((arg) => scValToNative(arg)) : [];
    const now = Math.floor(Date.now() / 1000), maxTime = Number(tx.timeBounds?.maxTime ?? 0);
    if (tx.source !== owner || !call || Address.fromScAddress(call.contractAddress).toString() !== net.router || String(call.functionName) !== "swap_exact_tokens_for_tokens"
      || call.args.length !== 5 || amountIn !== BigInt(quoted.quote.amountIn as string) || minOut !== quoted.minOut || !Array.isArray(route) || route[0] !== path[0] || route.at(-1) !== path.at(-1) || to !== owner
      || !(maxTime > now && maxTime <= now + API_TX_SECONDS + API_TX_SLACK) || BigInt(tx.fee) > MAX_SWAP_FEE)
      throw new Error("The Soroswap API built a transaction that is not the quoted swap on the manifest router. Nothing was signed.");
  }

  // Exact-in swap to the connected account: quoted, built by the API, checked,
  // then signed and submitted. floor is the least minimum accepted (a sell's
  // share of the minimum its source was valued at). A quote answered "No path found" is marked unquoted;
  // a resource failure is quoted and built again once.
  async function swapExactIn(owner: string, amountIn: bigint, path: string[], onSigned?: OnSigned, floor = BigInt(0), retried = false): Promise<Receipt> {
    const [assetIn, assetOut] = [path[0], path.at(-1)!];
    let quoted;
    try {
      quoted = await quoteSwap(amountIn, path);
    } catch (err) {
      throw Object.assign(err as Error, { unquoted: !retried && (err as { noPath?: boolean }).noPath === true });
    }
    const out = swapReturns(path);
    if (quoted.minOut < floor)
      throw new Error(`The ${assetSymbol(assetIn)} → ${assetSymbol(assetOut)} quote's minimum (${fromUnits(quoted.minOut, out.decimals)} ${out.unit}) is now below the ${fromUnits(floor, out.decimals)} ${out.unit} the allocation was budgeted from. Rebuild the allocation.`);
    const { xdr: built } = await soroswap("build", { network: net.soroswap.network, quote: quoted.quote, from: owner });
    const tx = TransactionBuilder.fromXDR(built, net.passphrase) as Transaction;
    checkBuilt(tx, owner, quoted, path);
    const action = `Swap ${fromUnits(amountIn, assetOf(assetIn)?.decimals ?? 7)} ${assetSymbol(assetIn)} → ${assetSymbol(assetOut)}`;
    return submit(tx, action, out, API_TX_SECONDS, onSigned, retried ? null : () => swapExactIn(owner, amountIn, path, onSigned, floor, true));
  }

  // Preview for the form, shown before anything is signed; the flows below
  // re-read it so the bound reflects the latest ledger. A redeem previews an
  // amount of shares.
  async function preview(kind: "deposit" | "withdraw" | "redeem", amount: string): Promise<bigint> {
    const units = toUnits(amount, kind === "redeem" ? SHARE_DECIMALS : net.usdc.decimals);
    return BigInt((await read(`preview_${kind}`, [i128(units)])).value);
  }

  // receiver, from/owner and operator are all the connected account.
  async function deposit(owner: string, amount: string, onSigned?: OnSigned): Promise<Receipt> {
    const minShares = minBound(await preview("deposit", amount));
    return invoke(owner, `Deposit ${amount} USDC`, vault, "deposit_bounded",
      () => [i128(toUnits(amount, USDC.decimals)), address(owner), address(owner), address(owner), i128(minShares), u64(deadline())], SHARES, onSigned);
  }

  async function withdraw(owner: string, amount: string, onSigned?: OnSigned): Promise<Receipt> {
    const maxShares = maxBound(await preview("withdraw", amount));
    return invoke(owner, `Withdraw ${amount} USDC`, vault, "withdraw_bounded",
      () => [i128(toUnits(amount, USDC.decimals)), address(owner), address(owner), address(owner), i128(maxShares), u64(deadline())], SHARES, onSigned);
  }

  // Full exit: redeem the whole share balance for USDC.
  async function exitAll(owner: string, onSigned?: OnSigned): Promise<Receipt> {
    const shares = BigInt((await read("balance", [address(owner)])).value);
    if (shares <= BigInt(0)) throw new Error("This account holds no vault shares.");
    const redeemable = BigInt((await read("preview_redeem", [i128(shares)])).value);
    return invoke(owner, `Full exit: redeem ${fromUnits(shares, SHARE_DECIMALS)} shares`, vault, "redeem_bounded",
      () => [i128(shares), address(owner), address(owner), address(owner), i128(minBound(redeemable)), u64(deadline())], USDC, onSigned);
  }

  return { net, vaultError, readPosition, readIndexed, readUsdcLine, addUsdcTrustline, onchainVaultCode, preview, deposit, withdraw, exitAll, assetSymbol, targetLabel, eventDetail,
    quoteSwap, swapExactIn, checkTransaction, swapReturns, SHARES };
}
export type VaultClient = ReturnType<typeof vaultClient>;
