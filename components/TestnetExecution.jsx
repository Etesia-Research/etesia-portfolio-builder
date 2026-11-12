"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useStellarWalletStore from "@/stores/useStellarWalletStore";
import { API_TX_SECONDS, DEADLINE_SECONDS, SHARE_DECIMALS, fromUnits, minBound, vaultClient } from "@/lib/vault";
import { TOLERANCE, runKeep, testnetCheck, testnetLegs, tokenUnits } from "@/lib/execution";

// Testnet execution of a Builder allocation: the rebalance of the selected
// sources to the allocation's targets, where every leg is a real Stellar testnet
// transaction signed by the wallet, one per leg, in the order of testnetLegs.
// A receipt comes only from a SUCCESS getTransaction. A leg whose signed
// envelope could still be included is never signed again: its hash is kept in
// localStorage until it resolves, and an unresolved one blocks every new run.
// One that may have executed (SUCCESS, or past its time bound outside the RPC
// history) stays stored with its outcome, and blocks a new allocation's run
// until the user acknowledges that the new run does not deduct it.

const STORE_KEY = "etesia.builder.pending";
const DONE = new Set(["confirmed", "skipped", "untracked"]);
const MAY_HAVE_EXECUTED = new Set(["SUCCESS", "OUTSIDE_HISTORY"]);
const STAND_IN = " · USTRY stand-in on testnet";

// Pending signed envelopes by owner; null when browser storage is unavailable.
export function pendingStore(getStorage = () => window.localStorage) {
  let storage;
  try {
    storage = getStorage();
    storage.getItem(STORE_KEY);
  } catch {
    return null;
  }
  const all = () => {
    try { return JSON.parse(storage.getItem(STORE_KEY) || "{}"); } catch { return {}; }
  };
  const save = (owner, records) => {
    try { storage.setItem(STORE_KEY, JSON.stringify({ ...all(), [owner]: records })); } catch { /* reported by the banner when storage is unavailable */ }
  };
  return {
    list: (owner) => all()[owner] ?? [],
    put: (owner, record) => save(owner, [...(all()[owner] ?? []).filter((r) => !(r.generatedAt === record.generatedAt && r.leg === record.leg)), record]),
    drop: (owner, hash) => save(owner, (all()[owner] ?? []).filter((r) => r.hash !== hash)),
  };
}

const standIn = (symbol) => symbol === "tRESERVE" ? STAND_IN : "";
export function legLabel(leg) {
  if (leg.kind === "trustline") return `${leg.symbol} trustline · changeTrust${standIn(leg.symbol)}`;
  if (leg.kind === "sell") return `Sell · ${leg.symbol} → USDC${standIn(leg.symbol)}`;
  if (leg.kind === "withdraw") return `Withdraw · ${leg.symbol} withdraw_bounded`;
  if (leg.kind === "redeem") return `Redeem all · ${leg.symbol} redeem_bounded`;
  if (leg.kind === "swap") return `Buy · USDC → ${leg.symbol}${standIn(leg.symbol)}`;
  return `Deposit · ${leg.symbol} deposit_bounded`;
}

const returnsFor = (client, leg) => leg.kind === "vault" || leg.kind === "withdraw" ? client.SHARES : leg.kind === "redeem" ? { decimals: client.net.usdc.decimals, unit: "USDC" }
  : leg.kind === "trustline" ? { decimals: 7, unit: leg.symbol } : client.swapReturns(leg.path);

