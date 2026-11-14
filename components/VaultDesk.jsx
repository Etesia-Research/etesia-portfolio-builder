"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useStellarWalletStore from "@/stores/useStellarWalletStore";
import { initWalletKit, connectWallet, disconnectWallet } from "@/components/stellar/walletKit";
import NetworkSwitch from "@/components/NetworkSwitch";
import SharesInWallet from "@/components/SharesInWallet";
import { builderHref, findVault, vaultHref } from "@/lib/vaults";
import { INDEXED_LIMIT, SHARE_DECIMALS, freshness, fromUnits, minBound, maxBound, sample, supplyAccrual, toUnits, vaultClient } from "@/lib/vault";

// A vault's page on one network (/<slug>/<network>): indexed metrics, wallet,
// trustline, position and the bounded deposit / withdraw / redeem flows. Every
// read, transaction and signature uses that network's deployment only.

const truncateAddr = (a) => (a && a.length > 9 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const usdc = (units, net) => units == null ? '—' : `${fromUnits(units, net.usdc.decimals)} USDC`;
const shares = (units) => units == null ? '—' : `${fromUnits(units, SHARE_DECIMALS)} shares`;
const num = (value, digits = 7) => value == null ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: digits });
const pct = (value) => value == null ? '—' : `${(value * 100).toFixed(2)}%`;
const when = (iso) => iso ? `${iso.slice(0, 16).replace('T', ' ')} UTC` : '—';
const txLink = (hash, net) => <a href={`${net.explorerUrl}/tx/${hash}`} target="_blank" rel="noreferrer">{hash.slice(0, 8)}…</a>;
const usable = (view) => view && view.status !== 'error' && view.status !== 'missing';
const statusColor = (view) => !view || view.status === 'fresh' ? undefined : { color: view.status === 'error' ? 'var(--bad)' : 'var(--warn)' };

function Row({ label, value, note }) {
  return <div className="execution-quote"><strong>{label}</strong><span>{value}</span>{note && <span className="data-note">{note}</span>}</div>;
}

// One indexed view: its freshness label always, its content only when the view has data.
function Panel({ title, view, children }) {
  return <>
    <h4 style={{ marginTop: 24 }}>{title}</h4>
    <p role="status" className="data-note" style={statusColor(view)}>{freshness(view)}</p>
    {usable(view) && children()}
  </>;
}

// One metric: its value only when every view it reads has data (else
// "unavailable", never a stand-in), any warning about it, and each view's freshness label.
function Metric({ label, views, value, warning }) {
  const list = Object.entries(views);
  const shown = list.some(([, view]) => !view) ? '…' : list.every(([, view]) => usable(view)) ? value() ?? 'unavailable' : 'unavailable';
  return <div>
    <dt>{label}</dt>
    <dd>{shown}</dd>
    {warning && <dd className="data-note" data-status="stale">{warning}</dd>}
    {list.map(([name, view]) => <dd key={name} className="data-note" data-status={view?.status ?? 'loading'}>{list.length > 1 ? `${name} · ` : ''}{freshness(view)}</dd>)}
  </div>;
}

