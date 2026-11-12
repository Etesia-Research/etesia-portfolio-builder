"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useStellarWalletStore from "@/stores/useStellarWalletStore";
import { API_TX_SECONDS, DEADLINE_SECONDS, SHARE_DECIMALS, fromUnits, minBound, vaultClient } from "@/lib/vault";
import { atomicAmount, runKeep, testnetCheck, testnetLegs, tokenUnits, xlmFundingIn } from "@/lib/execution";

// Testnet execution of a Builder allocation: every leg is a real Stellar testnet
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
const POSITION = { xlm: "XLM", xlm_buffer: "XLM fee buffer", ustry: "USTRY reserve", "etesia-tf": "ETESIA-TF" };

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

export function legLabel(leg) {
  const held = leg.ids.map((id) => POSITION[id] ?? id.toUpperCase()).join(", ");
  const standIn = leg.symbol === "tRESERVE" ? " · USTRY stand-in on testnet" : "";
  if (leg.kind === "funding") return "Funding swap · XLM → USDC";
  if (leg.kind === "trustline") return `${leg.symbol} trustline · changeTrust${standIn}`;
  if (leg.kind === "swap") return `USDC → ${leg.symbol} swap · ${held}${standIn}`;
  return `${leg.symbol} vault deposit · deposit_bounded`;
}

const returnsFor = (client, leg) => leg.kind === "vault" ? client.SHARES : leg.kind === "trustline" ? { decimals: 7, unit: leg.symbol } : client.swapReturns(leg.path);