// Expected and minimum output of each leg before signing: Soroswap API quotes
// for swaps, with the API's otherAmountThreshold as the minimum (a sell also
// shows the USDC the plan counts on, the least minimum it is signed with), the
// vault's previews for the deposit and the redeem; a withdraw receives its exact USDC.
export async function quoteLegs(client, legs) {
  const entries = await Promise.all(legs.map(async (leg) => {
    try {
      if (leg.kind === "trustline") return [leg.key, null];
      if (leg.kind === "withdraw") return [leg.key, { amountOut: leg.amountIn, minOut: leg.amountIn }];
      if (leg.kind === "vault" || leg.kind === "redeem") {
        const out = await (leg.kind === "vault" ? client.preview("deposit", fromUnits(leg.amountIn, client.net.usdc.decimals)) : client.preview("redeem", fromUnits(leg.amountIn, SHARE_DECIMALS)));
        return [leg.key, { amountOut: out, minOut: minBound(out) }];
      }
      const { amountOut, minOut } = await client.quoteSwap(leg.amountIn, leg.path);
      return [leg.key, { amountOut, minOut, ...(leg.kind === "sell" && { budgeted: leg.minOut }) }];
    } catch (err) {
      return [leg.key, { error: client.vaultError(err) }];
    }
  }));
  return Object.fromEntries(entries);
}

// Resolve a stored or unknown envelope. One that may have executed stays stored
// with its outcome; one that did not (FAILED, EXPIRED) leaves the store.
export async function resolveRecord(client, store, owner, record) {
  const result = await client.checkTransaction(record, record.action, record.returns);
  if (MAY_HAVE_EXECUTED.has(result.status)) store?.put(owner, { ...record, outcome: result });
  else if (result.status !== "PENDING") store?.drop(owner, record.hash);
  return result;
}

const VAULT_LEGS = new Set(["vault", "withdraw", "redeem"]);

// The selected sources valued at testnet execution prices (USDC units): USDC
// 1:1, XLM and tRESERVE at a Soroswap API quote to USDC (its minimum kept: a
// sell is signed only above its share of it), vault shares at their value
// from readPosition times the percent, with the redeem preview's 0.5% bound as
// their minimum and the owner's max withdraw. A failed quote throws, which
// blocks the build. Few quotes (at most two), within the API's burst; the
// client waits out a 429.
export async function valueSources(client, sources, position) {
  const net = client.net;
  return Object.fromEntries(await Promise.all(sources.map(async ({ symbol, percent, quantity }) => {
    if (symbol === "USDC") return [symbol, { quantity, value: quantity, minOut: quantity }];
    if (net.assets[symbol]) {
      // Counted 0.5% below the quote's minimum, so the sell's re-quote at signing
      // may be up to 0.5% lower and still meet the floor the buys were sized on.
      const { amountOut, minOut } = await client.quoteSwap(quantity, [net.assets[symbol].address, net.usdc.contract]);
      return [symbol, { quantity, value: amountOut, minOut: minBound(minOut) }];
    }
    const redeem = await client.preview("redeem", fromUnits(quantity, SHARE_DECIMALS));
    return [symbol, { quantity, value: position.value * BigInt(Math.round(percent * 100)) / BigInt(10000), minOut: minBound(redeem), maxWithdraw: position.maxWithdraw }];
  })));
}

// Before anything can be signed: resolve the owner's stored envelopes (an
// unresolved one blocks the run; one that may have executed is listed as an
// earlier allocation's), read the account (and the vault position for vault
// legs), plan the rebalance from the valuation fixed when the allocation was
// built, and quote the legs.
export async function prepareRun(client, allocation, net, store) {
  const { owner } = allocation;
  const open = [], earlier = [];
  for (const record of store?.list(owner) ?? []) {
    let result;
    try {
      result = record.outcome ?? await resolveRecord(client, store, owner, record);
    } catch (err) {
      open.push({ ...record, error: client.vaultError(err) });
      continue;
    }
    if (result.status === "PENDING") open.push(record);
    else earlier.push({ record, result });
  }
  const account = await client.readUsdcLine(owner);
  const { legs, kept, rows, capital } = testnetLegs(allocation, net);
  const position = legs.some((leg) => VAULT_LEGS.has(leg.kind)) ? await client.readPosition(owner) : null;
  const quotes = await quoteLegs(client, legs);
  return { plan: { legs, kept, rows, capital, quotes, check: testnetCheck(legs, account, position), xlmKept: runKeep(legs, account) }, open, earlier };
}

