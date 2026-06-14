"use client";

// Ported verbatim from the bundled Etesia builder (etesia-ui-extracted/App.jsx).
// Only changes vs the original: "use client"; React globals -> ES imports; the
// coin/corr data is imported statically instead of read from <script> tags via
// document.getElementById (so it works without the browser DOM); the App
// component is the default export wrapped in <div id="root">; the
// ReactDOM.createRoot(...) bootstrap is removed (Next mounts it).
//
// Risk-model inputs (vol, sharpe, corr) are STATIC research inputs and the
// risk-parity solver below is byte-for-byte identical to the original. Live
// wiring: wallet (Step 3), Horizon balances (Step 4), Soroswap prices (Step 5).
// The `holding` field in coin-data.json is the bundle's sample data and is no
// longer read — holdings come from useBalanceStore (real Horizon balances).

import { useState, useMemo, useEffect } from "react";
import COINS from "@/data/coin-data.json";
import CORR from "@/data/corr-data.json";
import useStellarWalletStore from "@/stores/useStellarWalletStore";
import { initWalletKit, connectWallet, disconnectWallet } from "@/components/stellar/walletKit";
import usePriceStore from "@/stores/usePriceStore";
import { fetchLivePrices } from "@/lib/prices";
import useBalanceStore from "@/stores/useBalanceStore";
import { fetchHoldings } from "@/lib/balances";

const COIN_BY_TK = Object.fromEntries(COINS.map(c => [c.tk, c]));

