"use client";

import { useEffect, useState } from "react";
import { executionQuotes, tokenUnits } from "@/lib/execution";

export default function ExecutionSimulation({ allocation, funding, usdcUsd }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [completed, setCompleted] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null); setError(null); setCompleted(false);
    executionQuotes(allocation, funding, usdcUsd, controller.signal).then(result => {
      if (!controller.signal.aborted) { setPreview(result); setNow(Date.now()); }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [allocation, funding, usdcUsd, refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = preview && now >= preview.expiresAt;
  const ready = preview && !expired && preview.rows.every(row => !row.error);
  return <section className="execution-routes">
    <h4>Execution quotes</h4>
    <p className="data-note">Actual input amounts · quotes via USDC · 0.5% slippage allowance · refresh after 60 seconds. Etesia shares are assumed to cost $1 each.</p>
    {!preview && !error && <p role="status" className="data-note">Fetching trade quotes…</p>}
    {error && <p role="alert" className="data-note">{error}</p>}
    {preview?.funding && <p className="data-note">Funding: {tokenUnits(preview.funding.amountIn)} {funding.symbol} → {tokenUnits(preview.funding.amountOut)} USDC (minimum {tokenUnits(preview.funding.minimumOut)}). Quoted {new Date(preview.funding.fetchedAt).toLocaleTimeString()}.</p>}
    {preview && <div className="execution-quote-list">{preview.rows.map(row => <div className="execution-quote" key={row.id}>
      <strong>{row.id.replaceAll('_', ' ').toUpperCase()}</strong>
      <span>{tokenUnits(row.amountIn)} USDC → {row.amountOut == null ? 'Unavailable' : `${tokenUnits(row.amountOut)} ${row.symbol}`}</span>
      <span className="data-note">{row.error || (row.kind === 'vault' ? 'Assumed $1/share · no swap quote' : row.kind === 'cash' ? 'Retained USDC · no swap required' : `Minimum ${tokenUnits(row.minimumOut)} · quoted ${new Date(row.fetchedAt).toLocaleTimeString()}`)}</span>
    </div>)}</div>}
    {expired && !completed && <p role="status" className="data-note">Quotes expired. Refresh to simulate execution.</p>}
    {(preview || error) && <button className="btn ghost" onClick={() => setRefresh(value => value + 1)}>Refresh quotes</button>}
    <div className="simulated-execution">
      <button className="btn lg" disabled={!ready || completed} onClick={() => { if (Date.now() < preview.expiresAt) setCompleted(true); else setNow(Date.now()); }}><span className="dot" />{completed ? 'Execution simulated' : 'Simulate execution'}<span>→</span></button>
      {preview?.rows.some(row => row.error) && <p className="data-note">Every swap needs an available quote to complete the simulation.</p>}
      {completed && <div role="status" className="simulation-receipt"><strong>Simulation complete</strong><p>Simulated {preview.rows.length} positions using the quoted output quantities above and $1 per Etesia share. No wallet signature requested, no transactions submitted, and no funds moved.</p><p className="data-note">Outputs assume quoted fills. Minimum amounts reflect the slippage allowance; network fees and vault fees are not modeled.</p></div>}
    </div>
  </section>;
}