async function executeLeg(client, owner, leg, account, onSigned) {
  if (leg.kind === "trustline") return leg.symbol in account.lines ? null : client.addUsdcTrustline(owner, leg.symbol, onSigned);
  if (leg.amountIn <= BigInt(0)) throw new Error("The leg amount is below one atomic unit.");
  const usdc = (amount) => fromUnits(amount, client.net.usdc.decimals);
  if (leg.kind === "vault") return client.deposit(owner, usdc(leg.amountIn), onSigned);
  if (leg.kind === "withdraw") return client.withdraw(owner, usdc(leg.amountIn), onSigned);
  if (leg.kind === "redeem") return client.exitAll(owner, onSigned);
  // Quoted again and built by the Soroswap API right before the signature; a
  // buy without a quote is not executed. A sell's built minimum must cover
  // the USDC the plan counts on.
  return client.swapExactIn(owner, leg.amountIn, leg.path, onSigned, leg.kind === "sell" ? leg.minOut : BigInt(0));
}

// Run the legs that are not done, in order, stopping at the first failure or
// unknown outcome. A buy the Soroswap API finds no path for is not executed,
// nor its trustline, and the other legs still run; a sell without a quote,
// or any other quote failure (rate limit, API outage, missing key), stops the
// run, because the buys spend its USDC. Before each leg the run stops when
// it is no longer active (the panel left or the allocation changed) and refuses
// while the store holds a record from outside this run. update(key, state)
// records each leg's state.
export async function runLegs({ client, owner, generatedAt, legs, states, store, update, active = () => true }) {
  const account = await client.readUsdcLine(owner);
  const pending = legs.filter((leg) => !DONE.has(states[leg.key]?.status));
  const unquoted = new Set();
  for (const leg of pending.filter((l) => l.kind === "sell" || l.kind === "swap")) {
    try {
      await client.quoteSwap(leg.amountIn, leg.path);
    } catch (err) {
      if (!err?.noPath || leg.kind === "sell") throw new Error(`${client.vaultError(err)} Nothing was signed; run again once the Soroswap API answers.`);
      unquoted.add(leg.symbol);
      update(leg.key, { status: "unavailable", error: client.vaultError(err) });
    }
  }
  for (const leg of pending.filter((l) => l.kind === "trustline" && unquoted.has(l.symbol)))
    update(leg.key, { status: "unavailable", error: `not added: the USDC → ${leg.symbol} swap has no quote` });
  const remaining = pending.filter((leg) => !((leg.kind === "swap" || leg.kind === "trustline") && unquoted.has(leg.symbol)));
  const position = remaining.some((leg) => VAULT_LEGS.has(leg.kind)) ? await client.readPosition(owner) : null;
  const problem = testnetCheck(remaining, account, position);
  if (problem) throw new Error(problem);
  for (const leg of remaining) {
    if (!active()) return false;
    const outside = (store?.list(owner) ?? []).find((r) => r.generatedAt !== generatedAt || !r.outcome);
    if (outside) throw new Error(`Transaction ${outside.hash} (${outside.action}) was signed outside this run. Reload the page to resolve it before continuing.`);
    update(leg.key, { status: "signing" });
    let record = null;
    const onSigned = (signed) => {
      record = { generatedAt, leg: leg.key, ...signed, action: legLabel(leg), returns: returnsFor(client, leg) };
      store?.put(owner, record);
      update(leg.key, { status: "submitted", signed: record });
    };
    try {
      const receipt = await executeLeg(client, owner, leg, account, onSigned);
      if (record) store?.put(owner, { ...record, outcome: { status: "SUCCESS", receipt } });
      update(leg.key, receipt ? { status: "confirmed", receipt } : { status: "skipped" });
    } catch (err) {
      if (err?.unquoted && leg.kind === "swap") {
        update(leg.key, { status: "unavailable", error: client.vaultError(err) });
        continue;
      }
      if (err?.unknown && record) {
        update(leg.key, { status: "unknown", signed: record, error: client.vaultError(err) });
        return false;
      }
      if (record) store?.drop(owner, record.hash);
      update(leg.key, { status: "failed", error: client.vaultError(err) });
      return false;
    }
  }
  return true;
}