// Expected and minimum output of each leg before signing: Soroswap API quotes
// for swaps, with the API's otherAmountThreshold as the minimum (the funding
// swap also shows the USDC the plan was budgeted from, the least minimum it is
// signed with), the vault's preview for the deposit.
export async function quoteLegs(client, legs) {
  const entries = await Promise.all(legs.map(async (leg) => {
    try {
      if (leg.kind === "trustline") return [leg.key, null];
      if (leg.kind === "vault") {
        const shares = await client.preview("deposit", fromUnits(leg.amountIn, client.net.usdc.decimals));
        return [leg.key, { amountOut: shares, minOut: minBound(shares) }];
      }
      const { amountOut, minOut } = await client.quoteSwap(leg.amountIn, leg.path);
      return [leg.key, { amountOut, minOut, ...(leg.kind === "funding" && { budgeted: leg.minOut }) }];
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

// Before anything can be signed: resolve the owner's stored envelopes (an
// unresolved one blocks the run; one that may have executed is listed as an
// earlier allocation's), read the account, fix the USDC capital (with XLM
// funding, 0.5% below the funding quote's minimum on the XLM left after the
// run's keep-back, so the swap's re-quote at signing may be up to 0.5% lower
// and its built minimum still covers the capital), plan and quote the legs.
export async function prepareRun(client, allocation, net, store) {
  const { owner, funding } = allocation;
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
  let capital, fundingIn;
  if (funding.symbol === "XLM") {
    fundingIn = xlmFundingIn(atomicAmount(funding.amount), testnetLegs(allocation, BigInt(0), net).legs, account);
    const { minOut } = await client.quoteSwap(fundingIn, [net.assets.XLM.address, net.usdc.contract]);
    capital = minBound(minOut);
  } else capital = atomicAmount(funding.amount);
  const { legs, kept } = testnetLegs(allocation, capital, net, fundingIn);
  const quotes = await quoteLegs(client, legs);
  return { plan: { legs, kept, capital, quotes, check: testnetCheck(legs, account), xlmKept: runKeep(legs, account), entered: funding.amount }, open, earlier };
}

async function executeLeg(client, owner, leg, account, onSigned) {
  if (leg.kind === "trustline") return leg.symbol in account.lines ? null : client.addUsdcTrustline(owner, leg.symbol, onSigned);
  if (leg.amountIn <= BigInt(0)) throw new Error("The leg amount is below one atomic unit.");
  if (leg.kind === "vault") return client.deposit(owner, fromUnits(leg.amountIn, client.net.usdc.decimals), onSigned);
  // Quoted again and built by the Soroswap API right before the signature; a
  // swap without a quote is not executed. The funding swap's built minimum
  // must cover the USDC the allocation was budgeted from.
  return client.swapExactIn(owner, leg.amountIn, leg.path, onSigned, leg.kind === "funding" ? leg.minOut : BigInt(0));
}

// Run the legs that are not done, in order, stopping at the first failure or
// unknown outcome. A swap the Soroswap API finds no path for is not executed,
// nor its trustline, and the other legs still run; any other quote failure
// (rate limit, API outage, missing key) stops the run. Before each leg the run stops when
// it is no longer active (the panel left or the allocation changed) and refuses
// while the store holds a record from outside this run. update(key, state)
// records each leg's state.
export async function runLegs({ client, owner, generatedAt, legs, states, store, update, active = () => true }) {
  const account = await client.readUsdcLine(owner);
  const pending = legs.filter((leg) => !DONE.has(states[leg.key]?.status));
  const unquoted = new Set();
  for (const leg of pending.filter((l) => l.kind === "swap")) {
    try {
      await client.quoteSwap(leg.amountIn, leg.path);
    } catch (err) {
      if (!err?.noPath) throw new Error(`${client.vaultError(err)} Nothing was signed; run again once the Soroswap API answers.`);
      unquoted.add(leg.symbol);
      update(leg.key, { status: "unavailable", error: client.vaultError(err) });
    }
  }
  for (const leg of pending.filter((l) => l.kind === "trustline" && unquoted.has(l.symbol)))
    update(leg.key, { status: "unavailable", error: `not added: the USDC → ${leg.symbol} swap has no quote` });
  const remaining = pending.filter((leg) => !((leg.kind === "swap" || leg.kind === "trustline") && unquoted.has(leg.symbol)));
  const problem = testnetCheck(remaining, account);
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

// Presentational: the leg table, blocks, actions and receipts.
export function ExecutionPanel({ net, owner, plan, states, open, earlier, prepError, runError, running, storageOk, networkError, wrongAccount, onRun, onCheck, onCheckOpen, onAcknowledge }) {
  const unknown = plan ? plan.legs.filter((leg) => states[leg.key]?.status === "unknown") : [];
  const started = plan ? plan.legs.some((leg) => states[leg.key]) : false;
  const finished = plan ? plan.legs.every((leg) => DONE.has(states[leg.key]?.status)) : false;
  const repeats = earlier.filter(({ result, acknowledged }) => !acknowledged && MAY_HAVE_EXECUTED.has(result.status));
  const blocked = running || !plan || finished || open.length > 0 || unknown.length > 0 || repeats.length > 0 || !!networkError || wrongAccount;
  const contract = (leg) => leg.kind === "vault" ? net.vault : leg.kind === "trustline" ? net.assets[leg.symbol].classic : net.router;
  return <section className="execution-routes">
    <h4>Execution — Stellar testnet transactions signed by your wallet · test funds only</h4>
    <p className="data-note">One transaction per leg, each signed in your wallet: the funding swap (with XLM funding), trustlines for received assets, Soroswap swaps quoted and built by the Soroswap Aggregator API on its testnet Soroswap pools (each invokes the router {net.router}), then the vault deposit. Soroswap testnet pool quote; testnet prices are not market prices. A swap's minimum output is the API's minimum at {net.soroswap.slippageBps / 100}% slippage (the funding swap is signed only while that minimum covers its budgeted USDC) and the deposit's allows 0.5% below its preview. Each swap is quoted and built again right before its signature and expires {API_TX_SECONDS} seconds after it is built; the other transactions expire after {DEADLINE_SECONDS} seconds.</p>
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
      {plan.check && <p role="alert" className="data-note" style={{ color: 'var(--warn)' }}>{plan.check}</p>}
      <div className="execution-quote-list">{plan.legs.map((leg, index) => {
        const quote = plan.quotes[leg.key], state = states[leg.key];
        const decimals = leg.kind === "vault" ? SHARE_DECIMALS : 7, unit = leg.kind === "vault" ? "shares" : leg.symbol;
        const input = leg.kind === "trustline" ? "No amount · raises the account's minimum balance by 0.5 XLM"
          : leg.kind === "funding" ? `${tokenUnits(leg.amountIn)} XLM${leg.amountIn !== atomicAmount(plan.entered) ? ` of the ${plan.entered} XLM entered` : ''} · keeps ${tokenUnits(plan.xlmKept)} XLM back for fees and the account reserve`
          : `${tokenUnits(leg.amountIn)} USDC`;
        const output = leg.kind === "trustline" ? null : quote?.error ? `Unavailable · ${quote.error}` : quote ? `expected ${units(quote.amountOut, decimals)} ${unit} · minimum ${units(quote.minOut, decimals)} ${unit}${quote.budgeted != null ? ` · budgeted ${units(quote.budgeted, decimals)} ${unit}` : ''}` : 'Quoting…';
        return <div className="execution-quote" key={leg.key} data-leg={leg.key} data-status={state?.status ?? "pending"}>
          <strong>{index + 1}. {legLabel(leg)}</strong>
          <span>{input}{output ? ` → ${output}` : ''}</span>
          <span className="data-note">Contract {contract(leg)}{leg.kind === "swap" || leg.kind === "funding" ? ' · Soroswap testnet pool quote; testnet prices are not market prices' : leg.kind === "vault" ? ' · shares from preview_deposit, read again at signing' : ''}</span>
          <span className="data-note" role="status">{STATUS[state?.status ?? "pending"]}{state?.signed && state.status !== "confirmed" ? <> · <a href={`${net.explorerUrl}/tx/${state.signed.hash}`} target="_blank" rel="noreferrer">{state.signed.hash}</a></> : ''}{state?.error ? ` · ${state.error}` : ''}{state?.note ? ` · ${state.note}` : ''}</span>
          {state?.status === "unknown" && <span className="data-note"><button className="btn ghost" disabled={running} onClick={() => onCheck(leg)}>Check status</button></span>}
        </div>;
      })}
        <div className="execution-quote"><strong>Kept as USDC</strong><span>{tokenUnits(plan.kept)} USDC</span><span className="data-note">USDC buffer, any USDC reserve and rounding dust stay in the wallet · no transaction</span></div>
      </div>
      <div className="simulated-execution">
        <button className="btn lg" disabled={blocked} onClick={onRun}><span className="dot" />{running ? 'Executing… follow your wallet' : finished ? 'All legs executed' : started ? 'Continue with the remaining legs' : `Sign and execute ${plan.legs.length} ${plan.legs.length === 1 ? 'leg' : 'legs'}`}<span>→</span></button>
        {unknown.length > 0 && <p className="data-note">A leg's outcome is unknown: check its status before continuing. It is never signed again while its signed transaction could still be included.</p>}
        {plan.legs.some((leg) => leg.kind === "swap" && plan.quotes[leg.key]?.error) && <p className="data-note">A swap the Soroswap API finds no path for is not executed, nor its trustline; the other legs still run, and Continue quotes it again. Any other quote failure stops the run.</p>}
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
