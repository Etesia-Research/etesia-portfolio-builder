const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const React = require("react");
function load(file, imports = {}, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), code)(name => imports[name] ?? require(name), module, module.exports, ...Object.values(globals));
  return module.exports;
}
const assets = load("lib/assets.ts");
const positions = Object.fromEntries(Object.entries({ btc: .25, "etesia-tf": .4, ustry: .3, usdc: .025, xlm_buffer: .025 })
  .map(([id, allocation_fraction]) => [id, { allocation_fraction }]));
function harness(fail = false) {
  const calls = [];
  const execution = load("lib/execution.ts", { "@/lib/assets": assets, "@/lib/quant": { quantRequest: async (path, body) => {
    calls.push(body);
    if (fail) throw new Error("Provider unavailable");
    return { fetched_at: new Date().toISOString(), quote: { assetIn: body.asset_in, assetOut: body.asset_out,
      amountIn: body.amount, amountOut: String(BigInt(body.amount) * 2n), otherAmountThreshold: String(BigInt(body.amount) * 199n / 100n) } };
  } } });
  return { ...execution, calls };
}
test("actual-size funding and product quotes conserve capital and assume vault shares at $1", async () => {
  const h = harness();
  const result = await h.executionQuotes({ positions }, { symbol: "EURC", amount: "123.1234567" }, .99);
  assert.equal(h.calls[0].amount, "1231234567");
  assert.equal(h.calls[0].asset_in, assets.ASSET_CONTRACTS.EURC.contract);
  assert.equal(result.capital, "2462469134");
  assert.equal(result.rows.reduce((sum, row) => sum + BigInt(row.amountIn), 0n), BigInt(result.capital));
  assert.equal(h.calls.length, 4); // Funding plus BTC, USTRY, XLM; vault and cash need no swap.
  for (const row of result.rows.filter(row => row.kind === "swap")) {
    assert.equal(BigInt(row.amountOut), BigInt(row.amountIn) * 2n);
    assert.ok(row.minimumOut);
  }
  const vault = result.rows.find(row => row.kind === "vault");
  assert.equal(BigInt(vault.amountOut), BigInt(vault.amountIn) * 99n / 100n);
  assert.equal(vault.fetchedAt, null);
});
test("failed product quotes remain visible and funding failures stop dependent quotes", async () => {
  const h = harness(true);
  const result = await h.executionQuotes({ positions }, { symbol: "USDC", amount: "100" }, 1);
  assert.equal(result.rows.filter(row => row.error).length, 3);
  assert.equal(result.rows.find(row => row.kind === "vault").amountOut, "400000000");
  await assert.rejects(h.executionQuotes({ positions }, { symbol: "XLM", amount: "100" }, 1), /Provider unavailable/);
});
test("atomic arithmetic preserves large integers and rounds funding down", () => {
  const h = harness();
  assert.equal(h.atomicAmount(".5"), 5000000n);
  assert.equal(h.atomicAmount("1."), 10000000n);
  assert.equal(h.atomicAmount("900719925.47409939"), 9007199254740993n);
  assert.equal(h.tokenUnits(9007199254740993n), "900719925.4740993");
  for (const value of ["NaN", "1e9", "-1", "0.00000001"]) assert.throws(() => h.atomicAmount(value));
});
function component(initial = []) {
  const state = [], effects = [], requests = [];
  const execution = harness();
  const module = load("components/ExecutionSimulation.jsx", {
    react: { ...React, useEffect: fn => effects.push(fn), useState: value => {
      const i = state.length; state.push(i in initial ? initial[i] : value);
      return [state[i], next => { state[i] = typeof next === "function" ? next(state[i]) : next; }];
    } },
    "@/lib/execution": { tokenUnits: execution.tokenUnits, executionQuotes: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })) },
  });
  return { ...module, state, effects, requests };
}
function nodes(node) {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const text = node => nodes(node).filter(n => typeof n === "string" || typeof n === "number").join("");
test("execution is disabled for failed or expired quotes; completed receipt uses quoted units", () => {
  const row = { id: "btc", symbol: "BTC", kind: "swap", amountIn: "10000000", amountOut: "20000000", minimumOut: "19900000", fetchedAt: new Date().toISOString(), error: null };
  const preview = { rows: [row], expiresAt: Date.now() + 60000 };
  const button = tree => nodes(tree).find(n => n.type === "button" && text(n).includes("Simulate execution"));
  const props = { allocation: {}, funding: { symbol: "USDC", amount: "1" }, usdcUsd: 1 };
  const h = component([preview]);
  const tree = h.default(props);
  assert.match(text(tree), /1.0000000 USDC → 2.0000000 BTC/);
  assert.equal(button(tree).props.disabled, false);
  button(tree).props.onClick(); assert.equal(h.state[4], true);
  assert.equal(button(component([{ ...preview, expiresAt: 0 }]).default(props)).props.disabled, true);
  assert.equal(button(component([{ ...preview, rows: [{ ...row, error: "Unavailable" }] }]).default(props)).props.disabled, true);
  assert.match(text(component([preview, null, 0, Date.now(), true]).default(props)), /no transactions submitted, and no funds moved/);
});
test("cancelled quotes cannot populate a changed allocation", async () => {
  const h = component();
  h.default({ allocation: {}, funding: { symbol: "USDC", amount: "1" }, usdcUsd: 1 });
  const cleanup = h.effects[0](); cleanup();
  assert.equal(h.requests[0].args[3].aborted, true);
  h.requests[0].resolve({ rows: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state[0], null);
});

test("EURC quotes use Circle's verified Stellar identity", () => {
  const { Asset, Networks } = require("@stellar/stellar-sdk");
  const eurc = assets.ASSET_CONTRACTS.EURC;
  assert.equal(eurc.contract, new Asset("EURC", eurc.issuer).contractId(Networks.PUBLIC));
});
