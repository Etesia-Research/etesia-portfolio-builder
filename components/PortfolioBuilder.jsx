"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import useStellarWalletStore from "@/stores/useStellarWalletStore";
import { initWalletKit, connectWallet, disconnectWallet } from "@/components/stellar/walletKit";
import usePriceStore from "@/stores/usePriceStore";
import { fundingValue, referenceValue } from "@/lib/prices";
import { fetchUniverse, quantRequest } from "@/lib/quant";
import ExecutionSimulation from "@/components/ExecutionSimulation";
import TestnetExecution, { valueSources } from "@/components/TestnetExecution";
import AllocationSimulation from "@/components/AllocationSimulation";
import useBalanceStore from "@/stores/useBalanceStore";
import { fetchHoldings } from "@/lib/balances";
import { testnetSelectable, tokenUnits, xlmSourceKeep } from "@/lib/execution";
import { SHARE_DECIMALS, fromUnits, vaultClient } from "@/lib/vault";
import { MAINNET, TESTNET } from "@/lib/network";
import { VAULTS, builderHref, builderNetwork, vaultHref } from "@/lib/vaults";
import NetworkSwitch from "@/components/NetworkSwitch";

const VaultCatalogEntry = dynamic(() => import("@/components/VaultCatalogEntry"), { ssr: false, loading: () => null });
const EMPTY_HOLDINGS = {};
const RESERVE_IDS = new Set(['usdc', 'eurc', 'ustry']);


// On testnet only products with a Soroswap testnet market for the same asset,
// the testnet vault and USDC can be selected (lib/execution.ts testnetSelectable).
const selectableOn = (network, id) => network !== 'testnet' || testnetSelectable(id, TESTNET);
const notSelectable = (tk) => `Not selectable on testnet · no Soroswap testnet market for ${tk}`;

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
// Stored daily closes use the following midnight UTC as their boundary.
const fmtCloseDate = (stamp) => stamp ? fmtDate(new Date(new Date(stamp).getTime() - 86400000)) : 'unavailable';
const metricNote = (metric, error) => error || metric?.reason || (metric ? `${metric.simulated ? 'Simulated · ' : ''}${metric.stale ? 'Stale · ' : ''}Window · ${fmtCloseDate(metric.window_start)} to ${fmtCloseDate(metric.window_end)}` : 'Loading…');

const fmtPercent = value => value == null ? '—' : `${(value * 100).toFixed(2)}%`;

function ProductLogo({ coin, className = 'gl' }) {
  return <div className={className} style={{ background: coin?.logo ? '#f3eee3' : coin?.color }} aria-hidden="true">
    {coin?.logo ? <img src={coin.logo} alt="" className="product-logo" /> : coin?.glyph}
  </div>;
}

// ---------- Components ----------

