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
    "tokens/etesia-tf/sharpe": { status: "available", sharpe_1y: -0.4, simulated: true, vault_run_id: "run-1" },
    "tokens/ustry/last-close": { price_usd: 1.04, stale: false, as_of: fresh.ts },
    "tokens/ustry/sharpe": { status: "unavailable", sharpe_1y: null, reason: "Missing history" },
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

test("route checks require both buy and sell quotes and preserve atomic integer strings", async () => {
  const calls = [];
  const quant = load("lib/quant.ts", { "@/lib/assets": assets }, { fetch: async (url, options) => {
    calls.push(JSON.parse(options.body));
    return Response.json({ quote: { amountOut: "9007199254740993" }, fetched_at: fresh.ts });
  } });
  assert.equal((await quant.checkRoute("SHX")).available, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].amount, "9007199254740993");
  assert.equal(calls[1].asset_in, assets.ASSET_CONTRACTS.SHX.contract);
  assert.equal((await quant.checkRoute("ETESIA-TF")).available, false);
  const failed = load("lib/quant.ts", { "@/lib/assets": assets }, { fetch: async () => Response.json({ error: "Unavailable" }, { status: 503 }) });
  assert.equal((await failed.checkRoute("SHX")).available, false);
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


test("EURC reserve routes use Circle's mainnet Stellar asset", async () => {
  const { Asset, Networks } = require("@stellar/stellar-sdk");
  const eurc = assets.ASSET_CONTRACTS.EURC;
  assert.equal(eurc.contract, new Asset("EURC", eurc.issuer).contractId(Networks.PUBLIC));
  const calls = [];
  const quant = load("lib/quant.ts", { "@/lib/assets": assets }, { fetch: async (url, options) => {
    calls.push(JSON.parse(options.body));
    return Response.json({ quote: { amountOut: "8700000" }, fetched_at: fresh.ts });
  } });
  assert.equal((await quant.checkRoute("EURC")).available, true);
  assert.equal(calls[0].asset_out, eurc.contract);
  assert.equal(calls[1].asset_in, eurc.contract);
  assert.equal(calls[1].asset_out, assets.ASSET_CONTRACTS.USDC.contract);
});