// D5-06 key metrics, each with its views' freshness (formerly on the catalog card).
export function VaultMetrics({ indexed, client }) {
  const { net, assetSymbol, eventDetail } = client;
  const { summary, history, allocations, performance, events } = indexed;
  const holdings = usable(allocations) ? allocations.holdings : [];
  const latest = holdings.filter(h => h.assets).at(-1), newest = holdings.at(-1);
  const failed = latest && latest !== newest ? `Latest snapshot at ${when(newest.captured_at)} failed (${Object.entries(newest.errors ?? {}).map(([view, code]) => `${view} ${code}`).join(' · ') || 'holdings() failed'}); showing the last successful snapshot at ${when(latest.captured_at)}.` : null;
  const allocation = () => {
    if (!latest) return null;
    const target = allocations.targets.at(-1);
    const expired = target && target.expiry * 1000 < Date.parse(latest.captured_at) ? ` · target epoch ${target.epoch} expired at ${when(new Date(target.expiry * 1000).toISOString())}` : '';
    const assets = [...new Set([...latest.assets.map(a => a.asset), ...(target?.assets ?? [])])];
    return `${assets.map(asset => {
      const held = latest.assets.find(a => a.asset === asset);
      const i = target ? target.assets.indexOf(asset) : -1;
      return `${held?.symbol ?? assetSymbol(asset)} ${pct(held?.fraction)}${target ? ` vs ${i < 0 ? 0 : target.weights_bps[i] / 100}% target` : ''}`;
    }).join(' · ')}${target ? '' : ' · no published target'} · holdings at ${when(latest.captured_at)}${expired}`;
  };
  const rebalance = () => {
    const last = events.events.filter(e => e.kind === 'plan' || e.kind === 'unwind').at(-1);
    if (!last) return `None in the latest ${events.events.length} indexed events`;
    return <>{when(last.closed_at)} · {last.kind} · {eventDetail(last, history, allocations)} · <a href={`${net.explorerUrl}/tx/${last.tx_hash}`} target="_blank" rel="noreferrer">{last.tx_hash.slice(0, 8)}…</a></>;
  };
  const blend = () => {
    if (latest && !latest.assets.some(a => a.supply > 0)) return 'No Blend supply in the latest snapshot';
    // An asset with no measurable interval has no measured interest: unavailable, not +0.
    const accrual = supplyAccrual(allocations.holdings, events, summary.indexer?.next_ledger).filter(a => a.counted > 0);
    return accrual.length ? accrual.map(a => `${a.symbol} ${a.change >= 0 ? '+' : ''}${num(a.change)} interest over ${a.counted} of ${a.intervals} snapshot intervals from ${when(a.from)} to ${when(a.to)}`).join(' · ') : null;
  };
  // Largest peak-to-trough fall of the indexed share price over the history window.
  const drawdown = () => {
    const points = history.points.filter(p => p.share_price_usdc != null);
    if (points.length < 2) return null;
    let peak = -Infinity, worst = 0;
    for (const p of points) { peak = Math.max(peak, p.share_price_usdc); worst = Math.max(worst, 1 - p.share_price_usdc / peak); }
    return `${pct(worst)} over ${points.length} snapshots from ${when(points[0].captured_at)} to ${when(points.at(-1).captured_at)} · share price, not annualized`;
  };
  const actual = performance?.actual;
  return <section className="vault-metrics" aria-label={`Key metrics, ${net.label} vault (${net.epoch}), indexed`}>
    <h4>Key metrics · {net.label} vault ({net.epoch}), indexed</h4>
    <dl>
      <Metric label="Share price" views={{ summary }} value={() => summary.share_price_usdc == null ? null : `${num(summary.share_price_usdc)} USDC`} />
      <Metric label="TVL" views={{ summary }} value={() => summary.tvl_usdc == null ? null : `${num(summary.tvl_usdc)} USDC`} />
      <Metric label="Allocation vs target" views={{ allocations }} value={allocation} warning={failed} />
      <Metric label="Last rebalance" views={{ events }} value={rebalance} />
      <Metric label="Blend yield" views={{ summary, allocations, events }} value={blend} />
      <Metric label="Actual return" views={{ performance }} value={() => actual.return_fraction == null ? null : `${pct(actual.return_fraction)} over ${actual.window_days?.toFixed(2) ?? '—'} days · not annualized`} />
      <Metric label="Max drawdown" views={{ history }} value={drawdown} />
    </dl>
    <p className="data-note">Not used in the Builder allocation or the simulated execution, which price the vault at $1 per share.</p>
  </section>;
}