function Masthead({ wallet, onDisconnect, network, onNetwork }) {
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
          <NetworkSwitch active={network} href={builderHref} onSelect={onNetwork} />
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          {/* TODO(Step 4): replace with the real latest ledger sequence from Horizon */}
          <span>{MAINNET.label}{network === 'testnet' ? ' market data · testnet balances and execution' : ''}</span>
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

// A vault deployed on the active network has its indexed price on its card, so
// the ticker leaves out its simulated $1 price.
function Ticker({ coins, network }) {
  const bySymbol = usePriceStore(s => s.bySymbol);
  const shown = coins.filter(c => !VAULTS.some(v => v.coin === c.id && v.networks[network]));
  const lane = <div className="lane">{shown.concat(shown).map((c, i) => {
    const price = bySymbol[c.tk];
    return <span key={i} className="it"><strong>{c.tk}</strong>&nbsp;{fmtUsd(price?.price, price?.price < 1 ? 4 : 2)}&nbsp;
      <span style={{ fontSize: 10 }}>{c.simulated ? 'under construction' : price?.price == null ? 'unavailable' : `${price.stale ? 'stale ' : ''}close ${fmtCloseDate(price.ts)}`}</span>
    </span>;
  })}</div>;
  return <div className="ticker">{lane}{lane}</div>;
}

function ConnectScreen({ onConnect, connecting, error, network }) {
  const config = network === 'testnet' ? TESTNET : MAINNET;
  const wallets = [
    { kind: 'Freighter', sub: 'Browser extension', glyph: '◉' },
    { kind: 'Albedo', sub: 'Web signer', glyph: '◐' },
    { kind: 'xBull', sub: 'Multi-platform', glyph: '◑' },
    { kind: 'Lobstr Vault', sub: 'Mobile', glyph: '◯' },
    { kind: 'HOT Wallet', sub: 'Extension · Telegram · mobile', glyph: '◉' },
  ].filter(w => config.wallets.includes(w.kind));
  return (
    <section className="connect-stage fade-in">
      <div>
        <div className="stamp">Step 01 — Authentication</div>
        <h3>Begin by <em>connecting</em><br/>your Stellar wallet.</h3>
        <p>
          {network === 'testnet' ? <>Etesia calculates risk-parity allocations from daily market data. Explore the product universe,
          compare the testnet vault, and execute allocations from your testnet balances as wallet-signed testnet transactions.</> : <>Etesia calculates risk-parity allocations from daily market data. Explore the product universe,
          compare the simulated vault, and preview allocations using your wallet balances.</>}
        </p>
        <p className="mono" style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 14, letterSpacing: '0.06em' }}>
          {network === 'testnet' ? <>Network · Stellar Testnet &nbsp;·&nbsp; Execution · Wallet-signed testnet transactions, test funds only</> : <>Network · Stellar Mainnet &nbsp;·&nbsp; Execution · Simulated</>}
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

// A vault card's one status line for the active network.
// (Mainnet research figures below it are labelled simulated.)
function vaultStatus(network, deployment) {
  const label = network === 'mainnet' ? 'Mainnet' : 'Testnet';
  return deployment ? `${label} vault · ${deployment.epoch}` : `${label} vault not deployed yet`;
}

// Why the Builder prices a vault at a simulated $1 per share, naming only the active network.
const simulatedShareReason = (vault, network) => vault.networks[network] ? `not the ${network} vault's indexed share price` : `there is no ${network} vault`;

function CoinCard({ coin, network, selected, correlation, correlationLoading, hasBasket, onToggle, maxMcap }) {
  const selectable = selectableOn(network, coin.id);
  const mcapFrac = coin.mcap > 0 && maxMcap > 1 ? Math.min(1, Math.log10(coin.mcap) / Math.log10(maxMcap)) : 0;
  const corr = correlation?.status === 'available' ? correlation.correlation : null;
  // A vault's card shows only the active network's vault: where it is deployed,
  // its indexed figures replace the simulated research analytics.
  const vault = VAULTS.find(v => v.coin === coin.id);
  const deployment = vault ? vault.networks[network] : null;
  const indexedVault = Boolean(deployment);
  return (
    <div className={`product-card-wrap ${selected ? 'is-selected' : ''}`}>
    <button type="button" className={`coin-card ${selected ? 'selected' : ''}`} onClick={onToggle} data-tk={coin.tk} aria-pressed={selected} disabled={!selectable}>
      <div className="top"><ProductLogo coin={coin} className="glyph" /><div className="check">{selected ? '✓' : ''}</div></div>
      <div className="name-line"><div className="tk">{coin.tk}</div><div className="nm">{coin.name}</div></div>
      {vault && <div className="product-status">{vaultStatus(network, deployment)}</div>}
      {!selectable && <div className="product-status">{notSelectable(coin.tk)}</div>}
      {coin.simulated && !vault && <div className="product-status">Under construction · simulated returns</div>}
      {!coin.simulated && !coin.allocationSupported && <div className="product-status">Analytics only · allocation API update required</div>}
      {['eth', 'btc'].includes(coin.id) && <div className="data-note">Underlying price history</div>}
      {hasBasket && !indexedVault && <div className={`corr-pill ${corr == null ? '' : corrColor(corr)}`} title={metricNote(correlation, correlation?.error)}>
        {correlationLoading ? 'ρ loading…' : corr == null ? 'ρ unavailable' : `ρ ${corr.toFixed(2)}${correlation.simulated ? ' · simulated' : ''}${correlation.stale ? ' · stale' : ''}`}
      </div>}
      {indexedVault ? <VaultCatalogEntry indexer={deployment.indexer} /> : <>
      <div className="stats">
        {!vault && <div title={`${coin.marketCap.reason || ''} ${coin.marketCap.as_of ? fmtDate(coin.marketCap.as_of) : ''}`}>
          <div className="stat-label">{coin.marketCap.basis === 'issuer_net_value' ? 'Issuer net value' : 'Market cap'}{coin.marketCap.stale && coin.mcap != null ? ' · stale' : ''}</div>
          <div className="stat-val">{fmtMcap(coin.mcap)}</div><div className="bar-track"><div className="bar-fill" style={{ width: `${mcapFrac * 100}%` }} /></div>
        </div>}
        <div title={metricNote(coin.analytics, coin.analyticsError)}>
          <div className="stat-label">Sharpe · annualized{coin.simulated ? ' · simulated' : ''}</div>
          <div className="stat-val">{coin.sharpe == null ? '—' : coin.sharpe.toFixed(2)}</div>
        </div>
      </div>
      <div className="data-note">{metricNote(coin.analytics, coin.analyticsError)}</div>
      </>}
      {hasBasket && !indexedVault && !correlationLoading && corr == null && <div className="data-note">{correlation?.reason || correlation?.error || 'Correlation unavailable'}</div>}
    </button>
    {vault && <div className="product-links">
      <a href={vaultHref(vault, network)} aria-label={`Open the ${vault.name} ${network} vault page`}>Open vault <span aria-hidden="true">→</span></a>
    </div>}
    </div>
  );
}

function Sidecar({ basket, coins, removeFromBasket, analytics, analyticsLoading, network }) {
  return <aside className="sidecar">
    <h4>Working basket — {basket.length} {basket.length === 1 ? 'asset' : 'assets'}</h4>
    {!basket.length && <div className="empty">An empty page awaits the first pick.</div>}
    {coins.filter(c => basket.includes(c.tk)).map(c => { const vault = VAULTS.find(v => v.coin === c.id); return <div className="basket-row" key={c.tk}>
      <ProductLogo coin={c} />
      <div><div className="tk">{c.tk}</div><div className="data-note">{vault ? vaultStatus(network, vault.networks[network]) : c.simulated ? 'Under construction · simulated' : c.name}</div></div>
      <button className="rm" aria-label={`Remove ${c.tk}`} onClick={() => removeFromBasket(c.tk)}>×</button>
    </div>; })}
    {basket.length > 0 && <div className="metrics" aria-live="polite" aria-busy={analyticsLoading}>
      <div className="row"><span className="lbl">Avg. pairwise correlation</span><span className="val">{analyticsLoading ? '…' : analytics?.average_pairwise_correlation?.toFixed(2) ?? '—'}</span></div>
      {!analyticsLoading && analytics?.pairwise_reason && <div className="data-note">{analytics.pairwise_reason}</div>}
      <div className="row"><span className="lbl">Basket SR · annualized</span><span className="val">{analyticsLoading ? '…' : analytics?.sharpe_annualized?.toFixed(2) ?? '—'}</span></div>
      {!analyticsLoading && analytics?.sharpe_reason && analytics.sharpe_reason !== analytics.pairwise_reason && <div className="data-note">{analytics.sharpe_reason}</div>}
      <div className="row"><span className="lbl">Return · annualized (CAGR)</span><span className="val">{analyticsLoading ? '…' : fmtPercent(analytics?.return_annualized)}</span></div>
      <div className="row"><span className="lbl">Max drawdown</span><span className="val">{analyticsLoading ? '…' : fmtPercent(analytics?.max_drawdown == null ? null : -analytics.max_drawdown)}</span></div>
      <div className="row"><span className="lbl">Calmar · annualized</span><span className="val">{analyticsLoading ? '…' : analytics?.calmar?.toFixed(2) ?? '—'}</span></div>
      {!analyticsLoading && analytics?.calmar_reason && analytics.calmar_reason !== analytics.pairwise_reason && <div className="data-note">{analytics.calmar_reason}</div>}
      <div className="data-note">Up to 3Y · equal initial weights · buy and hold · USD · 0% risk-free rate. Correlation averages distinct product pairs.</div>
      <div className="data-note">{analyticsLoading ? 'Calculating basket metrics…' : analytics?.error || (analytics?.window_end ? `Window · ${fmtCloseDate(analytics.window_start)} to ${fmtCloseDate(analytics.window_end)}${analytics.stale ? ' · stale data' : ''}` : '')}</div>
    </div>}
    <p className="data-note">Sharpe uses the arithmetic mean of daily portfolio returns, not CAGR or an average of product ratios. With negative returns, lower volatility can make Sharpe more negative.</p>
    <p className="data-note">ρ compares each product with this basket over up to three years, using equal capital at the start of the window and fixed quantities thereafter.</p>
    {basket.includes('ETESIA-TF') && <p className="data-note">Basket metrics include simulated vault returns. The vault is included in allocation using simulated history and a simulated $1 share price: {simulatedShareReason(VAULTS.find(v => v.coin === 'etesia-tf'), network)}.</p>}
  </aside>;
}

function CashReservePanel({ selected, onChange, supported, coins, network = 'mainnet' }) {
  const options = [
    { id: 'usdc', name: 'USD Coin', logo: '/logos/usdc.svg' },
    { id: 'eurc', name: 'Euro Coin', logo: '/logos/eurc.svg' },
    { id: 'ustry', name: 'USTRY', logo: '/logos/ustry.png' },
  ];
  return <section className="cash-reserve-stage">
    <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">04</span><h2>Cash reserve</h2><span className="meta">Equal split across selected assets</span></div>
    <div className="reserve-options">{options.map(option => {
      const coin = coins.find(c => c.id === option.id);
      const selectable = selectableOn(network, option.id);
      const available = !!coin && supported.includes(option.id) && selectable;
      const reason = !selectable ? notSelectable(option.id.toUpperCase()) : !coin ? 'Daily data unavailable' : !supported.includes(option.id) ? 'Reserve API update required' : 'Daily history available';
      const standIn = network === 'testnet' && option.id === 'ustry' ? ` · USTRY stand-in on testnet: Etesia-issued tRESERVE ${TESTNET.assets.tRESERVE.address}` : '';
      return <label key={option.id} className={`reserve-option ${selected.includes(option.id) ? 'selected' : ''}`}>
        <input type="checkbox" checked={selected.includes(option.id)} disabled={!available && !selected.includes(option.id)} onChange={() => onChange(selected.includes(option.id) ? selected.filter(id => id !== option.id) : [...selected, option.id])} />
        <ProductLogo coin={coin || option} />
        <span><strong>{option.id.toUpperCase()}</strong><span className="data-note">{option.name} · {reason}{standIn}</span></span>
        {selected.includes(option.id) && <span className="reserve-share">{(100 / selected.length).toFixed(0)}% of reserve</span>}
      </label>;
    })}</div>
    <p className="data-note">{selected.length ? `Residual cash is split equally across ${selected.map(id => id.toUpperCase()).join(' and ')}. The 2.5% USDC and 2.5% XLM buffers are separate.` : 'Select at least one cash reserve asset to calculate an allocation.'}</p>
  </section>;
}

// The wallet's holdings that can source an allocation or a rebalance, each
// with its selectable maximum in units. Testnet: XLM (less the most a run
// keeps back), USDC, tRESERVE (the USTRY stand-in) and the vault's shares;
// mainnet: the universe holdings. testnet is the account and vault position
// read for the connected owner.
function holdingRows(network, coins, balByTk, testnet) {
  const coin = (tk) => coins.find(c => c.tk === tk);
  const units = (tk) => BigInt(Math.round((balByTk[tk] ?? 0) * 1e7));
  if (network !== 'testnet') return coins.filter(c => (balByTk[c.tk] ?? 0) > 0).map(c => ({ symbol: c.tk, coin: c, name: c.name, held: units(c.tk), max: units(c.tk), decimals: 7 }));
  const keep = testnet?.account ? xlmSourceKeep(testnet.account, TESTNET) : null;
  const xlm = units('XLM'), position = testnet?.position;
  const keepNote = keep != null ? `MAX keeps ${tokenUnits(keep)} XLM back for fees and the account reserve` : testnet?.accountError ? 'could not read the testnet account' : 'reading the testnet account…';
  return [
    { symbol: 'XLM', coin: coin('XLM'), name: `${coin('XLM')?.name ?? 'Stellar Lumens'} · ${keepNote}`,
      held: xlm, max: keep != null && xlm > keep ? xlm - keep : BigInt(0), decimals: 7 },
    { symbol: 'USDC', coin: coin('USDC'), name: coin('USDC')?.name ?? 'USD Coin', held: units('USDC'), max: units('USDC'), decimals: 7 },
    { symbol: 'tRESERVE', coin: coin('USTRY'), name: 'USTRY stand-in on testnet', held: units('tRESERVE'), max: units('tRESERVE'), decimals: 7 },
    position && { symbol: 'ETESIA-TF', coin: coin('ETESIA-TF'), name: `Vault shares · ${fromUnits(position.value, TESTNET.usdc.decimals)} USDC`, held: position.shares, max: position.shares, decimals: SHARE_DECIMALS, value: position.value },
  ].filter(row => row && row.held > BigInt(0));
}

// A source's percent: 1 to 100, at most two decimals.
const validPercent = (percent) => /^\d{1,3}(?:\.\d{1,2})?$/.test(percent) && Number(percent) >= 1 && Number(percent) <= 100;
const sourcePart = (row, percent) => ({ symbol: row.symbol, percent: Number(percent), quantity: row.max * BigInt(Math.round(Number(percent) * 100)) / BigInt(10000) });
// A testnet build needs the vault position only when the vault is a selected source or in the basket.
const needsPosition = (sources, allocationCoins) => 'ETESIA-TF' in sources || allocationCoins.some(c => c.tk === 'ETESIA-TF');
const amountOf = (quantity, decimals) => Number(fromUnits(quantity, decimals)).toLocaleString(undefined, { maximumFractionDigits: 4 });

function FundingPanel({ coins, allocationCoins, network = 'mainnet', testnet, sources, setSources, onBuild, building, error, budget, setBudget, reserveSelector, reserveValid }) {
  const bySymbol = usePriceStore(s => s.bySymbol);
  // Real onchain holdings (Horizon) — never the static sample data.
  const address = useStellarWalletStore(s => s.address);
  const balByTk = useBalanceStore(s => s.address === address ? s.byTk : EMPTY_HOLDINGS);
  const balLoaded = useBalanceStore(s => s.address === address && s.lastUpdated != null);
  const balError = useBalanceStore(s => s.address === address ? s.error : null);
  const account = testnet?.owner === address ? testnet : null;
  const rows = useMemo(() => holdingRows(network, coins, balByTk, account), [network, coins, balByTk, account]);
  const selected = rows.filter(r => r.symbol in sources);
  const parts = selected.map(r => validPercent(sources[r.symbol]) ? sourcePart(r, sources[r.symbol]) : null);
  const partsValid = parts.length > 0 && parts.every(p => p && p.quantity > BigInt(0));
  // Mainnet: the hypothetical capital is the daily-close value of every selected part.
  const closeValues = network === 'testnet' ? [] : parts.map(p => p && fundingValue(bySymbol, p.symbol, Number(fromUnits(p.quantity, 7))));
  const capital = closeValues.some(v => v == null) ? null : closeValues.reduce((sum, v) => sum + v, 0);
  const unsupported = allocationCoins.filter(c => c.allocationSupported === false);
  const canBuild = !unsupported.length && balLoaded && !balError && partsValid && (network === 'testnet' ? !!account?.position || !needsPosition(sources, allocationCoins) : capital != null) && allocationCoins.length > 0 && Number(budget) > 0 && Number.isFinite(Number(budget)) && !building && reserveValid;
  const setPercent = (symbol, percent) => setSources(current => ({ ...current, [symbol]: percent }));
  const toggle = (symbol) => setSources(current => {
    if (!(symbol in current)) return { ...current, [symbol]: '100' };
    const { [symbol]: _, ...rest } = current;
    return rest;
  });

  return (
    <>
    <section className="funding-panel fade-in">
      <div className="col">
        <h5>① Your holdings — select the sources to allocate or rebalance</h5>
        <div className="holding-list">
          {(balError || rows.length === 0) && (
            <div style={{ padding: 20, fontFamily: "'Instrument Serif', serif", fontStyle: 'italic', color: balError ? 'var(--bad)' : 'var(--ink-2)' }}>
              {balError ? `Could not read balances from Horizon (${balError}).${balLoaded ? " Displayed balances are stale; construction is paused until refresh succeeds." : ""}`
                : balLoaded ? 'No qualifying balances detected in this wallet.'
                : 'Reading balances from Horizon…'}
            </div>
          )}
          {account?.accountError && <div className="data-note" role="alert" style={{ color: 'var(--bad)' }}>Could not read the testnet account ({account.accountError}).</div>}
          {account?.positionError && <div className="data-note" role="alert" style={{ color: 'var(--bad)' }}>Could not read the vault position ({account.positionError}).</div>}
          {rows.map(r => {
            const isSel = r.symbol in sources;
            return (
              <div key={r.symbol} className={`holding-row ${isSel ? 'selected' : ''}`} role="checkbox" aria-checked={isSel} tabIndex={0} onClick={() => toggle(r.symbol)}
                onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(r.symbol); } }}>
                <ProductLogo coin={r.coin} />
                <div>
                  <div className="tk">{r.symbol}</div>
                  <div className="sub">{r.name}</div>
                </div>
                <div className="amt">{amountOf(r.held, r.decimals)}</div>
                <div className="usd">{r.value != null ? fmtUsd(Number(fromUnits(r.value, 7))) : fmtUsd(referenceValue(bySymbol, r.symbol, Number(fromUnits(r.held, 7))))}</div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="col">
        <h5>② Share of each source</h5>
        <div className="amount-block">
          {!selected.length && <div className="data-note">Select one or more holdings. Each starts at 100% (MAX) and can be adjusted.</div>}
          {selected.map((r, index) => {
            const part = parts[index];
            const value = network === 'testnet' ? null : closeValues[index];
            return <div key={r.symbol} className="amount-block" data-source={r.symbol}>
              <div className="amount-input-wrap">
                <span className="pre">{r.symbol}</span>
                <input type="text" inputMode="decimal" aria-label={`Percent of ${r.symbol}`} value={sources[r.symbol]} onChange={e => setPercent(r.symbol, e.target.value.replace(/[^0-9.]/g, ''))} />
                <span className="unit">%</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div className="quick-amounts">
                  {['25', '50', '75', '100'].map(p => (
                    <button key={p} className="qa" onClick={() => setPercent(r.symbol, p)}>{p === '100' ? 'MAX' : `${p}%`}</button>
                  ))}
                </div>
                <div className="mono" style={{ fontSize: 12, color: part && part.quantity > BigInt(0) ? 'var(--ink-2)' : 'var(--bad)' }}>
                  {!part ? 'Enter a percentage from 1 to 100, with at most two decimals.'
                    : part.quantity <= BigInt(0) ? `Nothing to allocate: no ${r.symbol} is selectable at this percentage.`
                    : `${fromUnits(part.quantity, r.decimals)} ${r.symbol === 'ETESIA-TF' ? 'shares' : r.symbol}${network === 'testnet' ? '' : ` ≈ ${fmtUsd(value)} · daily close`}`}
                </div>
              </div>
            </div>;
          })}
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
          <div>{allocationCoins.length ? `Allocation products: ${allocationCoins.map(c => c.tk).join(', ')}.` : 'Select a product with an available allocation model.'}</div>
          {unsupported.length > 0 && <div>Allocation API update required for {unsupported.map(c => c.tk).join(', ')}.</div>}
          <div>{network === 'testnet' ? "Valued at testnet Soroswap quotes and the vault's share value when built, including reserves and buffers."
            : capital == null ? 'A fresh source close and matching USDC/USD close are required.' : `Hypothetical capital: ${capital.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC, including reserves and buffers.`}</div>
          {error && <div role="alert" style={{ color: 'var(--bad)' }}>{error}</div>}
        </div>
        <button className="btn lg" disabled={!canBuild} onClick={onBuild}><span className="dot" />{building ? 'Calculating…' : 'Build risk-parity portfolio'}<span>→</span></button>
      </div>
    </section>
    </>
  );
}


// With the 95% gross allocation cap binding, no residual cash is left for the
// selected reserve: the products reach less volatility than the budget fully invested.
function emptyReserveNote(allocation) {
  if (!allocation.binding_constraints.includes('gross_allocation_cap') || allocation.allocated_sleeve_volatility == null) return null;
  const reserves = (allocation.parameters?.cash_reserves ?? ['ustry']).map(id => id.toUpperCase()).join(' and ');
  const budget = (allocation.parameters.builder.annual_volatility_budget * 100).toFixed(2);
  const reached = (allocation.allocated_sleeve_volatility * 100).toFixed(2);
  return `No ${reserves} reserve: fully invested, the selected products reach ${reached}% annual volatility, below the ${budget}% budget, so the model invests the 95% maximum and leaves no residual cash for the reserve. A volatility budget below ${reached}% keeps a reserve.`;
}

function AllocStage({ allocation, coins, onReset, network, onExecuted }) {
  const productAllocation = allocation.requested_assets.reduce((sum, id) => sum + (allocation.positions[id]?.allocation_fraction || 0), 0);
  const ordered = Object.entries(allocation.positions || {}).filter(([, p]) => p.allocation_fraction > 0).sort((a, b) => b[1].allocation_fraction - a[1].allocation_fraction);
  const coinFor = (id) => coins.find(c => c.id === id.replace('_buffer', '').replace('_reserve', ''));
  const label = (id) => id === 'xlm_buffer' ? 'XLM fee buffer' : id.endsWith('_reserve') ? `${id.split('_')[0].toUpperCase()} reserve` : id === 'usdc' ? 'USDC buffer' : RESERVE_IDS.has(id) ? `${id.toUpperCase()} reserve` : id.toUpperCase();
  return <section className="alloc-stage fade-in">
    <div className="alloc-header"><div><div className="mono uc">Quant allocation preview</div><h3>Equal Risk-Contribution Portfolio</h3></div>
      <div className="ts">{allocation.model_version} · closes through {fmtCloseDate(allocation.market_data_as_of)}</div></div>
    <div className="alloc-bar">{ordered.map(([id, position]) => <div key={id} className={`seg ${position.allocation_fraction < .06 ? 'thin' : ''}`} style={{ background: coinFor(id)?.color || '#5b6470', flexBasis: `${position.allocation_fraction * 100}%` }} title={`${label(id)} ${(position.allocation_fraction * 100).toFixed(2)}%`}>
      <span className="tk">{label(id)}</span><span className="pct">{(position.allocation_fraction * 100).toFixed(1)}%</span>
    </div>)}</div>
    <div className="alloc-table">
      <div className="alloc-row head"><div></div><div>Position</div><div>Allocation</div><div>USDC</div><div>Units</div><div>Reference mark (USDC)</div></div>
      {ordered.map(([id, position]) => <div className="alloc-row" key={id}>
        <ProductLogo coin={coinFor(id)} />
        <div className="nm"><div className="tk">{label(id)}</div><div className="full">{coinFor(id)?.name}</div></div>
        <div className="pct">{(position.allocation_fraction * 100).toFixed(1)}%</div>
        <div className="num">{position.notional_usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
        <div className="num">{position.quantity.toLocaleString(undefined, { maximumFractionDigits: 7 })}</div>
        <div className="num">{position.mark_usdc?.toLocaleString(undefined, { maximumSignificantDigits: 6 }) ?? '—'}</div>
      </div>)}
    </div>
    <div className="trade-cta"><div className="meta-blob">
      <div><div className="lbl">Capital · USDC</div><div className="val">{allocation.portfolio_value_usdc.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div></div>
      <div><div className="lbl">Selected products · allocation</div><div className="val">{(productAllocation * 100).toFixed(2)}%</div></div>
      <div><div className="lbl">Model volatility · annual (1Y inputs)</div><div className="val">{allocation.allocated_sleeve_volatility == null ? '—' : `${(allocation.allocated_sleeve_volatility * 100).toFixed(2)}%`}</div></div>
    </div><button className="btn ghost" onClick={onReset}>← Revise basket</button></div>
    <p className="data-note">{network === 'testnet' ? 'Model targets · units at the daily-close marks. The testnet execution below fills at Soroswap testnet pool prices and the testnet vault’s share price, so the units received differ.' : 'Simulated allocation · reference quantities, no funds moved.'} Product allocation and estimated volatility include every selected product, including the vault. The volatility estimate uses the current risk model’s one-year history and excludes reserves and buffers. The three-year historical metrics below include the entire portfolio.</p>
    <AllocationSimulation allocation={allocation} />
    {network === 'testnet' ? <TestnetExecution allocation={allocation} net={TESTNET} onFinished={onExecuted} /> : <>
    <ExecutionSimulation allocation={allocation} usdcUsd={allocation.usdcUsd} vaultReason={simulatedShareReason(VAULTS.find(v => v.coin === 'etesia-tf'), network)} />
    {VAULTS.filter(v => allocation.positions?.[v.coin]?.notional_usdc > 0).map(v => {
      const leg = allocation.positions[v.coin].notional_usdc;
      const deployment = v.networks[network];
      return deployment
        ? <p className="data-note" key={v.slug}>Only the {v.name} vault leg executes, on {deployment.label}: <a href={`${vaultHref(v, network)}?amount=${leg.toFixed(7)}`}>deposit its {leg.toLocaleString(undefined, { maximumFractionDigits: 2 })} USDC in the {network} vault →</a> The other legs stay quoted above and are not executed.</p>
        : <p className="data-note" key={v.slug}>{network === 'mainnet' ? 'Mainnet' : 'Testnet'} vault not deployed yet: the {v.name} leg is not executed. <a href={vaultHref(v, network)}>{v.name} {network} vault page →</a></p>;
    })}
    </>}
    {allocation.binding_constraints.length > 0 && <p className="data-note">Model limits: {allocation.binding_constraints.map(c => c.replaceAll('_', ' ')).join(' · ')}</p>}
    {emptyReserveNote(allocation) && <p className="data-note">{emptyReserveNote(allocation)}</p>}
    {allocation.diagnostics.length > 0 && <p className="data-note">{allocation.diagnostics.join(' · ')}</p>}
  </section>;
}

// ---------- App ----------

export default function PortfolioBuilder() {
  const [basket, setBasket] = useState([]);
  // Selected sources: holding symbol -> percent of it (text, as typed).
  const [sources, setSources] = useState({});
  // Testnet: the connected owner's account and vault position, or the error reading them.
  const [testnet, setTestnet] = useState(null);
  const [phase, setPhase] = useState('connect');
  const [allocation, setAllocation] = useState(null);
  const [coins, setCoins] = useState([]);
  const [catalogError, setCatalogError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [correlations, setCorrelations] = useState({ key: '', values: {} });
  const [budget, setBudget] = useState('25');
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState(null);
  const [cashReserves, setCashReserves] = useState(['ustry']);
  const [supportedReserves, setSupportedReserves] = useState(['ustry']);
  const [basketAnalytics, setBasketAnalytics] = useState({ key: '', value: null });
  // Mainnet | Testnet mode, kept in the URL (?network=testnet) so links share it.
  const [network, setNetwork] = useState(() => builderNetwork(window.location.search));
  // Products and reserves without a testnet market leave the selection in testnet mode.
  const selectNetwork = (next) => {
    setNetwork(next);
    setBasket(current => current.filter(tk => { const coin = coins.find(c => c.tk === tk); return !coin || selectableOn(next, coin.id); }));
    setCashReserves(current => current.filter(id => selectableOn(next, id)));
    window.history.replaceState(null, '', builderHref(next));
  };
  const buildRequest = useRef(null);

  const address = useStellarWalletStore(s => s.address);
  const connected = useStellarWalletStore(s => s.connected);
  const walletKind = useStellarWalletStore(s => s.walletKind);
  const connecting = useStellarWalletStore(s => s.connecting);
  const connectError = useStellarWalletStore(s => s.error);
  const networkError = useStellarWalletStore(s => s.networkError);
  const setPrices = usePriceStore(s => s.set);
  const setBalances = useBalanceStore(s => s.set);
  const bySymbol = usePriceStore(s => s.bySymbol);
  const balByTk = useBalanceStore(s => s.address === address ? s.byTk : EMPTY_HOLDINGS);
  const balLoaded = useBalanceStore(s => s.address === address && s.lastUpdated != null);
  const balError = useBalanceStore(s => s.address === address ? s.error : null);
  const basketKey = [...basket].sort().join(',');
  const reserveKey = [...cashReserves].sort().join(',');
  const reserveValid = cashReserves.length > 0 && cashReserves.every(id => supportedReserves.includes(id) && coins.some(c => c.id === id));
  const candidateCorr = correlations.key === basketKey ? correlations.values : {};
  const correlationLoading = basket.length > 0 && correlations.key !== basketKey;
  const products = coins.filter(c => !RESERVE_IDS.has(c.id));
  const allocationCoins = products.filter(c => basket.includes(c.tk));

  // The kit signs on the active mode's network: mainnet never signs, testnet executes allocations.
  useEffect(() => { initWalletKit(network === 'testnet' ? TESTNET : MAINNET); }, [network]);
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
        setLoading(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setCatalogError(error.message);
        setCoins([]);
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

  // Invalidate any pending calculation when its inputs or account change. An
  // executed allocation and its receipts stay until the next build; the account
  // and network effect below still clears them.
  useEffect(() => {
    buildRequest.current?.abort();
    setBuilding(false);
    setBuildError(null);
    if (phase === 'executed') return;
    setAllocation(null);
    setPhase(address ? 'select' : 'connect');
    return () => buildRequest.current?.abort();
  }, [address, basketKey, sources, budget, reserveKey, network]);

  // The owner's holdings on the active network: Horizon balances and, on
  // testnet, the account (for the XLM keep-back) and the vault position, read
  // separately so a failed vault read leaves the account (and builds that do
  // not involve the vault) usable. Nothing is written once cancelled.
  const loadHoldings = async (owner, cancelled) => {
    setBalances(s => { s.loading = true; });
    try {
      const byTk = await fetchHoldings(owner, network === 'testnet' ? TESTNET : undefined);
      if (cancelled()) return;
      setBalances(s => { s.byTk = byTk; s.loading = false; s.error = null; s.lastUpdated = Date.now(); });
    } catch (error) {
      if (!cancelled()) setBalances(s => { s.loading = false; s.error = error.message; });
    }
    if (network !== 'testnet') return;
    const client = vaultClient(TESTNET);
    const [account, position] = await Promise.allSettled([client.readUsdcLine(owner), client.readPosition(owner)]);
    if (cancelled()) return;
    const failure = (read) => read.status === 'rejected' ? client.vaultError(read.reason) : null;
    setTestnet({ owner, account: account.value, position: position.value, accountError: failure(account), positionError: failure(position) });
  };

  // After a finished testnet run, read the holdings again.
  useEffect(() => {
    if (phase !== 'executed' || !address) return;
    let cancelled = false;
    loadHoldings(address, () => cancelled);
    return () => { cancelled = true; };
  }, [phase, address, network]);

  // Keep account ownership checks: a late result must never cross wallets.
  useEffect(() => {
    setBalances(s => { s.address = address; s.byTk = {}; s.loading = false; s.error = null; s.lastUpdated = null; });
    setSources({}); setTestnet(null); setAllocation(null); setPhase(address ? 'select' : 'connect');
    if (!address) return;
    let cancelled = false;
    const load = () => loadHoldings(address, () => cancelled);
    load();
    const interval = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [address, network, setBalances]);

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

  // Mainnet values each selected part at the daily close; testnet at testnet
  // execution prices (valueSources), so its build waits for the quotes.
  const onBuild = async () => {
    if (allocationCoins.some(c => c.allocationSupported === false)) {
      setBuildError('The allocation API needs an update for this selection.');
      return;
    }
    const onTestnet = network === 'testnet', account = testnet?.owner === address ? testnet : null;
    const parts = holdingRows(network, coins, balByTk, account).filter(r => r.symbol in sources && validPercent(sources[r.symbol]))
      .map(r => sourcePart(r, sources[r.symbol])).filter(p => p.quantity > BigInt(0));
    const closeValues = onTestnet ? [] : parts.map(p => fundingValue(bySymbol, p.symbol, Number(fromUnits(p.quantity, 7))));
    if (!reserveValid || !parts.length || closeValues.some(v => !v || !Number.isFinite(v)) || (onTestnet && !account?.position && needsPosition(sources, allocationCoins)) || !allocationCoins.length || !balLoaded || balError) return;
    buildRequest.current?.abort();
    const controller = new AbortController();
    buildRequest.current = controller;
    setBuilding(true); setBuildError(null); setAllocation(null); setPhase('select');
    try {
      const valuation = onTestnet ? await valueSources(vaultClient(TESTNET), parts, account.position)
        : Object.fromEntries(parts.map((p, i) => { const value = BigInt(Math.floor(closeValues[i] * 1e7)); return [p.symbol, { quantity: p.quantity, value, minOut: value }]; }));
      if (controller.signal.aborted) return;
      const capital = onTestnet ? Number(fromUnits(Object.values(valuation).reduce((sum, v) => sum + v.value, BigInt(0)), 7)) : closeValues.reduce((sum, v) => sum + v, 0);
      const result = await quantRequest('builder/targets', { assets: allocationCoins.map(c => c.id), portfolio_value_usdc: capital, annual_volatility_budget: Number(budget) / 100, ...(reserveKey === 'ustry' ? {} : { cash_reserves: cashReserves }) }, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status !== 'valid' || !result.positions) {
        setBuildError(`Allocation blocked: ${result.diagnostics?.join(' · ') || 'Required inputs are unavailable'}`);
        return;
      }
      setAllocation({ ...result, owner: address, sources: parts, valuation, usdcUsd: bySymbol.USDC.price }); setPhase('allocated');
    } catch (error) {
      if (!controller.signal.aborted) setBuildError(error.message);
    } finally {
      if (!controller.signal.aborted) setBuilding(false);
    }
  };

  return <div id="root">
    <div className="data-banner">{network === 'testnet'
      ? 'Testnet mode · market data from mainnet daily closes · balances, quotes and execution on Stellar testnet, test funds only'
      : 'Beta · Quant market data and allocation · Vault returns and execution are simulated'}</div>
    {network === 'testnet' && networkError && <p role="alert" className="data-banner" style={{ color: 'var(--bad)' }}>{networkError} Switch networks in the wallet, then return to this tab to re-check.</p>}
    <Masthead network={network} onNetwork={selectNetwork} wallet={wallet} onDisconnect={() => { buildRequest.current?.abort(); disconnectWallet(); setBasket([]); setSources({}); setAllocation(null); setPhase('connect'); }} />
    <Ticker coins={products} network={network} />
    {phase === 'connect' && <ConnectScreen network={network} onConnect={kind => connectWallet(kind).catch(() => {})} connecting={connecting} error={connectError} />}
    <div className={phase === 'allocated' ? 'locked' : ''}>
      <div className="section-bar"><span className="num-mark">02</span><h2>Universe — pick the candidates</h2><span className="meta">{basket.length ? `${basket.length} selected · lowest correlation first` : 'Select products to compare'}</span></div>
      <div className="data-toolbar"><span role="status">{loading ? 'Loading quant market data…' : catalogError ? `Market data unavailable: ${catalogError}` : `${products.length} products from the quant universe · daily reference data`}</span><button className="btn ghost" disabled={loading} onClick={() => setRefresh(v => v + 1)}>Refresh data</button></div>
      <div className="two-col"><div className="coin-grid">{sortedCoins.map(c => <CoinCard key={c.tk} coin={c} network={network} selected={basket.includes(c.tk)} correlation={candidateCorr[c.tk]} correlationLoading={correlationLoading} hasBasket={basket.length > 0} onToggle={() => selectableOn(network, c.id) && setBasket(current => current.includes(c.tk) ? current.filter(t => t !== c.tk) : [...current, c.tk])} maxMcap={maxMcap} />)}</div><Sidecar basket={basket} coins={coins} network={network} analytics={basketAnalytics.key === basketKey ? basketAnalytics.value : null} analyticsLoading={basket.length > 0 && basketAnalytics.key !== basketKey} removeFromBasket={tk => setBasket(current => current.filter(t => t !== tk))} /></div>
      {wallet && <>
        <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">03</span><h2>Funding — your holdings as sources</h2><span className="meta">{network === 'testnet' ? 'Testnet holdings · rebalanced below' : 'Hypothetical allocation'}</span></div>
        <FundingPanel coins={coins} allocationCoins={allocationCoins} network={network} testnet={testnet} sources={sources} setSources={setSources} onBuild={onBuild} building={building} error={buildError} budget={budget} setBudget={setBudget} reserveValid={reserveValid} reserveSelector={<CashReservePanel network={network} selected={cashReserves} onChange={setCashReserves} supported={supportedReserves} coins={coins} />} />
      </>}
    </div>
    {(phase === 'allocated' || phase === 'executed') && allocation?.owner === address && <><div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">05</span><h2>Allocation — model targets</h2><span className="meta">{network === 'testnet' ? 'Executed on Stellar testnet · wallet-signed' : 'Simulation only'}</span></div><AllocStage allocation={allocation} coins={coins} network={network} onReset={() => { setAllocation(null); setPhase('select'); }} onExecuted={() => setPhase(current => current === 'allocated' ? 'executed' : current)} /></>}
    <footer className="data-footer"><span>ETESIA RESEARCH</span><span>{network === 'testnet' ? 'Testnet wallet balances · daily quant analytics · allocation executed as wallet-signed Stellar testnet transactions, test funds only' : 'Live wallet balances · daily quant analytics · simulated vault returns · allocation preview, no funds moved'}</span></footer>
  </div>;
}
