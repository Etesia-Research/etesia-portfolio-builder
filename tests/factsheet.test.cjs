const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");

function pageWith(weights, report) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../app/stellar_tf_vault/page.tsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", "process", "fetch", code)(require, module, module.exports,
    { env: { ETESIA_API_URL: "quant.example.test", ETESIA_API_KEY: "private-test-key" } },
    async url => {
      const data = String(url).endsWith("/weights") ? weights : report;
      return data ? Response.json(data) : new Response("private upstream error", { status: 503 });
    });
  return module.exports.default;
}

const snapshot = {
  status: "valid", market_data_as_of: "2026-09-19T00:00:00Z", decision_time: "2026-09-19T01:00:00Z",
  weights: { xlm: .25, aqua: .25, eth: .25, btc: .25 },
  allocation_fractions: { xlm: 0, aqua: 0, eth: 0, btc: 0, ustry: .95, usdc: .025, xlm_buffer: .025 },
  parameters: { proprietary: "private-model-parameter" },
};
const report = {
  run_id: "a".repeat(20), start: "2020-01-01", end: "2026-09-19", published_at: "2026-09-19T12:00:00Z",
  stale: true, metrics: { cagr: null, sharpe: 0, annualized_volatility: null, maximum_drawdown: .2, blocked_decisions: 10 },
};

test("factsheet preserves zero allocation, null metrics and stale report dates without exposing research parameters", async () => {
  const html = renderToStaticMarkup(await pageWith(snapshot, report)());
  assert.match(html, /0\.00%/);
  assert.match(html, /95\.00%/);
  assert.match(html, /<dd>0\.00<\/dd>/);
  assert.match(html, /<dd>—<\/dd>/);
  assert.match(html, /Stale report/);
  assert.match(html, new RegExp(`/api/quant/vault/backtests/${report.run_id}/files/pdf`));
  assert.doesNotMatch(html, /private-test-key|private-model-parameter|private upstream error/);
});

test("blocked and unavailable allocations never become zero holdings, while reports fail independently", async () => {
  const blocked = renderToStaticMarkup(await pageWith({ ...snapshot, status: "blocked" }, report)());
  assert.match(blocked, /latest model allocation is blocked/);
  assert.doesNotMatch(blocked.split('id="research"')[0], /95\.00%|0\.00%/);
  assert.match(blocked, /Historical workbook/);
  const unavailable = renderToStaticMarkup(await pageWith(null, null)());
  assert.match(unavailable, /Current allocations are temporarily unavailable/);
  assert.match(unavailable, /backtest report is temporarily unavailable/);
  assert.doesNotMatch(unavailable, /files\/pdf|files\/xlsx|private upstream error/);
  const allocationOnly = renderToStaticMarkup(await pageWith(snapshot, null)());
  assert.match(allocationOnly, /95\.00%/);
  assert.match(allocationOnly, /backtest report is temporarily unavailable/);
});
