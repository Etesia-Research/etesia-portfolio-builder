const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const root = path.join(__dirname, "..");

function load(file, imports = {}, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), code)(name => imports[name] ?? require(name), module, module.exports, ...Object.values(globals));
  return module.exports;
}
const prices = load("lib/prices.ts");
const fresh = { price: 2, ts: "2026-09-19T00:00:00Z", stale: false };

test("funding converts USD to USDC and rejects stale or mismatched observations", () => {
  const marks = { XLM: fresh, USDC: { ...fresh, price: 0.99 } };
  assert.equal(prices.fundingValue(marks, "XLM", 10), 20 / 0.99);
  assert.equal(prices.fundingValue(marks, "USDC", 10), 10);
  assert.equal(prices.fundingValue({ ...marks, XLM: { ...fresh, stale: true } }, "XLM", 10), null);
  assert.equal(prices.fundingValue({ ...marks, USDC: { ...fresh, ts: "yesterday" } }, "XLM", 10), null);
  assert.equal(prices.fundingValue(marks, "MISSING", 10), null);
  for (const qty of [0, -1, NaN, Infinity]) assert.equal(prices.fundingValue(marks, "XLM", qty), null);
  assert.equal(prices.referenceValue({}, "XLM", 10), null);
});

const assets = load("lib/assets.ts");
test("catalog uses API values and preserves null and simulated analytics", async () => {
  const replies = {
    tokens: { tokens: [{ id: "etesia-tf", symbol: "ETESIA-TF", name: "Etesia TF Vault", simulated: true }, { id: "ustry", symbol: "USTRY", name: "USTRY", simulated: false, allocation_supported: false }] },
    "market-caps": { market_caps: [{ token: "ustry", market_cap_usd: 100, basis: "issuer_net_value", stale: true }] },
    "tokens/etesia-tf/last-close": { price_usd: null, stale: true, reason: "No vault share price" },
    "tokens/etesia-tf/sharpe": { status: "available", sharpe_annualized: -0.4, simulated: true, vault_run_id: "run-1" },
    "tokens/ustry/last-close": { price_usd: 1.04, stale: false, as_of: fresh.ts },
    "tokens/ustry/sharpe": { status: "unavailable", sharpe_annualized: null, reason: "Missing history" },
  };
  const quant = load("lib/quant.ts", { "@/lib/assets": assets }, { fetch: async url => Response.json(replies[url.replace("/api/quant/", "")]) });
  const { coins, prices } = await quant.fetchUniverse();
  assert.equal(coins[0].sharpe, -0.4);
  assert.equal(coins[0].analytics.vault_run_id, "run-1");
  assert.equal(prices["ETESIA-TF"].price, null);
  assert.equal(coins[1].sharpe, null);
  assert.equal(coins[1].allocationSupported, false);
  assert.equal(coins[1].marketCap.basis, "issuer_net_value");
});

test("proxy restricts endpoints, keeps credentials server-side, and sanitizes upstream failures", async () => {
  const calls = [];
  const proxy = load("app/api/quant/[...path]/route.ts", {}, {
    process: { env: { ETESIA_API_URL: "quant.example.test", ETESIA_API_KEY: "private-test-key" } },
    fetch: async (url, options) => { calls.push({ url: String(url), options }); return Response.json({ tokens: [] }); },
  });
  const context = path => ({ params: Promise.resolve({ path: path.split("/") }) });
  const response = await proxy.GET(new Request("http://localhost/api/quant/tokens"), context("tokens"));
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "https://quant.example.test/v1/tokens");
  assert.equal(calls[0].options.headers.Authorization, "Bearer private-test-key");
  assert.equal(calls[0].options.redirect, "error");
  assert.ok(!(await response.text()).includes("private-test-key"));
  for (const endpoint of ["tokens/eurc/last-close", "tokens/eurc/sharpe"]) {
    assert.equal((await proxy.GET(new Request("http://localhost"), context(endpoint))).status, 200);
    assert.equal(calls.at(-1).url, `https://quant.example.test/v1/${endpoint}`);
  }
  const basketRequest = new Request("http://localhost/api/quant/basket/analytics", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ basket: ["xlm", "eth"] }),
  });
  assert.equal((await proxy.POST(basketRequest, context("basket/analytics"))).status, 200);
  assert.equal(calls.at(-1).url, "https://quant.example.test/v1/basket/analytics");
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { basket: ["xlm", "eth"] });
  const simulationRequest = new Request("http://localhost/api/quant/builder/simulation", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ weights: { xlm: 1 }, market_snapshot_id: "a".repeat(64) }),
  });
  assert.equal((await proxy.POST(simulationRequest, context("builder/simulation"))).status, 200);
  assert.equal(calls.at(-1).url, "https://quant.example.test/v1/builder/simulation");
  for (const endpoint of ["status", "../status", "tokens/bogus/sharpe", "https://example.org"]) {
    assert.equal((await proxy.GET(new Request("http://localhost"), context(endpoint))).status, 404);
  }
  const failing = load("app/api/quant/[...path]/route.ts", {}, {
    process: { env: { ETESIA_API_URL: "https://quant.example.test", ETESIA_API_KEY: "secret" } },
    fetch: async () => new Response("sensitive upstream body", { status: 401 }),
  });
  const error = await failing.GET(new Request("http://localhost"), context("tokens"));
  assert.equal(error.status, 502);
  assert.ok(!(await error.text()).includes("sensitive"));
});