// D5-06: vault views from the indexer (D5-05 routes), each labelled fresh, stale, missing or unavailable.
export function IndexedVault({ indexed, client }) {
  const { net, eventDetail, targetLabel } = client;
  const { summary, history, allocations, performance, events } = indexed;
  return <section className="execution-routes">
    <p className="data-note">Read from the Etesia indexer through the quant API, not from the contract. Stale means the view's snapshot or event cursor is older than 15 minutes; missing means the indexer has no data for that view.</p>
    <Panel title="Vault summary" view={summary}>{() => <>
      <div className="execution-quote-list">
        <Row label="TVL" value={`${num(summary.tvl_usdc)} USDC`} note={`total_assets() · snapshot ledger ${summary.ledger ?? '—'}`} />
        <Row label="Share price" value={`${num(summary.share_price_usdc)} USDC`} note="convert_to_assets(1 share), net of accrued fees" />
        <Row label="Share supply" value={`${num(summary.total_supply_shares, 12)} shares`} note="state().supply" />
        <Row label="Deposits" value={summary.paused == null ? '—' : summary.paused ? 'Paused' : 'Open'} note={`state().paused · nonce ${summary.nonce ?? '—'}`} />
        <Row label="Target weights" value={summary.target ? targetLabel(summary.target) : 'No target in the latest snapshot'} note={summary.target ? `epoch ${summary.target.epoch} · expiry ${summary.target.expiry}` : null} />
        {summary.indexer && <Row label="Indexer" value={`${num(summary.indexer.lag_ledgers, 0)} ledgers behind`} note={`${freshness(summary.indexer)} · ${summary.indexer.gaps.length} reported gaps`} />}
      </div>
      {Object.keys(summary.errors ?? {}).length > 0 && <p className="data-note" style={{ color: 'var(--warn)' }}>Failed in the latest snapshot (shown as —): {Object.entries(summary.errors).map(([view, code]) => `${view} ${code}`).join(' · ')}</p>}
    </>}</Panel>

    <Panel title="NAV and share-price history" view={history}>{() => <div className="alloc-table"><table className="performance-table">
      <caption>{history.points.length} snapshots, one every 5 minutes (latest {INDEXED_LIMIT} requested); {Math.min(8, history.points.length)} evenly spaced shown</caption>
      <thead><tr><th scope="col">Snapshot</th><th scope="col">TVL · USDC</th><th scope="col">Share price · USDC</th><th scope="col">Supply · shares</th></tr></thead>
      <tbody>{sample(history.points, 8).map(p => <tr key={p.captured_at}><th scope="row">{when(p.captured_at)}</th><td>{num(p.tvl_usdc)}</td><td>{num(p.share_price_usdc)}</td><td>{num(p.total_supply_shares, 4)}</td></tr>)}</tbody>
    </table></div>}</Panel>

    <Panel title="Allocation history" view={allocations}>{() => {
      const latest = allocations.holdings.filter(h => h.assets).at(-1);
      const newest = allocations.holdings.at(-1);
      const accrual = supplyAccrual(allocations.holdings, events, summary?.indexer?.next_ledger);
      const failed = (h) => Object.entries(h.errors ?? {}).map(([view, code]) => `${view} ${code}`).join(' · ') || 'holdings() failed';
      return <>
        {latest && latest !== newest && <p className="data-note" style={{ color: 'var(--warn)' }}>Latest snapshot at {when(newest.captured_at)} failed ({failed(newest)}); showing the last successful snapshot at {when(latest.captured_at)}.</p>}
        {latest ? <div className="alloc-table"><table className="performance-table">
          <caption>Holdings at {when(latest.captured_at)} · ledger {latest.ledger ?? '—'} · amount = spot + Blend supply + collateral − debt</caption>
          <thead><tr><th scope="col">Asset</th><th scope="col">Amount</th><th scope="col">Blend supply</th><th scope="col">Value · USDC</th><th scope="col">Weight</th></tr></thead>
          <tbody>{latest.assets.map(a => <tr key={a.asset}><th scope="row">{a.symbol}</th><td>{num(a.amount)}</td><td>{num(a.supply)}</td><td>{num(a.value_usdc)}</td><td>{pct(a.fraction)}</td></tr>)}</tbody>
        </table></div> : <p className="data-note" style={{ color: 'var(--warn)' }}>Missing · holdings() failed in every snapshot of this window.</p>}
        {latest && <div className="alloc-table"><table className="performance-table">
          <caption>Weights over time · {Math.min(8, allocations.holdings.length)} of {allocations.holdings.length} snapshots, evenly spaced</caption>
          <thead><tr><th scope="col">Snapshot</th>{latest.assets.map(a => <th scope="col" key={a.asset}>{a.symbol}</th>)}</tr></thead>
          <tbody>{sample(allocations.holdings, 8).map(h => <tr key={h.captured_at}><th scope="row">{when(h.captured_at)}</th>
            {h.assets ? latest.assets.map(a => <td key={a.asset}>{pct(h.assets.find(b => b.asset === a.asset)?.fraction)}</td>) : <td colSpan={latest.assets.length}>— · {failed(h)}</td>}</tr>)}</tbody>
        </table></div>}
        {accrual.map(a => <p className="data-note" key={a.symbol}>Blend interest · supplied {a.symbol} {a.change >= 0 ? '+' : ''}{num(a.change)} over {a.counted} of {a.intervals} snapshot intervals from {when(a.from)} to {when(a.to)}; intervals with a vault supply or withdraw of {a.symbol}, or not covered by the indexed events, are left out.</p>)}
        <div className="alloc-table"><table className="performance-table">
          <caption>Published targets (onchain target events) · latest {Math.min(5, allocations.targets.length)} of {allocations.targets.length}</caption>
          <thead><tr><th scope="col">Published</th><th scope="col">Weights</th><th scope="col">Tx</th></tr></thead>
          <tbody>{allocations.targets.slice(-5).reverse().map(t => <tr key={t.tx_hash}><th scope="row">{when(t.closed_at)}</th><td>{targetLabel(t)}</td><td>{txLink(t.tx_hash, net)}</td></tr>)}</tbody>
        </table></div>
      </>;
    }}</Panel>

    <Panel title="Performance · actual, separate from the backtest" view={performance}>{() => <div className="execution-quote-list">
      <Row label="Actual share-price return" value={pct(performance.actual.return_fraction)} note={`${num(performance.actual.start_share_price_usdc)} → ${num(performance.actual.end_share_price_usdc)} USDC per share · ${performance.actual.window_days == null ? '—' : performance.actual.window_days.toFixed(2)} days from ${performance.actual.start_source ?? '—'} · ${net.label} vault, not annualized`} />
      <Row label="Backtest · simulated" value={performance.backtest ? `cumulative ${pct(performance.backtest.metrics.cumulative_net_return)} · CAGR ${pct(performance.backtest.metrics.cagr)} · max drawdown ${pct(performance.backtest.metrics.maximum_drawdown)}` : 'No published backtest'}
        note={performance.backtest ? `run ${performance.backtest.run_id} · ${performance.backtest.start} to ${performance.backtest.end} · simulated history, not vault results` : null} />
    </div>}</Panel>

    <Panel title="Rebalance and Blend-yield events" view={events}>{() => events.events.length === 0 ? <p className="data-note">No rebalance or yield events indexed yet.</p> : <div className="alloc-table"><table className="performance-table">
      <caption>Newest {Math.min(20, events.events.length)} of the latest {events.events.length} returned ({events.kinds.join(', ')})</caption>
      <thead><tr><th scope="col">Time</th><th scope="col">Event</th><th scope="col">Detail</th><th scope="col">Tx</th></tr></thead>
      <tbody>{events.events.slice(-20).reverse().map(e => <tr key={e.id}><th scope="row">{when(e.closed_at)}</th>
        <td>{['target', 'plan', 'unwind'].includes(e.kind) ? 'Rebalance' : ['position', 'rewards'].includes(e.kind) ? 'Blend yield' : 'Fees'} · {e.kind}</td>
        <td>{eventDetail(e, history, allocations)}</td><td>{txLink(e.tx_hash, net)}</td></tr>)}</tbody>
    </table></div>}</Panel>
  </section>;
}

