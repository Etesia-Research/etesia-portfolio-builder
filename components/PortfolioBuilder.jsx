"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import useStellarWalletStore from "@/stores/useStellarWalletStore";
import { initWalletKit, connectWallet, disconnectWallet } from "@/components/stellar/walletKit";
import usePriceStore from "@/stores/usePriceStore";
import { fundingValue, referenceValue } from "@/lib/prices";
import { fetchUniverse, quantRequest, checkRoute } from "@/lib/quant";
import useBalanceStore from "@/stores/useBalanceStore";
import { fetchHoldings } from "@/lib/balances";

const EMPTY_HOLDINGS = {};
const RESERVE_IDS = new Set(['usdc', 'eurc', 'ustry']);


// Existing truncation style, e.g. GA7Q…3K2M (4 + … + 4).
const truncateAddr = (a) => (a && a.length > 9 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);

const fmtMcap = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
};
const fmtUsd = (n, dp=2) => {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(2)}K`;
  return `$${n.toLocaleString(undefined, {minimumFractionDigits: dp, maximumFractionDigits: dp})}`;
};
const corrColor = (c) => c < 0.15 ? 'good' : c < 0.45 ? 'warn' : 'bad';
const fmtDate = (stamp) => stamp ? new Date(stamp).toLocaleDateString('en-US', { timeZone: 'UTC' }) : 'unavailable';
const metricNote = (metric, error) => error || metric?.reason || (metric ? `${metric.simulated ? 'Simulated · ' : ''}${metric.stale ? 'Stale · ' : ''}year ending ${fmtDate(metric.window_end)}` : 'Loading…');

// ---------- Components ----------

function Masthead({ wallet, onDisconnect }) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: '2-digit' });
  const bySymbol = usePriceStore(s => s.bySymbol);
  const pricesLoading = usePriceStore(s => s.loading);
  const lastUpdated = usePriceStore(s => s.lastUpdated);
  const staleCount = Object.values(bySymbol).filter(p => p.price != null && p.stale).length;
  const pricesError = usePriceStore(s => s.error);
  const pricesStatus = pricesError ? 'daily closes · refresh failed'
    : lastUpdated ? `daily reference closes · ${staleCount ? `${staleCount} stale` : 'quant API'} · refreshed ${new Date(lastUpdated).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
    : pricesLoading ? 'daily closes · loading…' : 'daily closes · —';
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
            <div style={{ marginTop: 4 }}>catalog value (daily close): {wallet.balance != null ? fmtUsd(wallet.balance, 2) : '—'}{wallet.balanceError && (wallet.balance != null ? ' · stale (refresh failed)' : ' · balance unavailable')} <span style={{ color: wallet.balanceError ? 'var(--warn)' : 'var(--good)' }}>●</span></div>
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

function Ticker({ coins }) {
  const bySymbol = usePriceStore(s => s.bySymbol);
  const lane = <div className="lane">{coins.concat(coins).map((c, i) => {
    const price = bySymbol[c.tk];
    return <span key={i} className="it"><strong>{c.tk}</strong>&nbsp;{fmtUsd(price?.price, price?.price < 1 ? 4 : 2)}&nbsp;
      <span style={{ fontSize: 10 }}>{c.simulated ? 'under construction' : price?.price == null ? 'unavailable' : `${price.stale ? 'stale ' : ''}close ${fmtDate(price.ts)}`}</span>
    </span>;
  })}</div>;
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
          Etesia calculates risk-parity allocations from daily market data. Explore the product universe,
          compare the simulated vault, and preview allocations using your wallet balances.
        </p>
        <p className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 14, letterSpacing: '0.06em' }}>
          Network · Stellar Mainnet &nbsp;·&nbsp; Execution · Simulated
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