// A leg state from a status check of its signed envelope.
export function checkedState(result, record) {
  if (result.status === "SUCCESS") return { status: "confirmed", receipt: result.receipt };
  if (result.status === "FAILED") return { status: "failed", error: `Transaction ${record.hash} failed onchain; only the fee was charged.` };
  if (result.status === "EXPIRED") return { status: "pending", note: `Transaction ${record.hash} expired without being included; this leg can be signed again.` };
  if (result.status === "OUTSIDE_HISTORY") return { status: "untracked", error: `Transaction ${record.hash} can no longer be included, but it is outside the RPC's retained history, so whether it executed is unknown. Check it on the explorer; this leg is not signed again.` };
  return { status: "unknown", signed: record, error: `Transaction ${record.hash} is not found yet and could still be included until its time bound passes and the network confirms it. Check again shortly.` };
}

const units = (value, decimals = 7) => value == null ? "—" : fromUnits(value, decimals);
const STATUS = { pending: "Waiting", signing: "Waiting for your wallet signature…", submitted: "Submitted · confirming onchain…", confirmed: "Confirmed", skipped: "Trustline already present · no transaction", failed: "Failed", unknown: "Outcome unknown", unavailable: "Not executed", untracked: "Outcome unknown · outside the RPC history" };

function Receipt({ net, label, receipt }) {
  return <div role="status" className="tx-receipt">
    <strong>{net.label} transaction, not a simulation · {label}</strong>
    <p>Confirmed in ledger {receipt.ledger}{receipt.returned ? ` · contract returned ${receipt.returned}` : ''}.</p>
    <p className="data-note">Hash <a href={`${net.explorerUrl}/tx/${receipt.hash}`} target="_blank" rel="noreferrer">{receipt.hash}</a></p>
  </div>;
}

// One rebalance row's trade, as the legs below execute it (a symbol outside
// the manifest assets is the vault).
function tradeText(row, net) {
  if (row.symbol === "USDC") return "Kept as USDC · no transaction";
  if (row.trade === "sell") return row.redeem ? `Redeem all ${units(row.amountIn, SHARE_DECIMALS)} shares`
    : net.assets[row.symbol] ? `Sell ${tokenUnits(row.amountIn)} ${row.symbol}`
    : `Withdraw ${tokenUnits(row.amountIn)} USDC${row.cap != null ? ` · capped at the vault's max withdraw` : ''}`;
  if (row.trade === "buy") return `Buy with ${tokenUnits(row.amountIn)} USDC${row.amountIn < row.target - row.current ? ' · scaled down to the USDC the sells provide' : ''}`;
  const gap = row.target > row.current ? row.target - row.current : row.current - row.target;
  return gap < TOLERANCE ? "Within tolerance, no trade" : row.cap != null ? "No trade · the vault's max withdraw is 0" : "No trade";
}

