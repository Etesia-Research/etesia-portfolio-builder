"use client";

import { useEffect, useState } from "react";
import { TESTNET } from "@/lib/network";
import { assetSymbol, eventDetail, freshness, readIndexed, supplyAccrual } from "@/lib/vault";

// D5-06: the Etesia-TF catalog entry's indexed testnet vault metrics (D5-05
// routes through /api/quant). Display only: the mainnet allocation and the
// simulated execution keep their simulated $1 share price. Loaded on its own
// (next/dynamic) so the mainnet page does not bundle the testnet vault client.
const REFRESH_MS = 300000; // the indexer takes one snapshot every 300 s

const usable = (view) => view && view.status !== 'error' && view.status !== 'missing';
const num = (value) => value.toLocaleString('en-US', { maximumFractionDigits: 7 });
const pct = (value) => value == null ? '—' : `${(value * 100).toFixed(2)}%`;
const when = (iso) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

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

export function IndexedVaultEntry({ indexed }) {
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
    return <>{when(last.closed_at)} · {last.kind} · {eventDetail(last, history, allocations)} · <a href={`${TESTNET.explorerUrl}/tx/${last.tx_hash}`} target="_blank" rel="noreferrer">{last.tx_hash.slice(0, 8)}…</a></>;
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
  return <section className="product-indexed" aria-label="Etesia-TF testnet vault (pre-reset), indexed metrics">
    <h5>Testnet vault (pre-reset), indexed</h5>
    <dl>
      <Metric label="Share price" views={{ summary }} value={() => summary.share_price_usdc == null ? null : `${num(summary.share_price_usdc)} USDC`} />
      <Metric label="TVL" views={{ summary }} value={() => summary.tvl_usdc == null ? null : `${num(summary.tvl_usdc)} USDC`} />
      <Metric label="Allocation vs target" views={{ allocations }} value={allocation} warning={failed} />
      <Metric label="Last rebalance" views={{ events }} value={rebalance} />
      <Metric label="Blend yield" views={{ summary, allocations, events }} value={blend} />
      <Metric label="Actual return" views={{ performance }} value={() => actual.return_fraction == null ? null : `${pct(actual.return_fraction)} over ${actual.window_days?.toFixed(2) ?? '—'} days · not annualized`} />
      <Metric label="Max drawdown" views={{ history }} value={drawdown} />
    </dl>
    <p className="data-note">Testnet ({TESTNET.epoch}), not a mainnet product. Not used in the allocation or the simulated execution, which price the vault at $1 per share. <a href="/testnet">Testnet vault →</a></p>
  </section>;
}

export default function VaultCatalogEntry() {
  const [indexed, setIndexed] = useState({});
  useEffect(() => {
    let current = true;
    const load = () => readIndexed().then(next => { if (current) setIndexed(next); });
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => { current = false; clearInterval(interval); };
  }, []);
  return <IndexedVaultEntry indexed={indexed} />;
}