function CoinCard({ coin, selected, correlation, correlationLoading, hasBasket, onToggle, maxMcap, route }) {
  const mcapFrac = coin.mcap > 0 && maxMcap > 1 ? Math.min(1, Math.log10(coin.mcap) / Math.log10(maxMcap)) : 0;
  const corr = correlation?.status === 'available' ? correlation.correlation : null;
  return (
    <button type="button" className={`coin-card ${selected ? 'selected' : ''}`} onClick={onToggle} data-tk={coin.tk} aria-pressed={selected}>
      <div className="top"><div className="glyph" style={{ background: coin.color }}>{coin.glyph}</div><div className="check">{selected ? '✓' : ''}</div></div>
      <div className="name-line"><div className="tk">{coin.tk}</div><div className="nm">{coin.name}</div></div>
      {coin.simulated && <div className="product-status">Under construction · simulated returns</div>}
      {!coin.simulated && <div className="product-status" title={route?.reason}>{coin.id === 'usdc' ? 'Settlement buffer' : !coin.allocationSupported ? 'Analytics only · allocation API update required' : route?.available ? 'Soroswap route available' : route?.reason || 'Checking Soroswap route…'}</div>}
      {['eth', 'btc'].includes(coin.id) && <div className="data-note">Underlying history · Ultra Capital route</div>}
      {hasBasket && <div className={`corr-pill ${corr == null ? '' : corrColor(corr)}`} title={metricNote(correlation, correlation?.error)}>
        {correlationLoading ? 'ρ loading…' : corr == null ? 'ρ unavailable' : `ρ ${corr.toFixed(2)}${correlation.simulated ? ' · simulated' : ''}${correlation.stale ? ' · stale' : ''}`}
      </div>}
      <div className="stats">
        <div title={`${coin.marketCap.reason || ''} ${coin.marketCap.as_of ? fmtDate(coin.marketCap.as_of) : ''}`}>
          <div className="stat-label">{coin.marketCap.basis === 'issuer_net_value' ? 'Issuer net value' : 'Market cap'}{coin.marketCap.stale && coin.mcap != null ? ' · stale' : ''}</div>
          <div className="stat-val">{fmtMcap(coin.mcap)}</div><div className="bar-track"><div className="bar-fill" style={{ width: `${mcapFrac * 100}%` }} /></div>
        </div>
        <div title={metricNote(coin.analytics, coin.analyticsError)}>
          <div className="stat-label">Sharpe · 1Y{coin.simulated ? ' · simulated' : ''}</div>
          <div className="stat-val">{coin.sharpe == null ? '—' : coin.sharpe.toFixed(2)}</div>
        </div>
      </div>
      <div className="data-note">{metricNote(coin.analytics, coin.analyticsError)}</div>
      {hasBasket && !correlationLoading && corr == null && <div className="data-note">{correlation?.reason || correlation?.error || 'Correlation unavailable'}</div>}
    </button>
  );
}

function Sidecar({ basket, coins, removeFromBasket, analytics, analyticsLoading }) {
  return <aside className="sidecar">
    <h4>Working basket — {basket.length} {basket.length === 1 ? 'asset' : 'assets'}</h4>
    {!basket.length && <div className="empty">An empty page awaits the first pick.</div>}
    {coins.filter(c => basket.includes(c.tk)).map(c => <div className="basket-row" key={c.tk}>
      <div className="gl" style={{ background: c.color }}>{c.glyph}</div>
      <div><div className="tk">{c.tk}</div><div className="data-note">{c.simulated ? 'Under construction · simulated' : c.name}</div></div>
      <button className="rm" aria-label={`Remove ${c.tk}`} onClick={() => removeFromBasket(c.tk)}>×</button>
    </div>)}
    {basket.length > 0 && <div className="metrics" aria-live="polite" aria-busy={analyticsLoading}>
      <div className="row"><span className="lbl">Avg. pairwise correlation</span><span className="val">{analyticsLoading ? '…' : analytics?.average_pairwise_correlation?.toFixed(2) ?? '—'}</span></div>
      {!analyticsLoading && analytics?.pairwise_reason && <div className="data-note">{analytics.pairwise_reason}</div>}
      <div className="row"><span className="lbl">Basket SR · 1Y</span><span className="val">{analyticsLoading ? '…' : analytics?.sharpe_1y?.toFixed(2) ?? '—'}</span></div>
      {!analyticsLoading && analytics?.sharpe_reason && analytics.sharpe_reason !== analytics.pairwise_reason && <div className="data-note">{analytics.sharpe_reason}</div>}
      <div className="data-note">Equal initial weights · buy and hold · USD · 0% risk-free rate. Correlation averages distinct product pairs.</div>
      <div className="data-note">{analyticsLoading ? 'Calculating basket metrics…' : analytics?.error || (analytics?.window_end ? `Year ending ${analytics.window_end.slice(0, 10)}${analytics.stale ? ' · stale data' : ''}` : '')}</div>
    </div>}
    <p className="data-note">ρ compares each product with this basket over one year, using equal capital at the start of the year and fixed quantities thereafter.</p>
    {basket.includes('ETESIA-TF') && <p className="data-note">Basket metrics include simulated vault returns. The vault is under construction and is excluded from allocation.</p>}
    <p className="data-note">Cash reserve assets are selected in their own step below. Allocation uses products with daily history and a checked Soroswap route; the calculator retains its caps and buffers.</p>
  </aside>;
}

