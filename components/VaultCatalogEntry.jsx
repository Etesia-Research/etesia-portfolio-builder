"use client";

import { useEffect, useState } from "react";
import { quantRequest } from "@/lib/quant";

// The vault card's two indexed figures on the active network. Every other
// indexed metric is on the vault page. Loaded on its own (next/dynamic) and
// only in a network mode where the vault is deployed.
const REFRESH_MS = 300000; // the indexer takes one snapshot every 300 s

const num = (value, digits) => value.toLocaleString('en-US', { maximumFractionDigits: digits });
const when = (iso) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

// A figure only from a usable summary (else —, never a stand-in) and one short freshness line.
export function VaultFigures({ summary }) {
  const usable = summary && summary.status !== 'error' && summary.status !== 'missing';
  const figure = (value, digits) => !summary ? '…' : usable && value != null ? num(value, digits) : '—';
  const note = !summary ? 'Reading the indexer…'
    : summary.status === 'error' ? 'Indexer unavailable'
    : summary.status === 'missing' ? 'Missing · no indexed data yet'
    : `${summary.status === 'stale' ? 'Stale' : 'Fresh'} · indexed ${when(summary.as_of)}`;
  return <>
    <div className="stats">
      <div><div className="stat-label">Share price · USDC</div><div className="stat-val">{figure(summary?.share_price_usdc, 4)}</div></div>
      <div><div className="stat-label">TVL · USDC</div><div className="stat-val">{figure(summary?.tvl_usdc, 2)}</div></div>
    </div>
    <div className="data-note" data-status={summary?.status ?? 'loading'}>{note}</div>
  </>;
}

export default function VaultCatalogEntry({ indexer }) {
  const [summary, setSummary] = useState(null);
  useEffect(() => {
    let current = true;
    const load = () => quantRequest(`${indexer}/summary`)
      .catch(error => ({ status: 'error', error: error.message }))
      .then(next => { if (current) setSummary(next); });
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => { current = false; clearInterval(interval); };
  }, [indexer]);
  return <VaultFigures summary={summary} />;
}
