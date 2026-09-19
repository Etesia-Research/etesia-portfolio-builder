"use client";

import { useEffect, useState } from "react";
import { quantRequest, simulationWeights } from "@/lib/quant";

const percent = value => value == null ? '—' : `${(value * 100).toFixed(2)}%`;
const ratio = value => value == null ? '—' : value.toFixed(2);

export function EquityChart({ points }) {
  const [cursor, setCursor] = useState(null);
  const width = 760, height = 270, left = 54, right = 18, top = 18, bottom = 38;
  const values = points.flatMap(point => [point.portfolio, point.xlm]);
  const low = Math.min(...values), high = Math.max(...values);
  const padding = Math.max((high - low) * .08, 1);
  const min = low - padding, max = high + padding;
  const x = index => left + index / (points.length - 1) * (width - left - right);
  const y = value => top + (max - value) / (max - min) * (height - top - bottom);
  const path = key => points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(2)},${y(point[key]).toFixed(2)}`).join(' ');
  const selected = cursor ?? points.length - 1;
  const point = points[selected];
  return <div className="equity-chart">
    <div className="chart-legend"><span className="portfolio-key">Portfolio</span><span className="benchmark-key">XLM buy and hold</span><span>Starting equity = 100 · USD</span></div>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="One-year buy-and-hold equity: allocated portfolio compared with XLM" onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect();
      const position = (event.clientX - rect.left) / rect.width * width;
      setCursor(Math.max(0, Math.min(points.length - 1, Math.round((position - left) / (width - left - right) * (points.length - 1)))));
    }} onPointerLeave={() => setCursor(null)}>
      <title>Portfolio and XLM equity, both normalized to 100</title>
      {[0, 1, 2, 3].map(index => {
        const value = min + (max - min) * index / 3;
        return <g key={index}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className="chart-grid" /><text x={left - 8} y={y(value) + 4} textAnchor="end">{value.toFixed(0)}</text></g>;
      })}
      {[0, Math.floor((points.length - 1) / 2), points.length - 1].map(index => <text key={index} x={x(index)} y={height - 8} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}>{points[index].date}</text>)}
      <path d={path('xlm')} className="benchmark-line" />
      <path d={path('portfolio')} className="portfolio-line" />
      <line x1={x(selected)} x2={x(selected)} y1={top} y2={height - bottom} className="chart-cursor" />
      <circle cx={x(selected)} cy={y(point.portfolio)} r="4" className="portfolio-dot" />
      <circle cx={x(selected)} cy={y(point.xlm)} r="4" className="benchmark-dot" />
    </svg>
    <div className="chart-readout" aria-live="polite">{point.date} · Portfolio {point.portfolio.toFixed(2)} · XLM {point.xlm.toFixed(2)}</div>
    <input type="range" min="0" max={points.length - 1} value={selected} onChange={event => setCursor(Number(event.target.value))} aria-label="Explore historical equity by day" aria-valuetext={`${point.date}: portfolio ${point.portfolio.toFixed(2)}, XLM ${point.xlm.toFixed(2)}`} />
  </div>;
}

export default function AllocationSimulation({ allocation }) {
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult(null); setError(null);
    quantRequest('builder/simulation', {
      weights: simulationWeights(allocation.positions), market_snapshot_id: allocation.market_snapshot_id,
    }, controller.signal).then(value => {
      if (!controller.signal.aborted) setResult(value);
    }).catch(failure => {
      if (!controller.signal.aborted) setError(failure.message);
    });
    return () => controller.abort();
  }, [allocation, retry]);
  const rows = [['Return · 1Y', 'return_1y', percent], ['Sharpe · 1Y', 'sharpe_1y', ratio],
    ['Max drawdown', 'max_drawdown', value => percent(value == null ? null : -value)], ['Calmar · 1Y', 'calmar', ratio]];
  return <section className="portfolio-simulation" aria-label="Historical allocation simulation">
    <h3>One-year allocation simulation</h3>
    <p className="data-note">Today’s calculated weights, including reserves and buffers, applied at the start of the past year and held without rebalancing. Retrospective illustration · USD · 0% risk-free rate · no trading costs.</p>
    {error ? <div role="alert" className="data-note">{error} <button className="btn ghost" onClick={() => setRetry(value => value + 1)}>Retry simulation</button></div>
      : !result ? <p role="status" className="data-note">Calculating performance and equity curves…</p>
      : result.status !== 'available' ? <p role="status" className="data-note">Simulation unavailable: {result.reason}</p>
      : <>
        <table className="performance-table"><caption>Buy-and-hold performance · {result.equity_curve[0].date} to {result.equity_curve.at(-1).date}</caption>
          <thead><tr><th scope="col">Metric</th><th scope="col">Portfolio</th><th scope="col">XLM</th></tr></thead>
          <tbody>{rows.map(([label, key, format]) => <tr key={key}><th scope="row">{label}</th><td>{format(result.portfolio[key])}</td><td>{format(result.benchmark[key])}</td></tr>)}</tbody>
        </table>
        {['portfolio', 'benchmark'].map(key => <div className="data-note" key={key}>{[result[key].sharpe_reason, result[key].calmar_reason].filter(Boolean).map(reason => <div key={reason}>{key === 'portfolio' ? 'Portfolio' : 'XLM'}: {reason}</div>)}</div>)}
        <EquityChart points={result.equity_curve} />
      </>}
  </section>;
}