function CashReservePanel({ selected, onChange, supported, routes, coins }) {
  const options = [
    { id: 'usdc', name: 'USD Coin' },
    { id: 'eurc', name: 'Euro Coin' },
    { id: 'ustry', name: 'USTRY' },
  ];
  return <section className="cash-reserve-stage">
    <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">04</span><h2>Cash reserve</h2><span className="meta">Equal split across selected assets</span></div>
    <div className="reserve-options">{options.map(option => {
      const coin = coins.find(c => c.id === option.id);
      const available = !!coin && supported.includes(option.id) && routes[coin.tk]?.available;
      const reason = !coin ? 'Daily data unavailable' : !supported.includes(option.id) ? 'Reserve API update required' : !routes[coin.tk]?.available ? 'Awaiting an available route' : 'Daily history available';
      return <label key={option.id} className={`reserve-option ${selected.includes(option.id) ? 'selected' : ''}`}>
        <input type="checkbox" checked={selected.includes(option.id)} disabled={!available && !selected.includes(option.id)} onChange={() => onChange(selected.includes(option.id) ? selected.filter(id => id !== option.id) : [...selected, option.id])} />
        <span><strong>{option.id.toUpperCase()}</strong><span className="data-note">{option.name} · {reason}</span></span>
        {selected.includes(option.id) && <span className="reserve-share">{(100 / selected.length).toFixed(0)}% of reserve</span>}
      </label>;
    })}</div>
    <p className="data-note">{selected.length ? `Residual cash is split equally across ${selected.map(id => id.toUpperCase()).join(' and ')}. The 2.5% USDC and 2.5% XLM buffers are separate.` : 'Select at least one cash reserve asset to calculate an allocation.'}</p>
  </section>;
}

