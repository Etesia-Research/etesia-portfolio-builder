"use client";

import { useEffect, useState } from "react";
import { TOLERANCE, executionQuotes, tokenUnits } from "@/lib/execution";

// The net trades from the selected sources to the targets, simulated: nothing is signed.
const tradeLabel = (row) => row.trade === "sell" ? `Sell · ${row.symbol} → USDC` : row.trade === "buy" ? `Buy · USDC → ${row.symbol}` : `${row.symbol} · no trade`;
const gapOf = (row) => { const diff = BigInt(row.target) - BigInt(row.current); return diff < 0 ? -diff : diff; };

export default function ExecutionSimulation({ allocation, usdcUsd, vaultReason }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [completed, setCompleted] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(null); setError(null); setCompleted(false);
    executionQuotes(allocation, usdcUsd, controller.signal).then(result => {
      if (!controller.signal.aborted) { setPreview(result); setNow(Date.now()); }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [allocation, usdcUsd, refresh]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const expired = preview && now >= preview.expiresAt;
  const ready = preview && !expired && preview.rows.every(row => !row.error);
  return <section className="execution-routes">
    <h4>Execution quotes</h4>
    <p className="data-note">Net trades from the selected sources to the targets · current values at the daily close · sells quoted to USDC, buys from USDC · 0.5% slippage allowance · refresh after 60 seconds. The Etesia-TF row is simulated at $1 per share: {vaultReason}.</p>
    {!preview && !error && <p role="status" className="data-note">Fetching trade quotes…</p>}
    {error && <p role="alert" className="data-note">{error}</p>}
    {preview && <div className="execution-quote-list">{preview.rows.map(row => <div className="execution-quote" key={row.symbol}>
      <strong>{tradeLabel(row)}</strong>
      <span>{row.trade === 'none' ? `Current ${tokenUnits(row.current)} USDC → target ${tokenUnits(row.target)} USDC`
        : `${tokenUnits(row.amountIn)} ${row.trade === 'sell' ? row.symbol : 'USDC'} → ${row.amountOut == null ? 'Unavailable' : `${tokenUnits(row.amountOut)} ${row.trade === 'sell' ? 'USDC' : row.symbol}`}`}</span>
      <span className="data-note">{row.error || (row.kind === 'vault' ? `Simulated at $1 per share · ${vaultReason} · no swap quote` : row.kind === 'cash' ? 'Retained USDC · no swap required' : row.kind === 'none' ? (gapOf(row) < TOLERANCE ? 'Within tolerance, no trade' : 'No trade')
        : `Current ${tokenUnits(row.current)} USDC → target ${tokenUnits(row.target)} USDC · minimum ${tokenUnits(row.minimumOut)} · quoted ${new Date(row.fetchedAt).toLocaleTimeString()}`)}</span>
    </div>)}</div>}
    {expired && !completed && <p role="status" className="data-note">Quotes expired. Refresh to simulate execution.</p>}
    {(preview || error) && <button className="btn ghost" onClick={() => setRefresh(value => value + 1)}>Refresh quotes</button>}
    <div className="simulated-execution">
      <button className="btn lg" disabled={!ready || completed} onClick={() => { if (Date.now() < preview.expiresAt) setCompleted(true); else setNow(Date.now()); }}><span className="dot" />{completed ? 'Execution simulated' : 'Simulate execution'}<span>→</span></button>
      {preview?.rows.some(row => row.error) && <p className="data-note">Every swap needs an available quote to complete the simulation.</p>}
      {completed && <div role="status" className="simulation-receipt"><strong>Simulation complete</strong><p>Simulated {preview.rows.filter(row => row.trade !== 'none').length} net trades using the quoted output quantities above and a simulated $1 per Etesia share. No wallet signature requested, no transactions submitted, and no funds moved.</p><p className="data-note">Outputs assume quoted fills. Minimum amounts reflect the slippage allowance; network fees and vault fees are not modeled.</p></div>}
    </div>
  </section>;
}