// Existing truncation style, e.g. GA7Q…3K2M (4 + … + 4).
const truncateAddr = (a) => (a && a.length > 9 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

// Live Soroswap price where reliable (store), else the static research price.
const priceOf = (bySymbol, tk) => bySymbol[tk]?.price ?? COIN_BY_TK[tk].price;

const fmtMcap = (n) => {
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};
const fmtUsd = (n, dp=2) => {
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(2)}K`;
  return `$${n.toLocaleString(undefined, {minimumFractionDigits: dp, maximumFractionDigits: dp})}`;
};
const fmtUsdK = (n) => n >= 1000 ? `$${(n/1000).toFixed(1)}K` : `$${n.toFixed(0)}`;
const sharpeColor = (s) => s >= 1.0 ? 'good' : s >= 0.3 ? '' : s >= 0 ? 'warn' : 'bad';
const corrColor = (c) => c < 0.15 ? 'good' : c < 0.45 ? 'warn' : 'bad';

// ---------- Risk parity solver (ERC) ----------
function riskParity(tickers) {
  const n = tickers.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  const vols = tickers.map(t => COIN_BY_TK[t].vol);
  const cov = tickers.map((ti, i) =>
    tickers.map((tj, j) => CORR[ti][tj] * vols[i] * vols[j])
  );
  let w = Array(n).fill(1/n);
  for (let iter = 0; iter < 200; iter++) {
    const mwij = w.map((_, i) => w.reduce((s, wj, j) => s + wj * cov[i][j], 0));
    const portVar = w.reduce((s, wi, i) => s + wi * mwij[i], 0);
    const portVol = Math.sqrt(portVar);
    const rc = w.map((wi, i) => wi * mwij[i] / portVol);
    const target = portVol / n;
    const newW = w.map((wi, i) => Math.max(1e-6, wi * target / Math.max(rc[i], 1e-8)));
    const sumW = newW.reduce((s, x) => s + x, 0);
    const wNorm = newW.map(x => x/sumW);
    const delta = wNorm.reduce((s, x, i) => s + Math.abs(x - w[i]), 0);
    w = wNorm;
    if (delta < 1e-7) break;
  }
  return w;
}

// avg correlation of a new candidate vs current basket (excluding stables for cleanliness)
function avgCorrelation(ticker, basket) {
  if (!basket.length) return null;
  const sum = basket.reduce((s, b) => s + Math.abs(CORR[ticker][b]), 0);
  return sum / basket.length;
}

function portfolioVol(tickers, weights) {
  if (!tickers.length) return 0;
  const vols = tickers.map(t => COIN_BY_TK[t].vol);
  let v = 0;
  for (let i = 0; i < tickers.length; i++) {
    for (let j = 0; j < tickers.length; j++) {
      v += weights[i] * weights[j] * vols[i] * vols[j] * CORR[tickers[i]][tickers[j]];
    }
  }
  return Math.sqrt(Math.max(0, v));
}

function portfolioSharpe(tickers, weights) {
  // weighted avg sharpe penalised slightly by diversification (informal proxy)
  if (!tickers.length) return 0;
  const w = weights.reduce((s, wi, i) => s + wi * COIN_BY_TK[tickers[i]].sharpe, 0);
  return w;
}

// ---------- Components ----------

function Masthead({ wallet, onDisconnect }) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: '2-digit' });
  const bySymbol = usePriceStore(s => s.bySymbol);
  const pricesLoading = usePriceStore(s => s.loading);
  const lastUpdated = usePriceStore(s => s.lastUpdated);
  const liveCount = Object.values(bySymbol).filter(p => p.live).length;
  const pricesStatus = lastUpdated
    ? `prices · Soroswap · ${liveCount}/12 live · ${new Date(lastUpdated).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
    : pricesLoading ? 'prices · loading…' : 'prices · —';
  return (
    <header className="masthead">
      <div className="left">
        <div className="row">
          <span>{today}</span>
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          {/* TODO(Step 4): replace with the real latest ledger sequence from Horizon */}
          <span>Stellar mainnet</span>
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          <span>{pricesStatus}</span>
        </div>
      </div>
      <div className="center">
        <div className="eyebrow">— Etesia Research Bulletin —</div>
        <h1>Portfolio Atelier</h1>
        <div className="sub">A workbench for risk-parity construction on the Stellar network.</div>
      </div>
      <div className="right">
        {wallet ? (
          <>
            <div className="vol">CONNECTED — {wallet.kind}</div>
            <div style={{ marginTop: 4 }}>{wallet.addr}</div>
            <div style={{ marginTop: 4 }}>balance: {wallet.balance != null ? fmtUsd(wallet.balance, 2) : '—'} <span style={{ color: 'var(--good)' }}>●</span></div>
            <button onClick={onDisconnect} className="mono" style={{ marginTop: 6, background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', fontSize: 10, letterSpacing: '0.12em', color: 'var(--ink-3)', textDecoration: 'underline' }}>
              ↪ disconnect
            </button>
          </>
        ) : (
          <>
            <div className="vol">UNCONNECTED</div>
            <div style={{ marginTop: 4 }}>—</div>
          </>
        )}
      </div>
    </header>
  );
}

function Ticker() {
  // Soroswap gives spot price only (no 24h change) — show live price + a live/
  // static marker, never a fabricated %. (was: chg faked from sharpe.)
  const bySymbol = usePriceStore(s => s.bySymbol);
  const lane = (
    <div className="lane">
      {COINS.concat(COINS).map((c, i) => {
        const pd = bySymbol[c.tk];
        const price = pd?.price ?? c.price;
        const live = !!pd?.live;
        return (
          <span key={i} className="it">
            <strong>{c.tk}</strong>&nbsp;{fmtUsd(price, price < 1 ? 4 : 2)}&nbsp;
            <span style={{ color: live ? 'var(--good)' : 'var(--ink-3)', fontSize: 10, letterSpacing: '0.08em' }}>
              {live ? '● live' : 'static'}
            </span>
          </span>
        );
      })}
    </div>
  );
  return <div className="ticker">{lane}{lane}</div>;
}

function ConnectScreen({ onConnect, connecting, error }) {
  const wallets = [
    { kind: 'Freighter', sub: 'Browser extension', glyph: '◉' },
    { kind: 'Albedo', sub: 'Web signer', glyph: '◐' },
    { kind: 'xBull', sub: 'Multi-platform', glyph: '◑' },
    { kind: 'Lobstr Vault', sub: 'Mobile', glyph: '◯' },
  ];
  return (
    <section className="connect-stage fade-in">
      <div>
        <div className="stamp">Step 01 — Authentication</div>
        <h3>Begin by <em>connecting</em><br/>your Stellar wallet.</h3>
        <p>
          Etesia constructs a custodian-free, risk-parity allocation across the asset universe of
          Soroswap. Trades route through the AMM at execution time — your keys never leave the wallet.
        </p>
        <p className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 14, letterSpacing: '0.06em' }}>
          Network · Stellar Mainnet &nbsp;·&nbsp; Router · Soroswap v2.3 &nbsp;·&nbsp; Audited
        </p>
        {connecting && (
          <p className="mono" style={{ fontSize: 11, color: 'var(--ink-2)', marginTop: 12, letterSpacing: '0.04em' }}>
            Connecting… approve the request in your wallet.
          </p>
        )}
        {error && (
          <p className="mono" style={{ fontSize: 11, color: 'var(--bad)', marginTop: 12, letterSpacing: '0.04em' }}>
            {error}
          </p>
        )}
      </div>
      <div className="wallets">
        {wallets.map(w => (
          <button key={w.kind} className="wallet-card" onClick={() => onConnect(w.kind)} disabled={connecting}>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <span className="ar">{w.glyph}</span>
              <div style={{ textAlign: 'left' }}>
                <div className="nm">{w.kind}</div>
                <div className="mono" style={{ fontSize: 11, color: 'inherit', opacity: 0.7 }}>{w.sub}</div>
              </div>
            </div>
            <span className="ar">→</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function CoinCard({ coin, selected, corrToBasket, onToggle, maxMcap }) {
  const mcapFrac = Math.min(1, Math.log10(coin.mcap) / Math.log10(maxMcap));
  return (
    <div className={`coin-card ${selected ? 'selected' : ''}`} onClick={onToggle} data-tk={coin.tk}>
      <div className="top">
        <div className="glyph" style={{ background: coin.color }}>{coin.glyph}</div>
        <div className="check">{selected ? '✓' : ''}</div>
      </div>
      <div className="name-line">
        <div className="tk">{coin.tk}</div>
        <div className="nm">{coin.name}</div>
      </div>
      {corrToBasket != null && !selected && (
        <div className={`corr-pill ${corrColor(corrToBasket)}`}>ρ {corrToBasket.toFixed(2)}</div>
      )}
      <div className="stats">
        <div>
          <div className="stat-label">Market cap</div>
          <div className="stat-val">{fmtMcap(coin.mcap)}</div>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${mcapFrac*100}%` }} /></div>
        </div>
        <div>
          <div className="stat-label">Sharpe · 1Y</div>
          <div className={`stat-val ${sharpeColor(coin.sharpe)}`} style={{ color: coin.sharpe < 0 ? 'var(--bad)' : coin.sharpe >= 1 ? 'var(--good)' : 'inherit' }}>
            {coin.sharpe > 0 ? '+' : ''}{coin.sharpe.toFixed(2)}
          </div>
          <div className="bar-track">
            <div className="bar-fill" style={{
              width: `${Math.min(100, Math.max(4, (coin.sharpe + 0.5) * 50))}%`,
              background: coin.sharpe < 0 ? 'var(--bad)' : coin.sharpe >= 1 ? 'var(--good)' : 'var(--accent)'
            }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function Sidecar({ basket, removeFromBasket }) {
  // diagnostic metrics
  const eqWeights = useMemo(() => basket.map(_ => 1/basket.length), [basket]);
  const vol = useMemo(() => portfolioVol(basket, eqWeights), [basket, eqWeights]);
  const avgPair = useMemo(() => {
    if (basket.length < 2) return null;
    let s = 0, n = 0;
    for (let i = 0; i < basket.length; i++)
      for (let j = i+1; j < basket.length; j++) { s += CORR[basket[i]][basket[j]]; n++; }
    return s/n;
  }, [basket]);

  return (
    <aside className="sidecar">
      <h4>Working basket — {basket.length} {basket.length === 1 ? 'asset' : 'assets'}</h4>
      {basket.length === 0 && (
        <div className="empty">An empty page awaits the first pick.</div>
      )}
      {basket.length > 0 && basket.map(tk => {
        const c = COIN_BY_TK[tk];
        return (
          <div className="basket-row" key={tk}>
            <div className="gl" style={{ background: c.color }}>{c.glyph}</div>
            <div>
              <div className="tk">{c.tk}</div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)' }}>{c.name}</div>
            </div>
            <button className="rm" onClick={() => removeFromBasket(tk)}>×</button>
          </div>
        );
      })}
      {basket.length >= 1 && (
        <div className="metrics">
          <div className="row"><span className="lbl">Equal-weight σ</span><span className="val">{(vol*100).toFixed(1)}%</span></div>
          <div className="row"><span className="lbl">Avg pairwise ρ</span>
            <span className="val" style={{ color: avgPair == null ? 'var(--ink-3)' : avgPair < 0.15 ? 'var(--good)' : avgPair < 0.45 ? 'var(--warn)' : 'var(--bad)' }}>
              {avgPair == null ? '—' : avgPair.toFixed(2)}
            </span>
          </div>
          <div className="row"><span className="lbl">Diversification</span>
            <span className="val">{basket.length < 2 ? '—' : avgPair < 0.15 ? 'Excellent' : avgPair < 0.45 ? 'Adequate' : 'Concentrated'}</span>
          </div>
        </div>
      )}
      {basket.length >= 1 && (
        <div className="mono" style={{ fontSize: 10, color: 'var(--ink-3)', marginTop: 14, lineHeight: 1.6, fontStyle: 'italic', fontFamily: "'Instrument Serif', serif" }}>
          Pick assets with low ρ to the working basket — the system will guide you toward less correlated candidates.
        </div>
      )}
    </aside>
  );
}

function FundingPanel({ wallet, basket, selectedHolding, setSelectedHolding, amount, setAmount, onBuild }) {
  const bySymbol = usePriceStore(s => s.bySymbol);
  // Real onchain holdings (Horizon) — never the static sample data.
  const balByTk = useBalanceStore(s => s.byTk);
  const balLoaded = useBalanceStore(s => s.lastUpdated) != null;
  const balError = useBalanceStore(s => s.error);
  const holdingOf = (tk) => balByTk[tk] ?? 0;
  const holdings = useMemo(() => COINS.filter(c => holdingOf(c.tk) > 0), [balByTk]);
  const selCoin = selectedHolding ? COIN_BY_TK[selectedHolding] : null;
  const usdAmount = selCoin ? (parseFloat(amount || 0) * priceOf(bySymbol, selCoin.tk)) : 0;
  const maxHolding = selCoin ? holdingOf(selCoin.tk) : 0;
  const overMax = selCoin && parseFloat(amount || 0) > maxHolding;
  const canBuild = selCoin && parseFloat(amount || 0) > 0 && !overMax && basket.length >= 2;

  return (
    <section className="funding-panel fade-in">
      <div className="col">
        <h5>① Capital source — choose a holding to liquidate</h5>
        <div className="holding-list">
          {holdings.length === 0 && (
            <div style={{ padding: 20, fontFamily: "'Instrument Serif', serif", fontStyle: 'italic', color: balError ? 'var(--bad)' : 'var(--ink-2)' }}>
              {balError ? `Could not read balances from Horizon (${balError}).`
                : balLoaded ? 'No qualifying balances detected in this wallet.'
                : 'Reading balances from Horizon…'}
            </div>
          )}
          {holdings.map(h => {
            const isSel = selectedHolding === h.tk;
            const held = holdingOf(h.tk);
            return (
              <div key={h.tk} className={`holding-row ${isSel ? 'selected' : ''}`} onClick={() => setSelectedHolding(h.tk)}>
                <div className="gl" style={{ background: h.color }}>{h.glyph}</div>
                <div>
                  <div className="tk">{h.tk}</div>
                  <div className="sub">{h.name}</div>
                </div>
                <div className="amt">{held.toLocaleString(undefined, {maximumFractionDigits: 4})}</div>
                <div className="usd">{fmtUsd(held * priceOf(bySymbol, h.tk))}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="col">
        <h5>② Allocation amount</h5>
        <div className="amount-block">
          <div className="amount-input-wrap">
            <span className="pre">AMT</span>
            <input
              type="text"
              inputMode="decimal"
              value={amount}
              placeholder="0.00"
              onChange={e => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              disabled={!selCoin}
            />
            <span className="unit">{selCoin?.tk || '—'}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div className="quick-amounts">
              {[0.25, 0.5, 0.75, 1.0].map(f => (
                <button key={f} className="qa" disabled={!selCoin}
                  onClick={() => selCoin && setAmount((maxHolding * f).toFixed(priceOf(bySymbol, selCoin.tk) > 100 ? 4 : 2))}>
                  {f === 1.0 ? 'MAX' : `${f*100}%`}
                </button>
              ))}
            </div>
            <div className="mono" style={{ fontSize: 12, color: overMax ? 'var(--bad)' : 'var(--ink-2)' }}>
              ≈ {fmtUsd(usdAmount)}
              {overMax && <span> · EXCEEDS BALANCE</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="build-cta">
        <div className="note">
          {basket.length < 2 && <>Select at least <strong>two assets</strong> in the universe above before the optimiser can run.</>}
          {basket.length >= 2 && !canBuild && <>Choose a source holding and an allocation amount to enable construction.</>}
          {canBuild && <>Ready to compute. The optimiser will equalise risk contributions across the {basket.length} selected assets.</>}
        </div>
        <button className="btn lg" disabled={!canBuild} onClick={onBuild}>
          <span className="dot" />
          Build risk-parity portfolio
          <span>→</span>
        </button>
      </div>
    </section>
  );
}

function AllocStage({ basket, weights, source, amount, onTrade, onReset }) {
  const bySymbol = usePriceStore(s => s.bySymbol);
  const sourceCoin = COIN_BY_TK[source];
  const usdTotal = parseFloat(amount) * priceOf(bySymbol, source);
  const vol = portfolioVol(basket, weights);
  const sharpe = portfolioSharpe(basket, weights);

  // sort by weight desc for display
  const ordered = basket
    .map((tk, i) => ({ tk, w: weights[i] }))
    .sort((a, b) => b.w - a.w);

  const palette = ['#1d1a14', '#b14820', '#1f5e4a', '#3a4660', '#874422', '#5b3aa0', '#0a3b66', '#b8761a', '#3d6f4a', '#7d2a4a', '#5b6470', '#1f8fc0'];

  const now = new Date();
  const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  return (
    <section className="alloc-stage fade-in">
      <div className="alloc-header">
        <div>
          <div className="mono uc" style={{ fontSize: 11, color: 'var(--ink-2)', letterSpacing: '0.2em' }}>Optimisation Result</div>
          <h3>Equal Risk-Contribution Portfolio</h3>
        </div>
        <div className="ts">computed {ts} · solver ERC-Newton · 200 iter max</div>
      </div>

      <div className="alloc-bar">
        {ordered.map((o, i) => {
          const c = COIN_BY_TK[o.tk];
          const pct = o.w * 100;
          const thin = pct < 6;
          return (
            <div key={o.tk} className={`seg ${thin ? 'thin' : ''}`}
              style={{ background: palette[i % palette.length], flexBasis: `${pct}%` }} title={`${c.tk} · ${pct.toFixed(1)}%`}>
              <span className="tk">{c.tk}</span>
              <span className="pct">{pct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>

      <div className="alloc-table">
        <div className="alloc-row head">
          <div></div>
          <div>Asset</div>
          <div>Weight</div>
          <div>USD</div>
          <div>Units</div>
          <div>Risk · σ contribution</div>
        </div>
        {ordered.map((o, i) => {
          const c = COIN_BY_TK[o.tk];
          const usd = o.w * usdTotal;
          const units = usd / priceOf(bySymbol, c.tk);
          const riskFrac = (c.vol / Math.max(...basket.map(b => COIN_BY_TK[b].vol)));
          return (
            <div className="alloc-row" key={o.tk}>
              <div className="gl" style={{ background: c.color }}>{c.glyph}</div>
              <div className="nm"><div className="tk">{c.tk}</div><div className="full">{c.name}</div></div>
              <div className="pct">{(o.w*100).toFixed(1)}<span style={{ fontSize: 16, color: 'var(--ink-2)' }}>%</span></div>
              <div className="num">{fmtUsdK(usd)}</div>
              <div className="num">{units.toLocaleString(undefined, { maximumFractionDigits: priceOf(bySymbol, c.tk) < 1 ? 0 : 4 })}</div>
              <div className="vol-bar"><div style={{ width: `${riskFrac*100}%`, background: palette[i % palette.length] }} /></div>
            </div>
          );
        })}
      </div>

      <div className="trade-cta">
        <div className="meta-blob">
          <div>
            <div className="lbl">Notional</div>
            <div className="val">{fmtUsd(usdTotal)}</div>
          </div>
          <div>
            <div className="lbl">Portfolio σ (1Y)</div>
            <div className="val">{(vol*100).toFixed(1)}%</div>
          </div>
          <div>
            <div className="lbl">Weighted Sharpe</div>
            <div className="val good">{sharpe.toFixed(2)}</div>
          </div>
          <div>
            <div className="lbl">Route</div>
            <div className="val">Soroswap AMM</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn ghost" onClick={onReset}>← Revise basket</button>
          <button className="btn lg" onClick={onTrade}>
            <span className="dot" />
            Execute trades
            <span>→</span>
          </button>
        </div>
      </div>
    </section>
  );
}

function ExecOverlay({ basket, weights, source, amount, onClose }) {
  const bySymbol = usePriceStore(s => s.bySymbol);
  const sourceCoin = COIN_BY_TK[source];
  const usdTotal = parseFloat(amount) * priceOf(bySymbol, source);
  const steps = useMemo(() =>
    basket.map((tk, i) => ({
      ix: i+1, from: source, to: tk,
      usd: weights[i] * usdTotal,
      units: (weights[i] * usdTotal) / priceOf(bySymbol, tk),
    })).filter(s => s.from !== s.to)
  , [basket, weights, source, amount, usdTotal, bySymbol]);

  const [running, setRunning] = useState(0); // index currently running
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (running >= steps.length) { setDone(true); return; }
    const t = setTimeout(() => setRunning(running + 1), 1100);
    return () => clearTimeout(t);
  }, [running, steps.length]);

  return (
    <div className="exec-overlay">
      <div className="exec-card fade-in">
        <div className="mono uc" style={{ fontSize: 11, color: 'var(--ink-2)', letterSpacing: '0.2em' }}>
          {done ? 'Preview — Simulated (no broadcast)' : 'Simulating — preview only'}
        </div>
        <h3>{done ? 'Portfolio preview constructed.' : 'Simulating routing…'}</h3>
        <div className="sub">
          {done ? 'Dry-run preview only — no transaction was signed or broadcast and no funds moved. On-chain execution is not enabled in this build.'
                : `Previewing a split of ${parseFloat(amount).toLocaleString()} ${source} across ${steps.length} legs (simulation — nothing is broadcast).`}
        </div>
        <div className="exec-list">
          {steps.map((s, i) => {
            const stat = i < running ? 'done' : i === running ? 'running' : 'pending';
            return (
              <div className={`exec-step ${stat}`} key={i}>
                <div className="ix">LEG {String(s.ix).padStart(2, '0')}</div>
                <div className="desc">
                  Swap <span className="tk">{s.from}</span> → <span className="tk">{s.to}</span>
                  &nbsp;·&nbsp; {fmtUsd(s.usd)} &nbsp;·&nbsp; {s.units.toLocaleString(undefined, { maximumFractionDigits: priceOf(bySymbol, s.to) < 1 ? 0 : 4 })} {s.to}
                </div>
                <div className="stat">
                  {stat === 'pending' && '◌ queued'}
                  {stat === 'running' && <><span className="spin"></span>simulating</>}
                  {stat === 'done' && '✓ simulated'}
                </div>
              </div>
            );
          })}
        </div>
        <div className="exec-close">
          <div className="receipt">{done ? 'simulated — no on-chain transaction' : 'simulating…'}</div>
          <button className="btn" disabled={!done} onClick={onClose}>
            {done ? 'Done →' : 'Working…'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- App ----------

export default function PortfolioBuilder() {
  const [basket, setBasket] = useState([]);
  const [holding, setHolding] = useState(null);
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState('connect'); // connect | select | allocated | executing | done
  const [weights, setWeights] = useState([]);
  const [showBetaNotice, setShowBetaNotice] = useState(false);

  // ---- Live wallet (Step 3) — Stellar Wallets Kit via zustand store ----
  const address = useStellarWalletStore(s => s.address);
  const connected = useStellarWalletStore(s => s.connected);
  const walletKind = useStellarWalletStore(s => s.walletKind);
  const connecting = useStellarWalletStore(s => s.connecting);
  const connectError = useStellarWalletStore(s => s.error);
  const setPrices = usePriceStore(s => s.set);
  const setBalances = useBalanceStore(s => s.set);

  // Initialise the kit once on mount (browser-only; imports are dynamic).
  useEffect(() => { initWalletKit(); }, []);

  // Advance past the connect screen once a real wallet is connected.
  useEffect(() => {
    if (connected && phase === 'connect') setPhase('select');
  }, [connected, phase]);

  // Live prices (Step 5): poll Soroswap via our server proxy every 45s, with
  // cleanup. Static research price is used as fallback where Soroswap is
  // unreliable/missing (see lib/prices.ts).
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setPrices(s => { s.loading = true; });
      try {
        const bySymbol = await fetchLivePrices();
        if (cancelled) return;
        setPrices(s => {
          s.bySymbol = bySymbol; s.loading = false; s.error = null; s.lastUpdated = Date.now();
        });
      } catch (e) {
        if (cancelled) return;
        setPrices(s => { s.loading = false; s.error = String((e && e.message) || e); });
      }
    };
    load();
    const id = setInterval(load, 45000);
    return () => { cancelled = true; clearInterval(id); };
  }, [setPrices]);

  // Live balances (Step 4): poll Horizon for the connected account every 30s,
  // with cleanup; cleared on disconnect/account switch. Real onchain holdings —
  // never the sample data shipped with the research bundle.
  useEffect(() => {
    if (!address) {
      setBalances(s => { s.byTk = {}; s.loading = false; s.error = null; s.lastUpdated = null; });
      return;
    }
    let cancelled = false;
    const load = async () => {
      setBalances(s => { s.loading = true; });
      try {
        const byTk = await fetchHoldings(address);
        if (cancelled) return;
        setBalances(s => {
          s.byTk = byTk; s.loading = false; s.error = null; s.lastUpdated = Date.now();
        });
      } catch (e) {
        if (cancelled) return;
        setBalances(s => { s.loading = false; s.error = String((e && e.message) || e); });
      }
    };
    load();
    const id = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(id); };
  }, [address, setBalances]);

  // Masthead wallet view (Step 4): balance = Σ real holding × price (live
  // Soroswap price where reliable, else static research price). "—" until the
  // first Horizon read lands — never a fabricated number.
  const balByTk = useBalanceStore(s => s.byTk);
  const balLoaded = useBalanceStore(s => s.lastUpdated) != null;
  const bySymbol = usePriceStore(s => s.bySymbol);
  const balanceUsd = useMemo(() => {
    if (!balLoaded) return null;
    return COINS.reduce((sum, c) => sum + (balByTk[c.tk] ?? 0) * priceOf(bySymbol, c.tk), 0);
  }, [balLoaded, balByTk, bySymbol]);
  const wallet = connected && address
    ? { kind: walletKind || 'Wallet', addr: truncateAddr(address), balance: balanceUsd }
    : null;

  const maxMcap = useMemo(() => Math.max(...COINS.map(c => c.mcap)), []);

  const onConnect = (kind) => { connectWallet(kind).catch(() => {}); };
  const onDisconnect = () => {
    disconnectWallet();
    setBasket([]); setHolding(null); setAmount(''); setWeights([]); setPhase('connect');
  };

  const toggle = (tk) => {
    setBasket(b => b.includes(tk) ? b.filter(x => x !== tk) : [...b, tk]);
  };
  const remove = (tk) => setBasket(b => b.filter(x => x !== tk));

  const onBuild = () => {
    const w = riskParity(basket);
    setWeights(w);
    setPhase('allocated');
    setTimeout(() => {
      const el = document.querySelector('.alloc-stage');
      if (el) el.scrollIntoView ? null : null; // never use scrollIntoView per project rules; rely on layout
    }, 50);
  };

  const onTrade = () => setPhase('executing');
  const onCloseExec = () => setPhase('done');
  const onReset = () => setPhase('select');

  // candidate correlations to current basket
  const candidateCorr = useMemo(() => {
    const m = {};
    COINS.forEach(c => {
      m[c.tk] = avgCorrelation(c.tk, basket);
    });
    return m;
  }, [basket]);

  // sort coins: selected first; then by lowest avg corr if basket has picks; else by mcap desc
  const sortedCoins = useMemo(() => {
    return [...COINS].sort((a, b) => {
      const aSel = basket.includes(a.tk), bSel = basket.includes(b.tk);
      if (aSel && !bSel) return -1;
      if (!aSel && bSel) return 1;
      if (basket.length > 0) {
        return (candidateCorr[a.tk] ?? 1) - (candidateCorr[b.tk] ?? 1);
      }
      return b.mcap - a.mcap;
    });
  }, [basket, candidateCorr]);

  const lockedClass = phase === 'allocated' || phase === 'executing' || phase === 'done' ? 'locked' : '';

  return (
    <div id="root">
      {/* Beta pill — same intent as the landing's "Platform Beta Testing Notice",
          restyled to the atelier/newspaper language (mono, rule border). Opens
          the beta-notice modal below. */}
      <div style={{ display: 'flex', justifyContent: 'center', margin: '2px 0 16px' }}>
        <button className="mono" onClick={() => setShowBetaNotice(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 8, border: '1px solid var(--rule)', borderRadius: 999, padding: '5px 16px', font: 'inherit', fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--ink-2)', background: 'var(--paper-2)', cursor: 'pointer' }}>
          <span style={{ fontSize: 11 }}>✦</span> Platform Beta Testing Notice
        </button>
      </div>

      {showBetaNotice && (
        <div className="exec-overlay" onClick={() => setShowBetaNotice(false)}>
          <div className="exec-card fade-in" onClick={e => e.stopPropagation()}>
            <div className="mono uc" style={{ fontSize: 11, color: 'var(--ink-2)', letterSpacing: '0.2em' }}>
              Platform Beta — Testing Notice
            </div>
            <h3>This app is in <em>beta</em>.</h3>
            <div className="sub">
              Etesia Portfolio Atelier is in a beta testing phase, provided "as is" and "as
              available" — it may contain bugs, and figures should not be relied upon for
              financial decisions. Know what is real and what is not:
            </div>
            <div className="mono" style={{ fontSize: 12, lineHeight: 2, margin: '16px 0', borderTop: '1px solid var(--rule)', borderBottom: '1px solid var(--rule)', padding: '12px 0' }}>
              <div><span style={{ color: 'var(--good)' }}>● live</span> — wallet connection, account balances (Horizon, Stellar mainnet) and spot prices (Soroswap, where marked "live").</div>
              <div><span style={{ color: 'var(--ink-3)' }}>● static</span> — volatility, Sharpe and correlations are fixed research inputs, not market feeds.</div>
              <div><span style={{ color: 'var(--warn)' }}>● simulated</span> — trade execution is a dry-run preview. No transaction is signed or broadcast; funds never move.</div>
            </div>
            <div className="sub">
              Your keys stay in your wallet — this app never asks you to sign anything during
              beta. Nothing here is investment advice; use at your own risk.
            </div>
            <div className="exec-close">
              <div className="receipt">beta — as is · no warranty · not advice</div>
              <button className="btn" onClick={() => setShowBetaNotice(false)}>I understand →</button>
            </div>
          </div>
        </div>
      )}
      <Masthead wallet={wallet} onDisconnect={onDisconnect} />
      {wallet && <Ticker />}

      {phase === 'connect' && <ConnectScreen onConnect={onConnect} connecting={connecting} error={connectError} />}

      {phase !== 'connect' && (
        <div className={lockedClass}>
          {/* Step 2: select coins */}
          <div className="section-bar">
            <span className="num-mark">02</span>
            <h2>Universe — pick the candidates</h2>
            <span className="meta">
              {basket.length === 0 && 'Select one asset to begin'}
              {basket.length === 1 && '1 asset · pick more to evaluate correlation'}
              {basket.length >= 2 && `${basket.length} assets · ρ-ordered, lowest first`}
            </span>
          </div>

          <div className="two-col">
            <div className="coin-grid">
              {sortedCoins.map(c => (
                <CoinCard
                  key={c.tk}
                  coin={c}
                  selected={basket.includes(c.tk)}
                  corrToBasket={candidateCorr[c.tk]}
                  onToggle={() => toggle(c.tk)}
                  maxMcap={maxMcap}
                />
              ))}
            </div>
            <Sidecar basket={basket} removeFromBasket={remove} />
          </div>

          {/* Step 3: fund */}
          <div className="section-bar" style={{ marginTop: 36 }}>
            <span className="num-mark">03</span>
            <h2>Funding — capital source & amount</h2>
            <span className={`meta ${basket.length < 2 ? 'locked' : ''}`}>
              {basket.length < 2 ? 'Awaiting basket — at least 2 assets required' : 'Ready'}
            </span>
          </div>

          <FundingPanel
            wallet={wallet}
            basket={basket}
            selectedHolding={holding}
            setSelectedHolding={setHolding}
            amount={amount}
            setAmount={setAmount}
            onBuild={onBuild}
          />
        </div>
      )}

      {(phase === 'allocated' || phase === 'executing' || phase === 'done') && (
        <>
          <div className="section-bar" style={{ marginTop: 36 }}>
            <span className="num-mark">04</span>
            <h2>Allocation — risk-parity weights</h2>
            <span className="meta">solver · equal-risk-contribution (Newton)</span>
          </div>
          <AllocStage
            basket={basket}
            weights={weights}
            source={holding}
            amount={amount}
            onTrade={onTrade}
            onReset={onReset}
          />
        </>
      )}

      {phase === 'executing' && (
        <ExecOverlay basket={basket} weights={weights} source={holding} amount={amount}
          onClose={onCloseExec} />
      )}

      {phase === 'done' && (
        <div className="fade-in" style={{ marginTop: 24, padding: '18px 22px', border: '1px solid var(--good)', background: 'rgba(31,94,74,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div className="mono uc" style={{ fontSize: 11, color: 'var(--good)', letterSpacing: '0.2em' }}>Preview complete</div>
            <div className="serif" style={{ fontSize: 22, marginTop: 2 }}>Risk-parity allocation preview ready — simulation only, no funds moved.</div>
          </div>
          <button className="btn ghost" onClick={() => {
            setBasket([]); setHolding(null); setAmount(''); setWeights([]); setPhase('select');
          }}>Construct another →</button>
        </div>
      )}

      <footer style={{ marginTop: 64, borderTop: '4px double var(--rule)', paddingTop: 18, display: 'flex', justifyContent: 'space-between', fontFamily: "'IBM Plex Mono', monospace", fontSize: 10, color: 'var(--ink-3)', letterSpacing: '0.12em' }}>
        <span>ETESIA RESEARCH</span>
        <span>Wallet connect, Horizon balances + Soroswap prices are live (some prices fall back to static; marked per-asset) · vol/σ/ρ are static research inputs · execution is a simulated preview · not advice.</span>
        <span>portfolio.etesiar.com</span>
      </footer>
    </div>
  );
}