test("the testnet liquidity path sends its own key and the client's first forwarded hop, and reports a busy or rate-limited top-up", async () => {
  const route = "app/api/quant/[...path]/route.ts";
  const env = { ETESIA_API_URL: "quant.example.test", ETESIA_API_KEY: "private-test-key", ETESIA_LIQUIDITY_API_KEY: "liquidity-test-key" };
  const calls = [];
  let status = 200;
  const proxy = load(route, {}, { process: { env }, fetch: async (url, options) => {
    calls.push({ url: String(url), options });
    return status === 200 ? Response.json({ status: "ready" }) : new Response("upstream detail", { status, headers: { "Retry-After": "15" } });
  } });
  const context = endpoint => ({ params: Promise.resolve({ path: endpoint.split("/") }) });
  const body = { owner: "G".padEnd(56, "A"), build: "2026-11-12T00:00:00Z", swaps: [{ asset_in: "CIN", asset_out: "COUT", amount_in: "10" }] };
  const post = (headers = {}) => new Request("http://localhost/api/quant/testnet/liquidity", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  let response = await proxy.POST(post({ "X-Forwarded-For": "203.0.113.7, 10.0.0.1" }), context("testnet/liquidity"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
  assert.equal(calls[0].url, "https://quant.example.test/v1/testnet/liquidity");
  assert.deepEqual(JSON.parse(calls[0].options.body), body);
  assert.equal(calls[0].options.headers.Authorization, "Bearer liquidity-test-key");
  assert.equal(calls[0].options.headers["X-Etesia-Client"], "203.0.113.7");
  // Without a forwarded hop no client header is sent; other paths keep the quant key and never send one.
  await proxy.POST(post(), context("testnet/liquidity"));
  assert.ok(!("X-Etesia-Client" in calls[1].options.headers));
  await proxy.POST(new Request("http://localhost", { method: "POST", headers: { "X-Forwarded-For": "203.0.113.7" }, body: JSON.stringify({ asset_in: "A", asset_out: "B", amount: "1" }) }), context("quotes"));
  assert.equal(calls[2].options.headers.Authorization, "Bearer private-test-key");
  assert.ok(!("X-Etesia-Client" in calls[2].options.headers));
  for (const code of [409, 429]) {
    status = code;
    response = await proxy.POST(post(), context("testnet/liquidity"));
    assert.equal(response.status, code);
    assert.deepEqual(await response.json(), { error: "Testnet liquidity is busy; retry" });
  }
  // The same codes elsewhere keep the generic message.
  response = await proxy.POST(new Request("http://localhost", { method: "POST", body: "{}" }), context("quotes"));
  assert.deepEqual(await response.json(), { error: "Quant service is temporarily unavailable" });
  assert.equal((await proxy.GET(new Request("http://localhost"), context("testnet/liquidity"))).status, 404);
  // Without its own key the path is not configured, even with the quant key, and nothing is sent.
  const sent = calls.length;
  const unconfigured = load(route, {}, { process: { env: { ...env, ETESIA_LIQUIDITY_API_KEY: "" } }, fetch: async (...args) => { calls.push(args); return Response.json({}); } });
  response = await unconfigured.POST(post(), context("testnet/liquidity"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "Testnet liquidity is not configured" });
  assert.equal(calls.length, sent);
});

test("allocation simulation merges buffers and reserve positions without omitting capital", () => {
  const quant = load("lib/quant.ts", { "@/lib/assets": assets });
  const positions = Object.fromEntries(Object.entries({ xlm: .2, xlm_buffer: .025, usdc: .025, usdc_reserve: .25, ustry: .5, btc: 0 })
    .map(([id, allocation_fraction]) => [id, { allocation_fraction }]));
  assert.deepEqual(quant.simulationWeights(positions), { xlm: .225, usdc: .275, ustry: .5 });
  assert.equal(Object.values(quant.simulationWeights(positions)).reduce((sum, weight) => sum + weight, 0), 1);
});

test("vault downloads preserve binary bytes, bind filenames to a run, and reject other paths and methods", async () => {
  const run = "a".repeat(20);
  const context = endpoint => ({ params: Promise.resolve({ path: endpoint.split("/") }) });
  const bytes = new Uint8Array([0x50, 0x4b, 0, 255, 128, 13, 10]);
  let calls = 0;
  const proxy = load("app/api/quant/[...path]/route.ts", {}, {
    process: { env: { ETESIA_API_URL: "quant.example.test", ETESIA_API_KEY: "private-test-key" } },
    fetch: async (url, options) => {
      calls++;
      assert.equal(options.headers.Authorization, "Bearer private-test-key");
      assert.match(String(url), new RegExp(`/v1/vault/backtests/${run}/files/(pdf|xlsx)$`));
      return new Response(bytes, { headers: { "X-Private": "private-test-key" } });
    },
  });
  for (const format of ["pdf", "xlsx"]) {
    const result = await proxy.GET(new Request("http://localhost"), context(`vault/backtests/${run}/files/${format}`));
    assert.equal(result.status, 200);
    assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
    assert.equal(result.headers.get("Content-Disposition"), `attachment; filename="etesia-tf-${run}.${format}"`);
    assert.match(result.headers.get("Content-Type"), format === "pdf" ? /application\/pdf/ : /spreadsheetml/);
    assert.equal(result.headers.get("Cache-Control"), "no-store");
    assert.equal(result.headers.get("X-Private"), null);
  }
  for (const endpoint of ["vault/weights", "vault/backtests/latest", "vault/backtests/../files/pdf", `vault/backtests/${run}/files/json`, `vault/backtests/${run}/files/pdf/extra`]) {
    assert.equal((await proxy.GET(new Request("http://localhost"), context(endpoint))).status, 404);
  }
  assert.equal((await proxy.POST(new Request("http://localhost", { method: "POST" }), context(`vault/backtests/${run}/files/pdf`))).status, 404);
  assert.equal(calls, 2);
});