// Presentational: the rebalance table, the leg table, blocks, actions and receipts.
export function ExecutionPanel({ net, owner, plan, states, open, earlier, prepError, runError, running, storageOk, networkError, wrongAccount, onRun, onCheck, onCheckOpen, onAcknowledge }) {
  const unknown = plan ? plan.legs.filter((leg) => states[leg.key]?.status === "unknown") : [];
  const started = plan ? plan.legs.some((leg) => states[leg.key]) : false;
  const finished = plan ? plan.legs.every((leg) => DONE.has(states[leg.key]?.status)) : false;
  const repeats = earlier.filter(({ result, acknowledged }) => !acknowledged && MAY_HAVE_EXECUTED.has(result.status));
  const blocked = running || !plan || finished || open.length > 0 || unknown.length > 0 || repeats.length > 0 || !!networkError || wrongAccount;
  const contract = (leg) => VAULT_LEGS.has(leg.kind) ? net.vault : leg.kind === "trustline" ? net.assets[leg.symbol].classic : net.router;
  return <section className="execution-routes">
    <h4>Execution — Stellar testnet transactions signed by your wallet · test funds only</h4>
    <p className="data-note">One transaction per leg, each signed in your wallet: trustlines for bought assets, the sells of the selected sources (Soroswap swaps to USDC, then the vault withdraw or redeem), then the buys (Soroswap swaps from USDC, then the vault deposit). Every swap is quoted and built by the Soroswap Aggregator API on its testnet Soroswap pools (each invokes the router {net.router}). Soroswap testnet pool quote; testnet prices are not market prices. A swap's minimum output is the API's minimum at {net.soroswap.slippageBps / 100}% slippage (a sell is signed only while that minimum covers the USDC the plan counts on) and the vault calls allow 0.5% against their previews. Each swap is quoted and built again right before its signature and expires {API_TX_SECONDS} seconds after it is built; the other transactions expire after {DEADLINE_SECONDS} seconds.</p>
    {!storageOk && <p role="alert" className="data-note" style={{ color: 'var(--warn)' }}>Browser storage is unavailable, so a reload cannot recover a transaction that is still pending. Check your account on the explorer (<a href={`${net.explorerUrl}/account/${owner}`} target="_blank" rel="noreferrer">{owner}</a>) before running again.</p>}
    {networkError && <p role="alert" className="data-note" style={{ color: 'var(--bad)' }}>{networkError}</p>}
    {wrongAccount && <p role="alert" className="data-note" style={{ color: 'var(--bad)' }}>The connected account is not the one this allocation was built for. Rebuild it to execute.</p>}
    {prepError && <p role="alert" className="data-note" style={{ color: 'var(--bad)' }}>{prepError}</p>}
    {!plan && !prepError && <p role="status" className="data-note">Reading the testnet account, pending transactions and Soroswap testnet quotes…</p>}
    {open.map((record) => <div key={record.hash} role="alert" className="execution-quote">
      <strong>Pending transaction</strong>
      <span>{record.action} · <a href={`${net.explorerUrl}/tx/${record.hash}`} target="_blank" rel="noreferrer">{record.hash}</a></span>
      <span className="data-note">{record.error ? `Status unavailable (${record.error}). ` : ''}A transaction signed earlier could still be included, so nothing can be signed until it resolves. <button className="btn ghost" disabled={running} onClick={() => onCheckOpen(record)}>Check status</button></span>
    </div>)}
    {earlier.map(({ record, result }) => result.status === "SUCCESS"
      ? <Receipt key={record.hash} net={net} label={`${record.action} (earlier allocation)`} receipt={result.receipt} />
      : <p key={record.hash} className="data-note">Earlier transaction <a href={`${net.explorerUrl}/tx/${record.hash}`} target="_blank" rel="noreferrer">{record.hash}</a> ({record.action}) {result.status === "FAILED" ? "failed onchain; only the fee was charged" : result.status === "EXPIRED" ? "expired without being included" : "can no longer be included, but it is outside the RPC's retained history, so whether it executed is unknown; check it on the explorer"}.</p>)}
    {repeats.length > 0 && <p role="alert" className="data-note" style={{ color: 'var(--warn)' }}>{repeats.length === 1 ? 'A transaction' : `${repeats.length} transactions`} of an earlier allocation executed or may have executed: {repeats.map(({ record }) => record.action).join(' · ')}. They are not deducted from this allocation, so running it executes its legs in full again. <button className="btn ghost" disabled={running} onClick={onAcknowledge}>Acknowledge and allow this run</button></p>}
    {plan && <>
      <div className="execution-quote-list" data-table="rebalance">
        <div className="execution-quote"><strong>Rebalance — current vs target</strong><span className="data-note">The selected parts of your holdings, valued when built at Soroswap testnet quotes and the vault's share value, against the model targets of their value. Unselected holdings are untouched.</span></div>
        {plan.rows.map((row) => <div className="execution-quote" key={row.symbol} data-bucket={row.symbol}>
          <strong>{row.symbol}{standIn(row.symbol)}</strong>
          <span>Current {units(row.quantity, net.assets[row.symbol] ? 7 : SHARE_DECIMALS)} {net.assets[row.symbol] ? row.symbol : 'shares'} · {tokenUnits(row.current)} USDC → target {tokenUnits(row.target)} USDC</span>
          <span className="data-note">{tradeText(row, net)}</span>
        </div>)}
      </div>
      {plan.check && <p role="alert" className="data-note" style={{ color: 'var(--warn)' }}>{plan.check}</p>}
      <div className="execution-quote-list">{plan.legs.map((leg, index) => {
        const quote = plan.quotes[leg.key], state = states[leg.key];
        const decimals = leg.kind === "vault" ? SHARE_DECIMALS : 7, unit = leg.kind === "vault" ? "shares" : leg.kind === "swap" ? leg.symbol : "USDC";
        const input = leg.kind === "trustline" ? "No amount · raises the account's minimum balance by 0.5 XLM"
          : leg.kind === "sell" ? `${tokenUnits(leg.amountIn)} ${leg.symbol}${leg.symbol === "XLM" ? ` · keeps ${tokenUnits(plan.xlmKept)} XLM back for fees and the account reserve` : ''}`
          : leg.kind === "redeem" ? `${units(leg.amountIn, SHARE_DECIMALS)} shares, every share held`
          : leg.kind === "withdraw" ? `${tokenUnits(leg.amountIn)} USDC from the vault${leg.cap != null ? ` · capped at the vault's max withdraw ${tokenUnits(leg.cap)} USDC` : ''}`
          : `${tokenUnits(leg.amountIn)} USDC`;
        const output = leg.kind === "trustline" ? null : quote?.error ? `Unavailable · ${quote.error}` : quote ? `expected ${units(quote.amountOut, decimals)} ${unit} · minimum ${units(quote.minOut, decimals)} ${unit}${quote.budgeted != null ? ` · budgeted ${units(quote.budgeted, decimals)} ${unit}` : ''}` : 'Quoting…';
        const note = leg.kind === "swap" || leg.kind === "sell" ? ' · Soroswap testnet pool quote; testnet prices are not market prices'
          : leg.kind === "vault" ? ' · shares from preview_deposit, read again at signing' : leg.kind === "redeem" ? ' · USDC from preview_redeem, read again at signing'
          : leg.kind === "withdraw" ? ' · exact USDC; shares burned bounded by preview_withdraw, read again at signing' : '';
        return <div className="execution-quote" key={leg.key} data-leg={leg.key} data-status={state?.status ?? "pending"}>
          <strong>{index + 1}. {legLabel(leg)}</strong>
          <span>{input}{output ? ` → ${output}` : ''}</span>
          <span className="data-note">Contract {contract(leg)}{note}</span>
          <span className="data-note" role="status">{STATUS[state?.status ?? "pending"]}{state?.signed && state.status !== "confirmed" ? <> · <a href={`${net.explorerUrl}/tx/${state.signed.hash}`} target="_blank" rel="noreferrer">{state.signed.hash}</a></> : ''}{state?.error ? ` · ${state.error}` : ''}{state?.note ? ` · ${state.note}` : ''}</span>
          {state?.status === "unknown" && <span className="data-note"><button className="btn ghost" disabled={running} onClick={() => onCheck(leg)}>Check status</button></span>}
        </div>;
      })}
        <div className="execution-quote"><strong>Kept as USDC</strong><span>{tokenUnits(plan.kept)} USDC</span><span className="data-note">USDC buffer, any USDC reserve, rounding dust and trades within tolerance stay in the wallet · no transaction</span></div>
      </div>
      <div className="simulated-execution">
        <button className="btn lg" disabled={blocked} onClick={onRun}><span className="dot" />{running ? 'Executing… follow your wallet' : !plan.legs.length ? 'Nothing to trade' : finished ? 'All legs executed' : started ? 'Continue with the remaining legs' : `Sign and execute ${plan.legs.length} ${plan.legs.length === 1 ? 'leg' : 'legs'}`}<span>→</span></button>
        {unknown.length > 0 && <p className="data-note">A leg's outcome is unknown: check its status before continuing. It is never signed again while its signed transaction could still be included.</p>}
        {plan.legs.some((leg) => (leg.kind === "swap" || leg.kind === "sell") && plan.quotes[leg.key]?.error) && <p className="data-note">A buy the Soroswap API finds no path for is not executed, nor its trustline; the other legs still run, and Continue quotes it again. A sell without a quote, or any other quote failure, stops the run.</p>}
        {runError && <p role="alert" className="data-note" style={{ color: 'var(--bad)' }}>{runError}</p>}
      </div>
      {plan.legs.filter((leg) => states[leg.key]?.status === "confirmed").map((leg) =>
        <Receipt key={leg.key} net={net} label={legLabel(leg)} receipt={states[leg.key].receipt} />)}
    </>}
  </section>;
}

export default function TestnetExecution({ allocation, net, onFinished }) {
  const client = useMemo(() => vaultClient(net), [net]);
  const [store] = useState(() => pendingStore());
  const address = useStellarWalletStore((s) => s.address);
  const networkError = useStellarWalletStore((s) => s.networkError);
  const [plan, setPlan] = useState(null);
  const [states, setStates] = useState({});
  const [open, setOpen] = useState([]);
  const [earlier, setEarlier] = useState([]);
  const [prepError, setPrepError] = useState(null);
  const [runError, setRunError] = useState(null);
  const [running, setRunning] = useState(false);
  // The allocation this panel shows, or null once it unmounts: a run stops when it changes.
  const live = useRef(null);
  const owner = allocation.owner;
  const update = (key, state) => setStates((current) => ({ ...current, [key]: state }));

  useEffect(() => {
    let cancelled = false;
    live.current = allocation;
    setPlan(null); setStates({}); setOpen([]); setEarlier([]); setPrepError(null); setRunError(null);
    prepareRun(client, allocation, net, store).then((result) => {
      if (cancelled) return;
      setPlan(result.plan); setOpen(result.open); setEarlier(result.earlier);
    }).catch((err) => { if (!cancelled) setPrepError(client.vaultError(err)); });
    return () => { cancelled = true; live.current = null; };
  }, [allocation, client, net, store]);

  // Once every leg is done the Builder unlocks its inputs. The run's records
  // stay stored, so the next build still lists them for acknowledgement.
  const finished = !!plan && plan.legs.every((leg) => DONE.has(states[leg.key]?.status));
  useEffect(() => {
    if (finished) onFinished?.();
  }, [finished]);

  const onRun = async () => {
    setRunning(true); setRunError(null);
    try {
      await runLegs({ client, owner, generatedAt: allocation.generated_at, legs: plan.legs, states, store, update, active: () => live.current === allocation });
    } catch (err) {
      setRunError(client.vaultError(err));
    } finally {
      setRunning(false);
    }
  };
  const check = async (record, apply) => {
    setRunning(true); setRunError(null);
    try {
      apply(await resolveRecord(client, store, owner, record));
    } catch (err) {
      setRunError(`Could not read the transaction status (${client.vaultError(err)}).`);
    } finally {
      setRunning(false);
    }
  };
  const onCheck = (leg) => check(states[leg.key].signed, (result) => update(leg.key, checkedState(result, states[leg.key].signed)));
  const onCheckOpen = (record) => check(record, (result) => {
    if (result.status === "PENDING") return;
    setOpen((current) => current.filter((r) => r.hash !== record.hash));
    setEarlier((current) => [...current, { record, result }]);
  });
  // The earlier allocation's records leave the store once acknowledged; their receipts stay shown.
  const onAcknowledge = () => {
    for (const { record } of earlier) store?.drop(owner, record.hash);
    setEarlier((current) => current.map((entry) => ({ ...entry, acknowledged: true })));
  };

  return <ExecutionPanel net={net} owner={owner} plan={plan} states={states} open={open} earlier={earlier} prepError={prepError} runError={runError} running={running}
    storageOk={!!store} networkError={networkError} wrongAccount={address !== owner} onRun={onRun} onCheck={onCheck} onCheckOpen={onCheckOpen} onAcknowledge={onAcknowledge} />;
}
