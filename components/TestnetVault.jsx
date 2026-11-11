"use client";

import { useCallback, useEffect, useState } from "react";
import useStellarWalletStore from "@/stores/useStellarWalletStore";
import { initWalletKit, connectWallet, disconnectWallet } from "@/components/stellar/walletKit";
import { TESTNET } from "@/lib/network";
import { SHARE_DECIMALS, addUsdcTrustline, deposit, exitAll, fromUnits, minBound, maxBound, preview, readPosition, readUsdcLine, toUnits, vaultError, withdraw } from "@/lib/vault";

const truncateAddr = (a) => (a && a.length > 9 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const usdc = (units) => units == null ? '—' : `${fromUnits(units, TESTNET.usdc.decimals)} USDC`;
const shares = (units) => units == null ? '—' : `${fromUnits(units, SHARE_DECIMALS)} shares`;

function Row({ label, value, note }) {
  return <div className="execution-quote"><strong>{label}</strong><span>{value}</span>{note && <span className="data-note">{note}</span>}</div>;
}

function AmountForm({ kind, max, disabled, onSubmit, initial = '' }) {
  const [amount, setAmount] = useState(initial);
  const [quote, setQuote] = useState(null);
  const [error, setError] = useState(null);
  let units = null;
  try { units = amount ? toUnits(amount, TESTNET.usdc.decimals) : null; } catch { units = null; }
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
    {max != null && <div className="quick-amounts"><button className="qa" disabled={disabled || max <= BigInt(0)} onClick={() => { setAmount(fromUnits(max, TESTNET.usdc.decimals)); setError(null); }}>MAX {usdc(max)}</button></div>}
    {overMax && <p role="alert" className="data-note" style={{ color: 'var(--bad)' }}>Above the {kind === 'deposit' ? 'USDC balance' : 'max withdraw'} of {usdc(max)}.</p>}
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

// Vault leg handed over from the Builder's allocation (/testnet?amount=...).
function allocatedAmount() {
  const value = new URLSearchParams(window.location.search).get('amount');
  try { return value && toUnits(value, TESTNET.usdc.decimals) > BigInt(0) ? value : null; } catch { return null; }
}

export default function TestnetVault() {
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
  const [allocated] = useState(allocatedAmount);

  useEffect(() => { initWalletKit(TESTNET); }, []);

  const refresh = useCallback(async () => {
    if (!address) return;
    setReadError(null);
    try {
      const [nextLine, nextPosition] = await Promise.all([readUsdcLine(address), readPosition(address)]);
      setLine(nextLine); setPosition(nextPosition);
    } catch (err) { setReadError(vaultError(err)); }
  }, [address]);
  useEffect(() => { setLine(null); setPosition(null); setReceipts([]); setActionError(null); refresh(); }, [refresh]);

  const run = async (label, action) => {
    setBusy(label); setActionError(null);
    try {
      const receipt = await action();
      setReceipts(current => [receipt, ...current]);
    } catch (err) {
      setActionError(vaultError(err));
    } finally {
      setBusy(null);
      refresh();
    }
  };

  const ready = connected && address && !networkError && !busy;
  const usdcBalance = line?.balance != null ? toUnits(line.balance, TESTNET.usdc.decimals) : null;

  return <div id="root">
    <div className="data-banner">Testnet · pre-reset deployment ({TESTNET.epoch}) · vault deposits and withdrawals are real testnet transactions signed by your wallet · test funds only</div>
    <header className="masthead">
      <div className="left">
        <div className="row"><a href="/">← Portfolio Atelier (mainnet, simulated)</a></div>
        <div className="row" style={{ marginTop: 6 }}><span>{TESTNET.label}</span></div>
        <div className="row" style={{ marginTop: 6 }}><span>Vault {truncateAddr(TESTNET.vault)}</span></div>
      </div>
      <div className="center">
        <div className="eyebrow">— Etesia Research Bulletin —</div>
        <h1>Portfolio Atelier</h1>
        <div className="sub">Etesia-TF flagship vault on Stellar testnet.</div>
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

    <div className="section-bar"><span className="num-mark">01</span><h2>Wallet — connect on testnet</h2><span className="meta">Freighter/Varial · xBull</span></div>
    {!(connected && address) ? <section className="execution-routes">
      <p className="data-note">The wallet must be set to {TESTNET.label} ("{TESTNET.passphrase}"). Freighter/Varial reports its network and signing is blocked on a mismatch. xBull cannot report its network; every signature request pins the testnet passphrase. xBull is not evidenced in the recorded runs.</p>
      <button className="btn lg" disabled={connecting} onClick={() => connectWallet().catch(() => {})}><span className="dot" />{connecting ? 'Connecting… approve in your wallet' : 'Connect wallet'}<span>→</span></button>
      {connectError && <p role="alert" className="data-note" style={{ color: 'var(--bad)' }}>{connectError}</p>}
    </section> : <>
      <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">02</span><h2>Onboarding — USDC trustline</h2><span className="meta">Horizon testnet</span></div>
      <section className="execution-routes">
        {!line && !readError && <p role="status" className="data-note">Reading the account from Horizon…</p>}
        {line && <div className="execution-quote-list">
          <Row label="Account" value={line.funded ? `Funded · ${line.xlm} XLM` : 'Not funded on testnet'} note={line.funded ? null : 'Fund the account with testnet XLM (Friendbot) before adding the trustline.'} />
          <Row label="USDC trustline" value={line.trustline ? `Present · ${line.balance} USDC` : 'Missing'} note={`${TESTNET.usdc.code}:${truncateAddr(TESTNET.usdc.issuer)} · Blend testnet USDC`} />
        </div>}
        {line?.funded && !line.trustline && <button className="btn" disabled={!ready} onClick={() => run('trustline', () => addUsdcTrustline(address))}>Sign &amp; add USDC trustline</button>}
        {line?.trustline && <p className="data-note">Test USDC comes from Blend's testnet faucet: <a href={TESTNET.faucetUrl} target="_blank" rel="noreferrer">{TESTNET.faucetUrl}</a>. Refresh after claiming.</p>}
      </section>

      <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">03</span><h2>Position — shares and liquidity</h2><span className="meta">{position ? `Read from contract at ledger ${position.ledger}` : 'Contract read'}</span></div>
      <section className="execution-routes">
        {!position && !readError && <p role="status" className="data-note">Reading the vault…</p>}
        {readError && <p role="alert" className="data-note" style={{ color: 'var(--bad)' }}>{readError}</p>}
        {position && <div className="execution-quote-list">
          <Row label="Vault shares" value={shares(position.shares)} note="balance(owner) · contract token, 12 decimals" />
          <Row label="Share value" value={usdc(position.value)} note="convert_to_assets(balance)" />
          <Row label="Max withdraw" value={usdc(position.maxWithdraw)} note="max_withdraw(owner) · capped at liquid USDC" />
          <Row label="Vault liquid USDC" value={usdc(position.liquid)} note="liquid_assets()" />
          <Row label="Deposits" value={position.paused ? 'Paused' : 'Open'} note="state().paused" />
        </div>}
        {/* D5-06 seam: indexed NAV, share-price history, rebalance and Blend-yield panels go here once the quant metrics routes exist. */}
        <button className="btn ghost" disabled={!!busy} onClick={refresh}>Refresh</button>
      </section>

      <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">04</span><h2>Deposit and withdraw</h2><span className="meta">Preview → simulate → sign → submit → confirm</span></div>
      <section className="funding-panel">
        <div className="col">
          <h5>① Deposit USDC · deposit_bounded</h5>
          {allocated && <p className="data-note">Prefilled with the vault leg of your Builder allocation: {allocated} USDC. Only this leg executes; the allocation's other legs stay quoted on the Builder and are not executed.</p>}
          <AmountForm kind="deposit" initial={allocated ?? ''} max={usdcBalance} disabled={!ready || !line?.trustline || position?.paused} onSubmit={amount => run('deposit', () => deposit(address, amount))} />
          {position?.paused && <p className="data-note">Deposits are paused on this vault.</p>}
        </div>
        <div className="col">
          <h5>② Partial withdraw · withdraw_bounded</h5>
          <AmountForm kind="withdraw" max={position?.maxWithdraw ?? null} disabled={!ready || !position || position.maxWithdraw <= BigInt(0)} onSubmit={amount => run('withdraw', () => withdraw(address, amount))} />
          <h5 style={{ marginTop: 24 }}>③ Full exit · redeem_bounded</h5>
          <p className="data-note">Redeems the whole share balance for USDC, accepting at least 0.5% below preview_redeem. It fails with a liquidity error if the vault's liquid USDC is below the value of your shares.</p>
          <button className="btn" disabled={!ready || !position || position.shares <= BigInt(0)} onClick={() => run('exit', () => exitAll(address))}>Sign &amp; redeem all shares</button>
        </div>
      </section>
      {busy && <p role="status" className="data-note">Working on {busy}: simulating, then waiting for your wallet signature, then confirming onchain (up to about five minutes)…</p>}
      {actionError && <p role="alert" className="data-note" style={{ color: 'var(--bad)' }}>{actionError}</p>}

      {receipts.length > 0 && <>
        <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">05</span><h2>Receipts</h2><span className="meta">Testnet transactions, not simulations</span></div>
        {receipts.map(receipt => <div key={receipt.hash} role="status" className="tx-receipt">
          <strong>Testnet transaction, not a simulation · {receipt.action}</strong>
          <p>Confirmed in ledger {receipt.ledger}{receipt.returned ? ` · contract returned ${receipt.returned}` : ''}.</p>
          <p className="data-note">Hash <a href={`${TESTNET.explorerUrl}/tx/${receipt.hash}`} target="_blank" rel="noreferrer">{receipt.hash}</a></p>
        </div>)}
      </>}
    </>}
    <footer className="data-footer"><span>ETESIA RESEARCH</span><span>{TESTNET.label} · vault {TESTNET.vault} · values read from the contract, not an indexer</span></footer>
  </div>;
}