// The indexed position next to the contract read of the same shares.
export function IndexedPosition({ view, contractShares }) {
  if (!usable(view)) return <Row label="Indexed shares" value="—" note={freshness(view)} />;
  const match = contractShares == null ? null : BigInt(view.shares_atomic) === contractShares;
  return <>
    <Row label="Indexed shares" value={`${num(view.shares, 12)} shares`} note={`${freshness(view)}${match == null ? '' : match ? ' · matches the contract read' : ' · differs from the contract read (indexer lag or a missed event)'}`} />
    <Row label="Indexed value" value={`${num(view.value_usdc)} USDC`} note={`shares × indexed share price ${num(view.share_price_usdc)} USDC (as of ${when(view.share_price_as_of)}) · ${view.flows.length} indexed deposits and withdrawals`} />
  </>;
}

function AmountForm({ client, kind, max, disabled, onSubmit, initial = '' }) {
  const { net, preview, vaultError } = client;
  const [amount, setAmount] = useState(initial);
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  let units = null;
  try { units = amount ? toUnits(amount, net.usdc.decimals) : null; } catch { units = null; }
  const overMax = units != null && max != null && units > max;
  const valid = units != null && units > BigInt(0) && !overMax;
  const onPreview = async () => {
    setError(null);
    try { setQuote({ amount, shares: await preview(kind, amount) }); } catch (err) { setError(vaultError(err)); }
  };
  return <div className="amount-block">
    <div className="amount-input-wrap">
      <span className="pre">AMT</span>
      <input type="text" inputMode="decimal" value={amount} placeholder="0.00" disabled={disabled} onChange={e => { setAmount(e.target.value.replace(/[^0-9.]/g, '')); setError(null); }} />
      <span className="unit">USDC</span>
    </div>
    {max != null && <div className="quick-amounts"><button className="qa" disabled={disabled || max <= BigInt(0)} onClick={() => { setAmount(fromUnits(max, net.usdc.decimals)); setError(null); }}>MAX {usdc(max, net)}</button></div>}
    {overMax && <p role="alert" className="data-note" style={{ color: 'var(--bad)' }}>Above the {kind === 'deposit' ? 'USDC balance' : 'max withdraw'} of {usdc(max, net)}.</p>}
    {quote?.amount === amount && <p className="data-note">Simulation preview · {kind === 'deposit'
      ? `${quote.amount} USDC ≈ ${shares(quote.shares)}; minimum accepted ${shares(minBound(quote.shares))} (0.5% bound)`
      : `${quote.amount} USDC burns ≈ ${shares(quote.shares)}; maximum accepted ${shares(maxBound(quote.shares))} (0.5% bound)`}. Nothing signed yet; the bound is re-read before signing.</p>}
    {error && <p role="alert" className="data-note" style={{ color: 'var(--bad)' }}>{error}</p>}
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <button className="btn ghost" disabled={disabled || !valid} onClick={onPreview}>Preview</button>
      <button className="btn" disabled={disabled || !quote || quote.amount !== amount} onClick={() => onSubmit(amount)}>Sign &amp; {kind}</button>
    </div>
  </div>;
}