function FundingPanel({ coins, allocationCoins, excludedCoins, selectedHolding, setSelectedHolding, amount, setAmount, onBuild, building, error, budget, setBudget, reserveSelector, reserveValid }) {
  const COIN_BY_TK = Object.fromEntries(coins.map(c => [c.tk, c]));
  const bySymbol = usePriceStore(s => s.bySymbol);
  // Real onchain holdings (Horizon) — never the static sample data.
  const address = useStellarWalletStore(s => s.address);
  const balByTk = useBalanceStore(s => s.address === address ? s.byTk : EMPTY_HOLDINGS);
  const balLoaded = useBalanceStore(s => s.address === address && s.lastUpdated != null);
  const balError = useBalanceStore(s => s.address === address ? s.error : null);
  const holdingOf = (tk) => balByTk[tk] ?? 0;
  const holdings = useMemo(() => coins.filter(c => holdingOf(c.tk) > 0), [coins, balByTk]);
  const selCoin = selectedHolding ? COIN_BY_TK[selectedHolding] : null;
  const usdAmount = selCoin ? referenceValue(bySymbol, selCoin.tk, Number(amount)) : null;
  const usdcAmount = selCoin ? fundingValue(bySymbol, selCoin.tk, Number(amount)) : null;
  const maxHolding = selCoin ? holdingOf(selCoin.tk) : 0;
  const overMax = selCoin && Number(amount) > maxHolding;
  const canBuild = balLoaded && !balError && selCoin && usdcAmount != null && Number(amount) > 0 && !overMax && allocationCoins.length > 0 && Number(budget) > 0 && Number.isFinite(Number(budget)) && !building && reserveValid;

  return (
    <>
    <section className="funding-panel fade-in">
      <div className="col">
        <h5>① Capital source — choose a reference holding</h5>
        <div className="holding-list">
          {(balError || holdings.length === 0) && (
            <div style={{ padding: 20, fontFamily: "'Instrument Serif', serif", fontStyle: 'italic', color: balError ? 'var(--bad)' : 'var(--ink-2)' }}>
              {balError ? `Could not read balances from Horizon (${balError}).${balLoaded ? " Displayed balances are stale; construction is paused until refresh succeeds." : ""}`
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
                <div className="usd">{fmtUsd(referenceValue(bySymbol, h.tk, held))}</div>
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
                  // Round down in stroops so quick amounts never exceed the holding.
                  onClick={() => selCoin && setAmount((Math.floor(Math.round(maxHolding * 1e7) * f) / 1e7).toFixed(7))}>
                  {f === 1.0 ? 'MAX' : `${f*100}%`}
                </button>
              ))}
            </div>
            <div className="mono" style={{ fontSize: 12, color: overMax ? 'var(--bad)' : 'var(--ink-2)' }}>
              ≈ {fmtUsd(usdAmount)} · daily close
              {overMax && <span> · EXCEEDS BALANCE</span>}
            </div>
          </div>
        </div>
      </div>

      <div className="risk-cap-control">
        <label htmlFor="risk-cap">Risk cap <span>Annual volatility of allocated products</span></label>
        <div className="risk-cap-input"><input id="risk-cap" type="range" min="1" max="100" step="1" value={budget} onChange={e => setBudget(e.target.value)} aria-valuetext={`${budget}% annual volatility`} /><output htmlFor="risk-cap">{budget}%</output></div>
      </div>
    </section>
    {reserveSelector}
    <section className="build-panel">
      <div className="build-cta">
        <div className="note">
          <div>{allocationCoins.length ? `Allocation products: ${allocationCoins.map(c => c.tk).join(', ')}.` : 'Select a product with an available allocation model and Soroswap route.'}</div>
          {excludedCoins.length > 0 && <div>Analytics only in this preview: {excludedCoins.map(c => c.tk).join(', ')} (vault, settlement asset, unsupported model or unavailable route).</div>}
          <div>{usdcAmount == null ? 'A fresh source close and matching USDC/USD close are required.' : `Hypothetical capital: ${usdcAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC, including reserves and buffers.`}</div>
          {error && <div role="alert" style={{ color: 'var(--bad)' }}>{error}</div>}
        </div>
        <button className="btn lg" disabled={!canBuild} onClick={onBuild}><span className="dot" />{building ? 'Calculating…' : 'Build risk-parity portfolio'}<span>→</span></button>
      </div>
    </section>
    </>
  );
}


