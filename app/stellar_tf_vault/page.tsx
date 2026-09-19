import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Etesia-TF — Strategy Factsheet | Portfolio Atelier",
  description: "Explore the Etesia-TF long-only trend strategy, its selected universe, risk-parity allocation and historical research reports.",
};

type Weights = {
  status: "valid" | "blocked";
  market_data_as_of: string;
  decision_time: string;
  weights: Record<string, number> | null;
  allocation_fractions: Record<string, number> | null;
};
type Backtest = {
  run_id: string;
  start: string;
  end: string;
  published_at: string;
  stale: boolean;
  metrics: Record<string, number | string | boolean | null>;
};

// Keep authenticated research payloads on the server; render only public facts.
async function readQuant<T>(endpoint: string): Promise<T | null> {
  const configured = process.env.ETESIA_API_URL?.trim();
  const key = process.env.ETESIA_API_KEY;
  if (!configured || !key) return null;
  try {
    const base = new URL(configured.includes("://") ? configured : `https://${configured}`);
    const response = await fetch(new URL(`/v1/${endpoint}`, base), {
      headers: { Authorization: `Bearer ${key}` },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(35000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

const universe = [
  { id: "xlm", symbol: "XLM", name: "Stellar", logo: "/logos/xlm.svg", color: "#1d1a14" },
  { id: "aqua", symbol: "AQUA", name: "Aquarius", logo: "/logos/aqua.png", color: "#1f8fc0" },
  { id: "eth", symbol: "ETH", name: "Ethereum", logo: "/logos/eth.svg", color: "#68758a" },
  { id: "btc", symbol: "BTC", name: "Bitcoin", logo: "/logos/btc.png", color: "#b8761a" },
];
const sleeves = [
  ...universe.map(asset => ({ ...asset, label: `${asset.symbol} · trend` })),
  { id: "ustry", label: "USTRY · reserve", color: "#1f5e4a" },
  { id: "usdc", label: "USDC · settlement buffer", color: "#42799d" },
  { id: "xlm_buffer", label: "XLM · network fee buffer", color: "#a49a86" },
];
const percent = (value: number | null | undefined) => value == null ? "—" : `${(value * 100).toFixed(2)}%`;
const date = (value: string) => new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export default async function VaultFactsheet() {
  const [snapshot, report] = await Promise.all([
    readQuant<Weights>("vault/weights"),
    readQuant<Backtest>("vault/backtests/latest"),
  ]);
  const valid = snapshot?.status === "valid";
  const allocation = valid ? snapshot.allocation_fractions : null;
  const weights = valid ? snapshot.weights : null;
  const runId = report && /^[a-f0-9]{20}$/.test(report.run_id) ? report.run_id : null;
  const metric = (key: string) => typeof report?.metrics[key] === "number" ? report.metrics[key] as number : null;
  const trendTotal = allocation ? universe.reduce((sum, asset) => sum + (allocation[asset.id] ?? 0), 0) : null;

  return (
    <main className="factsheet">
      <nav className="factsheet-nav" aria-label="Factsheet navigation">
        <a href="/">← Portfolio Atelier</a>
        <span>Etesia Research <span aria-hidden="true">/</span> Strategy series № 01</span>
      </nav>
      <header className="factsheet-hero">
        <div>
          <div className="factsheet-kicker">Stellar trend-following vault</div>
          <h1>Etesia<span>-TF</span><sup>01</sup></h1>
          <p className="factsheet-deck">Follow the trend.<br /><em>Keep risk in perspective.</em></p>
          <p className="factsheet-intro">A systematic, long-only approach to digital assets. Etesia-TF combines trend-following with risk-parity allocation, adapting exposure as market conditions change.</p>
        </div>
        <aside className="factsheet-identity" aria-label="Strategy profile">
          <img src="/logos/etesia.svg" alt="Etesia Research" width="64" height="64" />
          <div className="factsheet-kicker">Strategy factsheet</div>
          <dl>
            <div><dt>Approach</dt><dd>Systematic · long-only</dd></div>
            <div><dt>Universe</dt><dd>4 digital assets</dd></div>
            <div><dt>Reference currency</dt><dd>USDC</dd></div>
            <div><dt>Review cycle</dt><dd>Daily</dd></div>
            <div><dt>Status</dt><dd>Research preview</dd></div>
          </dl>
          <a href="#research" className="factsheet-text-link">Explore the backtest <span aria-hidden="true">↓</span></a>
        </aside>
      </header>
      <div className="factsheet-edition">
        <span><span className="factsheet-dot" aria-hidden="true" /> Under construction · simulated strategy</span>
        <span>{snapshot ? `Market data as of ${date(snapshot.market_data_as_of)} · 00:00 UTC` : "Market data temporarily unavailable"}</span>
      </div>

      <section className="factsheet-section" aria-labelledby="approach-title">
        <div className="factsheet-section-heading"><span className="factsheet-number">01 / THE APPROACH</span><h2 id="approach-title">A disciplined way to participate.</h2></div>
        <div className="factsheet-principles">
          <article><span>Observe</span><h3>Let price trends lead.</h3><p>The strategy evaluates market trends each day. It can increase long exposure when trends are positive and reduce it when they weaken, without taking short positions.</p></article>
          <article><span>Balance</span><h3>Allocate with risk in mind.</h3><p>Risk-parity weights balance the model’s risk contributions across the selected universe. Trend and volatility adjustments then determine the capital assigned to each asset.</p></article>
          <article><span>Adapt</span><h3>Leave room for reserves.</h3><p>Capital outside the trend positions is allocated to reserves and operating buffers. USTRY is the reserve asset; USDC and XLM support settlement and network fees.</p></article>
        </div>
      </section>

      <section className="factsheet-section" aria-labelledby="allocation-title">
        <div className="factsheet-section-heading"><span className="factsheet-number">02 / UNIVERSE & ALLOCATION</span><h2 id="allocation-title">The portfolio, in focus.</h2></div>
        <p className="factsheet-section-intro">Four selected assets. A monthly risk-parity foundation, with trend-adjusted exposure reviewed daily.</p>
        {!allocation && <p className="factsheet-notice" role="status">{snapshot?.status === "blocked" ? "The latest model allocation is blocked because required data checks have not passed." : "Current allocations are temporarily unavailable."} The selected universe and published research remain available below.</p>}
        <div className="factsheet-allocation-grid">
          <div>
            <div className="factsheet-table-wrap">
              <table className="factsheet-universe">
                <caption>Selected universe · model weights and target capital</caption>
                <thead><tr><th scope="col">Asset</th><th scope="col">Risk-parity weight</th><th scope="col">Target allocation</th></tr></thead>
                <tbody>{universe.map(asset => <tr key={asset.id}>
                  <th scope="row"><div className="factsheet-asset"><img src={asset.logo} alt="" width="30" height="30" /><span>{asset.symbol}<small>{asset.name}</small></span></div></th>
                  <td>{percent(weights?.[asset.id])}</td>
                  <td>{percent(allocation?.[asset.id])}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <p className="factsheet-note">Risk-parity weights describe the model’s risk-balancing mix, not percentages of total portfolio capital. Target allocations include trend and risk adjustments. XLM’s trend position is separate from its network fee buffer.</p>
            <p className="factsheet-note">ETH and BTC research uses underlying asset price history. These figures are hypothetical targets, not live vault holdings or evidence of executable Stellar instruments.</p>
          </div>
          <aside className="factsheet-composition" aria-label="Target portfolio composition">
            <div className="factsheet-kicker">Target portfolio composition</div>
            <div className="factsheet-exposure"><strong>{percent(trendTotal)}</strong><span>allocated to trend positions</span></div>
            <div className="factsheet-stack" aria-hidden="true">{allocation && sleeves.map(sleeve => <span key={sleeve.id} style={{ width: `${(allocation[sleeve.id] ?? 0) * 100}%`, background: sleeve.color }} />)}</div>
            <dl>{sleeves.map(sleeve => <div key={sleeve.id}><dt><span style={{ background: sleeve.color }} aria-hidden="true" />{sleeve.label}</dt><dd>{percent(allocation?.[sleeve.id])}</dd></div>)}</dl>
            <p className="factsheet-note">{snapshot ? `Decision: ${date(snapshot.decision_time)} · 01:00 UTC. ` : ""}Percentages of total hypothetical capital. Rounding may affect totals.</p>
          </aside>
        </div>
      </section>

      <section className="factsheet-section factsheet-research" id="research" aria-labelledby="research-title">
        <div className="factsheet-section-heading"><span className="factsheet-number">03 / HISTORICAL RESEARCH</span><h2 id="research-title">Look back. Understand the path.</h2></div>
        <p className="factsheet-section-intro">Explore the strategy’s historical simulation, including performance, drawdowns and portfolio composition.</p>
        {report ? <>
          <div className="factsheet-period"><span>Backtest · {date(report.start)} — {date(report.end)}</span><span>{report.stale ? "Stale report · latest retained publication" : "Latest published backtest"}</span></div>
          <dl className="factsheet-metrics">
            <div><dt>Annualized return · CAGR</dt><dd>{percent(metric("cagr"))}</dd></div>
            <div><dt>Annualized volatility</dt><dd>{percent(metric("annualized_volatility"))}</dd></div>
            <div><dt>Maximum drawdown</dt><dd>{percent(metric("maximum_drawdown"))}</dd></div>
            <div><dt>Sharpe ratio</dt><dd>{metric("sharpe")?.toFixed(2) ?? "—"}</dd></div>
          </dl>
          <p className="factsheet-note">Simulated results in USDC, after modeled trading costs. Network fees are not modeled. Sharpe uses a 0% risk-free reference; annualized statistics use 365 days. Maximum drawdown is shown as a loss magnitude. {metric("blocked_decisions") != null && `${metric("blocked_decisions")} blocked decisions recorded in this run.`}</p>
          {report.metrics.complete_daily_series === false && <p className="factsheet-notice">This report has incomplete daily valuations. Review the report’s data limitations before interpreting its metrics.</p>}
          {runId && <div className="factsheet-downloads">
            <a href={`/api/quant/vault/backtests/${runId}/files/pdf`}><span className="factsheet-file-type">PDF</span><span><strong>Backtest factsheet</strong><small>Performance, charts & assumptions</small></span><span aria-hidden="true">↓</span></a>
            <a href={`/api/quant/vault/backtests/${runId}/files/xlsx`}><span className="factsheet-file-type">XLSX</span><span><strong>Historical workbook</strong><small>Daily results, allocations & trades</small></span><span aria-hidden="true">↓</span></a>
          </div>}
          <p className="factsheet-note">Published {date(report.published_at)} · Report {report.run_id}. Both downloads refer to the same historical run.</p>
        </> : <p className="factsheet-notice" role="status">The backtest report is temporarily unavailable. Please try again later for performance figures and PDF/XLSX downloads.</p>}
      </section>

      <footer className="factsheet-footer">
        <div><h2>Research with perspective.</h2><p>Backtested performance is hypothetical and does not predict future results. Digital assets can experience substantial losses; trend-following can lag reversals and struggle in sideways markets. Reserves also carry issuer, price and liquidity risks. This research preview is not an operating vault, an investment recommendation or an offer to invest.</p></div>
        <a href="/">Return to Portfolio Atelier <span aria-hidden="true">↗</span></a>
        <div className="factsheet-colophon"><span>ETESIA RESEARCH</span><span>Stellar · Etesia-TF · Strategy factsheet</span></div>
      </footer>
    </main>
  );
}