// Vault leg handed over from the Builder's allocation (/<slug>/<network>?amount=...).
function allocatedAmount(net) {
  const value = new URLSearchParams(window.location.search).get('amount');
  try { return value && toUnits(value, net.usdc.decimals) > BigInt(0) ? value : null; } catch { return null; }
}

export default function VaultDesk({ slug, network }) {
  const vault = findVault(slug);
  const net = vault.networks[network];
  const client = useMemo(() => vaultClient(net), [net]);
  const { addUsdcTrustline, deposit, exitAll, readIndexed, readPosition, readUsdcLine, vaultError, withdraw } = client;
  const address = useStellarWalletStore(s => s.address);
  const connected = useStellarWalletStore(s => s.connected);
  const connecting = useStellarWalletStore(s => s.connecting);
  const walletKind = useStellarWalletStore(s => s.walletKind);
  const connectError = useStellarWalletStore(s => s.error);
  const networkError = useStellarWalletStore(s => s.networkError);
  const [line, setLine] = useState(null);
  const [position, setPosition] = useState(null);
  const [readError, setReadError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [receipts, setReceipts] = useState([]);
  const [allocated] = useState(() => allocatedAmount(net));
  const [indexed, setIndexed] = useState({});

  useEffect(() => { initWalletKit(net); }, [net]);

  // Only the newest read lands, so a slower read for an earlier address cannot overwrite it.
  const indexedRead = useRef(0);
  const refreshIndexed = useCallback(() => {
    const id = ++indexedRead.current;
    return readIndexed(address).then(next => { if (id === indexedRead.current) setIndexed(next); });
  }, [address, readIndexed]);
  useEffect(() => { setIndexed({}); refreshIndexed(); }, [refreshIndexed]);
  const sharePrice = indexed.summary?.share_price_usdc ?? null;

  const refresh = useCallback(async () => {
    if (!address) return;
    setReadError(null);
    try {
      const [nextLine, nextPosition] = await Promise.all([readUsdcLine(address), readPosition(address)]);
      setLine(nextLine); setPosition(nextPosition);
    } catch (err) { setReadError(vaultError(err)); }
  }, [address, readUsdcLine, readPosition, vaultError]);
  useEffect(() => { setLine(null); setPosition(null); setReceipts([]); setActionError(null); refresh(); }, [refresh]);

  const run = async (label, action) => {
    setBusy(label); setActionError(null);
    try {
      const receipt = await action();
      setReceipts(current => [{ ...receipt, kind: label }, ...current]);
    } catch (err) {
      setActionError(vaultError(err));
    } finally {
      setBusy(null);
      refresh(); refreshIndexed();
    }
  };

  const ready = connected && address && !networkError && !busy;
  const usdcBalance = line?.balance != null ? toUnits(line.balance, net.usdc.decimals) : null;

  return <div id="root">
    <div className="data-banner">{net.label} · deployment {net.epoch} · vault deposits and withdrawals are real {net.label} transactions signed by your wallet{network === 'testnet' ? ' · test funds only' : ''}</div>
    <header className="masthead">
      <div className="left">
        <div className="row"><a href={builderHref(network)}>← Portfolio Atelier</a></div>
        <div className="row" style={{ marginTop: 6 }}><NetworkSwitch active={network} href={(next) => vaultHref(vault, next)} /></div>
        <div className="row" style={{ marginTop: 6 }}><span>{net.label} · vault {truncateAddr(net.vault)}</span></div>
      </div>
      <div className="center">
        <div className="eyebrow">— Etesia Research Bulletin —</div>
        <h1>Portfolio Atelier</h1>
        <div className="sub">{vault.name} flagship vault on {net.label}.</div>
      </div>
      <div className="right">
        {connected && address ? <>
          <div className="vol">CONNECTED — {walletKind || 'Wallet'}</div>
          <div style={{ marginTop: 4 }}>{truncateAddr(address)}</div>
          <button onClick={disconnectWallet} className="mono" style={{ marginTop: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 10, letterSpacing: '0.12em', color: 'var(--ink-3)', textDecoration: 'underline' }}>↪ disconnect</button>
        </> : <><div className="vol">UNCONNECTED</div><div style={{ marginTop: 4 }}>—</div></>}
      </div>
    </header>
    {networkError && <p role="alert" className="data-banner" style={{ color: 'var(--bad)' }}>{networkError} Switch networks in the wallet, then return to this tab to re-check.</p>}

    <div className="section-bar"><span className="num-mark">01</span><h2>Vault — indexed metrics</h2><span className="meta">Indexer · flagship vault</span></div>
    <VaultMetrics indexed={indexed} client={client} />
    <button className="btn ghost" onClick={refreshIndexed}>Refresh indexed data</button>

    <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">02</span><h2>Wallet — connect on {network}</h2><span className="meta">Freighter/Varial · xBull</span></div>
    {!(connected && address) ? <section className="execution-routes">
      <p className="data-note">The wallet must be set to {net.label} ("{net.passphrase}"). Freighter/Varial reports its network and signing is blocked on a mismatch. With xBull, every signature request pins the {net.label} passphrase.</p>
      <button className="btn lg" disabled={connecting} onClick={() => connectWallet().catch(() => {})}><span className="dot" />{connecting ? 'Connecting… approve in your wallet' : 'Connect wallet'}<span>→</span></button>
      {connectError && <p role="alert" className="data-note" style={{ color: 'var(--bad)' }}>{connectError}</p>}
    </section> : <>
      <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">03</span><h2>Onboarding — USDC trustline</h2><span className="meta">Horizon · {net.label}</span></div>
      <section className="execution-routes">
        {!line && !readError && <p role="status" className="data-note">Reading the account from Horizon…</p>}
        {line && <div className="execution-quote-list">
          <Row label="Account" value={line.funded ? `Funded · ${line.xlm} XLM` : `Not funded on ${net.label}`} note={line.funded ? null : `Fund the account with ${net.label} XLM${network === 'testnet' ? ' (Friendbot)' : ''} before adding the trustline.`} />
          <Row label="USDC trustline" value={line.trustline ? `Present · ${line.balance} USDC` : 'Missing'} note={`${net.usdc.code}:${truncateAddr(net.usdc.issuer)}${net.assets.USDC.stand_in ? ` · ${net.assets.USDC.stand_in}` : ''}`} />
        </div>}
        {line?.funded && !line.trustline && <button className="btn" disabled={!ready} onClick={() => run('trustline', () => addUsdcTrustline(address))}>Sign &amp; add USDC trustline</button>}
        {line?.trustline && net.faucetUrl && <p className="data-note">Test USDC comes from Blend's testnet faucet: <a href={net.faucetUrl} target="_blank" rel="noreferrer">{net.faucetUrl}</a>. Refresh after claiming.</p>}
      </section>

      <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">04</span><h2>Position — shares and liquidity</h2><span className="meta">{position ? `Read from contract at ledger ${position.ledger}` : 'Contract read'}</span></div>
      <section className="execution-routes">
        {!position && !readError && <p role="status" className="data-note">Reading the vault…</p>}
        {readError && <p role="alert" className="data-note" style={{ color: 'var(--bad)' }}>{readError}</p>}
        {position && <div className="execution-quote-list">
          <Row label="Vault shares" value={shares(position.shares)} note="balance(owner) · contract token, 12 decimals" />
          <Row label="Share value" value={usdc(position.value, net)} note="convert_to_assets(balance)" />
          <Row label="Max withdraw" value={usdc(position.maxWithdraw, net)} note="max_withdraw(owner) · capped at liquid USDC" />
          <Row label="Vault liquid USDC" value={usdc(position.liquid, net)} note="liquid_assets()" />
          <Row label="Deposits" value={position.paused ? 'Paused' : 'Open'} note="state().paused" />
          <IndexedPosition view={indexed.position} contractShares={position.shares} />
        </div>}
        <button className="btn ghost" disabled={!!busy} onClick={() => { refresh(); refreshIndexed(); }}>Refresh</button>
      </section>

      <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">05</span><h2>Deposit and withdraw</h2><span className="meta">Preview → simulate → sign → submit → confirm</span></div>
      <section className="funding-panel">
        <div className="col">
          <h5>① Deposit USDC · deposit_bounded</h5>
          {allocated && <p className="data-note">Prefilled with {allocated} USDC{sharePrice ? ` ≈ ${num(Number(allocated) / sharePrice)} shares at the indexed share price of ${num(sharePrice)} USDC (${freshness(indexed.summary)})` : ` · indexed share price unavailable (${freshness(indexed.summary)})`}; the deposit preview reads the exact shares from the contract.</p>}
          <AmountForm client={client} kind="deposit" initial={allocated ?? ''} max={usdcBalance} disabled={!ready || !line?.trustline || position?.paused} onSubmit={amount => run('deposit', () => deposit(address, amount))} />
          {position?.paused && <p className="data-note">Deposits are paused on this vault.</p>}
        </div>
        <div className="col">
          <h5>② Partial withdraw · withdraw_bounded</h5>
          <AmountForm client={client} kind="withdraw" max={position?.maxWithdraw ?? null} disabled={!ready || !position || position.maxWithdraw <= BigInt(0)} onSubmit={amount => run('withdraw', () => withdraw(address, amount))} />
          <h5 style={{ marginTop: 24 }}>③ Full exit · redeem_bounded</h5>
          <p className="data-note">Redeems the whole share balance for USDC, accepting at least 0.5% below preview_redeem. It fails with a liquidity error if the vault's liquid USDC is below the value of your shares.</p>
          <button className="btn" disabled={!ready || !position || position.shares <= BigInt(0)} onClick={() => run('exit', () => exitAll(address))}>Sign &amp; redeem all shares</button>
        </div>
      </section>
      {busy && <p role="status" className="data-note">Working on {busy}: simulating, then waiting for your wallet signature, then confirming onchain (up to about five minutes)…</p>}
      {actionError && <p role="alert" className="data-note" style={{ color: 'var(--bad)' }}>{actionError}</p>}

      {receipts.length > 0 && <>
        <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">06</span><h2>Receipts</h2><span className="meta">{net.label} transactions, not simulations</span></div>
        {receipts.map(receipt => <div key={receipt.hash} role="status" className="tx-receipt">
          <strong>{net.label} transaction, not a simulation · {receipt.action}</strong>
          <p>Confirmed in ledger {receipt.ledger}{receipt.returned ? ` · contract returned ${receipt.returned}` : ''}.</p>
          <p className="data-note">Hash <a href={`${net.explorerUrl}/tx/${receipt.hash}`} target="_blank" rel="noreferrer">{receipt.hash}</a></p>
        </div>)}
        {receipts.some(receipt => receipt.kind === 'deposit') && <SharesInWallet net={net} />}
      </>}
    </>}

    {/* The detailed indexed views come after the deposit desk, so the deposit is reached directly. */}
    <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">{!(connected && address) ? '03' : receipts.length ? '07' : '06'}</span><h2>Vault — indexed history and events</h2><span className="meta">Indexer · flagship vault</span></div>
    <IndexedVault indexed={indexed} client={client} />
    <footer className="data-footer"><span>ETESIA RESEARCH</span><span>{net.label} · vault {net.vault} · position values read from the contract · vault metrics from the indexer, labelled by freshness</span></footer>
  </div>;
}