function AllocStage({ allocation, coins, onReset }) {
  const ordered = Object.entries(allocation.positions || {}).filter(([, p]) => p.allocation_fraction > 0).sort((a, b) => b[1].allocation_fraction - a[1].allocation_fraction);
  const coinFor = (id) => coins.find(c => c.id === id.replace('_buffer', '').replace('_reserve', ''));
  const label = (id) => id === 'xlm_buffer' ? 'XLM fee buffer' : id.endsWith('_reserve') ? `${id.split('_')[0].toUpperCase()} reserve` : id === 'usdc' ? 'USDC buffer' : RESERVE_IDS.has(id) ? `${id.toUpperCase()} reserve` : id.toUpperCase();
  return <section className="alloc-stage fade-in">
    <div className="alloc-header"><div><div className="mono uc">Quant allocation preview</div><h3>Equal Risk-Contribution Portfolio</h3></div>
      <div className="ts">{allocation.model_version} · data through {fmtDate(allocation.market_data_as_of)}</div></div>
    <div className="alloc-bar">{ordered.map(([id, position]) => <div key={id} className={`seg ${position.allocation_fraction < .06 ? 'thin' : ''}`} style={{ background: coinFor(id)?.color || '#5b6470', flexBasis: `${position.allocation_fraction * 100}%` }} title={`${label(id)} ${(position.allocation_fraction * 100).toFixed(2)}%`}>
      <span className="tk">{label(id)}</span><span className="pct">{(position.allocation_fraction * 100).toFixed(1)}%</span>
    </div>)}</div>
    <div className="alloc-table">
      <div className="alloc-row head"><div></div><div>Position</div><div>Allocation</div><div>USDC</div><div>Units</div><div>Reference mark (USDC)</div></div>
      {ordered.map(([id, position]) => <div className="alloc-row" key={id}>
        <div className="gl" style={{ background: coinFor(id)?.color }}>{coinFor(id)?.glyph}</div>
        <div className="nm"><div className="tk">{label(id)}</div><div className="full">{coinFor(id)?.name}</div></div>
        <div className="pct">{(position.allocation_fraction * 100).toFixed(1)}%</div>
        <div className="num">{position.notional_usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        <div className="num">{position.quantity.toLocaleString(undefined, { maximumFractionDigits: 7 })}</div>
        <div className="num">{position.mark_usdc?.toLocaleString(undefined, { maximumSignificantDigits: 6 }) ?? '—'}</div>
      </div>)}
    </div>
    <div className="trade-cta"><div className="meta-blob">
      <div><div className="lbl">Capital · USDC</div><div className="val">{allocation.portfolio_value_usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div></div>
      <div><div className="lbl">Allocated sleeve σ · annual</div><div className="val">{allocation.allocated_sleeve_volatility == null ? '—' : `${(allocation.allocated_sleeve_volatility * 100).toFixed(2)}%`}</div></div>
    </div><button className="btn ghost" onClick={onReset}>← Revise basket</button></div>
    <p className="data-note">Simulated allocation · reference quantities, no funds moved. The volatility measure applies to the selected sleeve. Reserves and buffers are shown separately.</p>
    {allocation.binding_constraints.length > 0 && <p className="data-note">Model limits: {allocation.binding_constraints.map(c => c.replaceAll('_', ' ')).join(' · ')}</p>}
    {allocation.diagnostics.length > 0 && <p className="data-note">{allocation.diagnostics.join(' · ')}</p>}
  </section>;
}

// ---------- App ----------

export default function PortfolioBuilder() {
  const [basket, setBasket] = useState([]);
  const [holding, setHolding] = useState(null);
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState('connect');
  const [allocation, setAllocation] = useState(null);
  const [coins, setCoins] = useState([]);
  const [catalogError, setCatalogError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [routes, setRoutes] = useState({});
  const [correlations, setCorrelations] = useState({ key: '', values: {} });
  const [budget, setBudget] = useState('25');
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState(null);
  const [cashReserves, setCashReserves] = useState(['ustry']);
  const [supportedReserves, setSupportedReserves] = useState(['ustry']);
  const [basketAnalytics, setBasketAnalytics] = useState({ key: '', value: null });
  const buildRequest = useRef(null);

  const address = useStellarWalletStore(s => s.address);
  const connected = useStellarWalletStore(s => s.connected);
  const walletKind = useStellarWalletStore(s => s.walletKind);
  const connecting = useStellarWalletStore(s => s.connecting);
  const connectError = useStellarWalletStore(s => s.error);
  const setPrices = usePriceStore(s => s.set);
  const setBalances = useBalanceStore(s => s.set);
  const bySymbol = usePriceStore(s => s.bySymbol);
  const balByTk = useBalanceStore(s => s.address === address ? s.byTk : EMPTY_HOLDINGS);
  const balLoaded = useBalanceStore(s => s.address === address && s.lastUpdated != null);
  const balError = useBalanceStore(s => s.address === address ? s.error : null);
  const basketKey = [...basket].sort().join(',');
  const reserveKey = [...cashReserves].sort().join(',');
  const reserveValid = cashReserves.length > 0 && cashReserves.every(id => supportedReserves.includes(id) && coins.some(c => c.id === id && routes[c.tk]?.available));
  const candidateCorr = correlations.key === basketKey ? correlations.values : {};
  const correlationLoading = basket.length > 0 && correlations.key !== basketKey;
  const products = coins.filter(c => !RESERVE_IDS.has(c.id));
  const allocationCoins = products.filter(c => basket.includes(c.tk) && c.allocationSupported && routes[c.tk]?.available);

  useEffect(() => { initWalletKit(); }, []);
  useEffect(() => {
    if (connected && phase === 'connect') setPhase('select');
  }, [connected, phase]);

  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setLoading(true);
      setPrices(s => { s.loading = true; });
      try {
        const data = await fetchUniverse(controller.signal);
        if (controller.signal.aborted) return;
        setCoins(data.coins);
        setSupportedReserves(data.cashReserveAssets);
        setBasket(current => current.filter(tk => data.coins.some(c => c.tk === tk && !RESERVE_IDS.has(c.id))));
        setCatalogError(null);
        setPrices(s => { s.bySymbol = data.prices; s.loading = false; s.error = null; s.lastUpdated = Date.now(); });
        setRoutes({});
        setLoading(false);
        for (const coin of data.coins.filter(c => !c.simulated)) {
          if (controller.signal.aborted) return;
          const route = await checkRoute(coin.tk, controller.signal);
          if (!controller.signal.aborted) setRoutes(current => ({ ...current, [coin.tk]: route }));
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setCatalogError(error.message);
        setCoins([]);
        setRoutes({});
        setLoading(false);
        setPrices(s => { s.bySymbol = {}; s.loading = false; s.error = error.message; });
      }
    };
    load();
    const interval = setInterval(load, 300000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [setPrices, refresh]);

  useEffect(() => {
    const controller = new AbortController();
    setCorrelations({ key: '', values: {} });
    if (!basket.length || !coins.length) return () => controller.abort();
    const timer = setTimeout(async () => {
      const ids = coins.filter(c => basket.includes(c.tk)).map(c => c.id);
      const entries = await Promise.all(coins.map(async c => {
        try {
          return [c.tk, await quantRequest('correlations', { basket: ids, token: c.id }, controller.signal)];
        } catch (error) {
          return [c.tk, { status: 'unavailable', error: error.message }];
        }
      }));
      if (!controller.signal.aborted) setCorrelations({ key: basketKey, values: Object.fromEntries(entries) });
    }, 200);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [basketKey, coins]);

  useEffect(() => {
    const controller = new AbortController();
    setBasketAnalytics({ key: '', value: null });
    if (!basket.length || !coins.length) return () => controller.abort();
    const timer = setTimeout(async () => {
      const ids = coins.filter(c => basket.includes(c.tk)).map(c => c.id);
      let value;
      try {
        value = await quantRequest('basket/analytics', { basket: ids }, controller.signal);
      } catch (error) {
        value = { error: error.message };
      }
      if (!controller.signal.aborted) setBasketAnalytics({ key: basketKey, value });
    }, 200);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [basketKey, coins]);

  // Invalidate any pending calculation when its inputs or account change.
  useEffect(() => {
    buildRequest.current?.abort();
    setBuilding(false);
    setBuildError(null);
    setAllocation(null);
    setPhase(address ? 'select' : 'connect');
    return () => buildRequest.current?.abort();
  }, [address, basketKey, holding, amount, budget, reserveKey]);

  // Keep account ownership checks: a late result must never cross wallets.
  useEffect(() => {
    setBalances(s => { s.address = address; s.byTk = {}; s.loading = false; s.error = null; s.lastUpdated = null; });
    setHolding(null); setAmount(''); setAllocation(null); setPhase(address ? 'select' : 'connect');
    if (!address) return;
    let cancelled = false;
    const load = async () => {
      setBalances(s => { s.loading = true; });
      try {
        const byTk = await fetchHoldings(address);
        if (cancelled) return;
        setBalances(s => { s.byTk = byTk; s.loading = false; s.error = null; s.lastUpdated = Date.now(); });
      } catch (error) {
        if (!cancelled) setBalances(s => { s.loading = false; s.error = error.message; });
      }
    };
    load();
    const interval = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [address, setBalances]);

  const balanceUsd = useMemo(() => {
    if (!balLoaded || !coins.length) return null;
    const values = coins.filter(c => (balByTk[c.tk] ?? 0) > 0).map(c => referenceValue(bySymbol, c.tk, balByTk[c.tk]));
    return values.some(v => v == null) ? null : values.reduce((sum, value) => sum + value, 0);
  }, [balLoaded, balByTk, bySymbol, coins]);
  const wallet = connected && address ? { kind: walletKind || 'Wallet', addr: truncateAddr(address), balance: balanceUsd, balanceError: balError } : null;
  const maxMcap = Math.max(1, ...coins.map(c => c.mcap ?? 0));
  const sortedCoins = [...products].sort((a, b) => {
    const selected = Number(basket.includes(b.tk)) - Number(basket.includes(a.tk));
    if (selected) return selected;
    if (basket.length) return (candidateCorr[a.tk]?.correlation ?? 2) - (candidateCorr[b.tk]?.correlation ?? 2);
    return (b.mcap ?? -1) - (a.mcap ?? -1);
  });

  const onBuild = async () => {
    const capital = fundingValue(bySymbol, holding, Number(amount));
    if (!reserveValid || !capital || !Number.isFinite(capital) || !allocationCoins.length || !balLoaded || balError || Number(amount) > (balByTk[holding] ?? 0)) return;
    buildRequest.current?.abort();
    const controller = new AbortController();
    buildRequest.current = controller;
    setBuilding(true); setBuildError(null); setAllocation(null);
    try {
      const result = await quantRequest('builder/targets', { assets: allocationCoins.map(c => c.id), portfolio_value_usdc: capital, annual_volatility_budget: Number(budget) / 100, ...(reserveKey === 'ustry' ? {} : { cash_reserves: cashReserves }) }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status !== 'valid' || !result.positions) {
        setBuildError(`Allocation blocked: ${result.diagnostics?.join(' · ') || 'Required inputs are unavailable'}`);
        return;
      }
      setAllocation({ ...result, owner: address }); setPhase('allocated');
    } catch (error) {
      if (!controller.signal.aborted) setBuildError(error.message);
    } finally {
      if (!controller.signal.aborted) setBuilding(false);
    }
  };

  return <div id="root">
    <div className="data-banner">Beta · Quant market data and allocation · Vault returns and execution are simulated</div>
    <Masthead wallet={wallet} onDisconnect={() => { buildRequest.current?.abort(); disconnectWallet(); setBasket([]); setHolding(null); setAmount(''); setAllocation(null); setPhase('connect'); }} />
    <Ticker coins={products} />
    {phase === 'connect' && <ConnectScreen onConnect={kind => connectWallet(kind).catch(() => {})} connecting={connecting} error={connectError} />}
    <div className={phase === 'allocated' ? 'locked' : ''}>
      <div className="section-bar"><span className="num-mark">02</span><h2>Universe — pick the candidates</h2><span className="meta">{basket.length ? `${basket.length} selected · lowest correlation first` : 'Select products to compare'}</span></div>
      <div className="data-toolbar"><span role="status">{loading ? 'Loading quant market data…' : catalogError ? `Market data unavailable: ${catalogError}` : `${products.length} products from the quant universe · daily reference data`}</span><button className="btn ghost" disabled={loading} onClick={() => setRefresh(v => v + 1)}>Refresh data</button></div>
      <div className="two-col"><div className="coin-grid">{sortedCoins.map(c => <CoinCard key={c.tk} coin={c} selected={basket.includes(c.tk)} correlation={candidateCorr[c.tk]} correlationLoading={correlationLoading} hasBasket={basket.length > 0} onToggle={() => setBasket(current => current.includes(c.tk) ? current.filter(t => t !== c.tk) : [...current, c.tk])} maxMcap={maxMcap} route={routes[c.tk]} />)}</div><Sidecar basket={basket} coins={coins} analytics={basketAnalytics.key === basketKey ? basketAnalytics.value : null} analyticsLoading={basket.length > 0 && basketAnalytics.key !== basketKey} removeFromBasket={tk => setBasket(current => current.filter(t => t !== tk))} /></div>
      {wallet && <>
        <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">03</span><h2>Funding — capital source &amp; amount</h2><span className="meta">Hypothetical allocation</span></div>
        <FundingPanel coins={coins} allocationCoins={allocationCoins} excludedCoins={coins.filter(c => basket.includes(c.tk) && !allocationCoins.includes(c))} selectedHolding={holding} setSelectedHolding={setHolding} amount={amount} setAmount={setAmount} onBuild={onBuild} building={building} error={buildError} budget={budget} setBudget={setBudget} reserveValid={reserveValid} reserveSelector={<CashReservePanel selected={cashReserves} onChange={setCashReserves} supported={supportedReserves} routes={routes} coins={coins} />} />
      </>}
    </div>
    {phase === 'allocated' && allocation?.owner === address && <><div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">05</span><h2>Allocation — model targets</h2><span className="meta">Simulation only</span></div><AllocStage allocation={allocation} coins={coins} onReset={() => { setAllocation(null); setPhase('select'); }} /></>}
    <footer className="data-footer"><span>ETESIA RESEARCH</span><span>Live wallet balances · daily quant analytics · simulated vault returns · allocation preview, no funds moved</span></footer>
  </div>;
}
