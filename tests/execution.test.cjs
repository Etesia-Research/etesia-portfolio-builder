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
const network = load("lib/network.ts", { "@/data/testnet-manifest.json": require("../data/testnet-manifest.json") });
const vaults = load("lib/vaults.ts", { "@/lib/network": network });
const positions = Object.fromEntries(Object.entries({ btc: .25, "etesia-tf": .4, ustry: .3, usdc: .025, xlm_buffer: .025 })
  .map(([id, allocation_fraction]) => [id, { allocation_fraction }]));
function harness(fail = false) {
  const calls = [];
  const execution = load("lib/execution.ts", { "@/lib/assets": assets, "@/lib/network": network, "@/lib/vaults": vaults, "@/lib/quant": { quantRequest: async (path, body) => {
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

// D5 allocation on testnet: the leg plan executed by components/TestnetExecution.jsx.
const { TESTNET } = network;
const legsOf = (fractions, funding = { symbol: "USDC", amount: "100" }, capital = 1000000003n) => harness().testnetLegs({
  positions: Object.fromEntries(Object.entries(fractions).map(([id, allocation_fraction]) => [id, { allocation_fraction }])), funding }, capital, TESTNET);
const spent = (legs) => legs.filter(l => l.kind === "swap" || l.kind === "vault").reduce((sum, l) => sum + l.amountIn, 0n);
const mix = { xlm: .3, xlm_buffer: .025, "etesia-tf": .35, ustry: .2, usdc_reserve: .1, usdc: .025, btc: 0 };

test("testnetLegs conserves capital to the stroop and keeps usdc, usdc_reserve and dust as USDC", () => {
  for (const capital of [1000000003n, 7n, 123456789012345n]) {
    const { legs, kept } = legsOf(mix, undefined, capital);
    assert.equal(spent(legs) + kept, capital);
  }
  const { legs, kept } = legsOf(mix);
  const budget = (f) => 1000000003n * BigInt(Math.floor(f * 1e12)) / 1000000000000n;
  assert.equal(kept, 1000000003n - budget(.3) - budget(.025) - budget(.35) - budget(.2));
  assert.ok(kept >= budget(.1) + budget(.025));
  assert.ok(!legs.some(l => l.ids.some(id => id.startsWith("usdc"))));
});

test("testnetLegs merges xlm and xlm_buffer into one USDC → XLM swap and sizes the vault leg from etesia-tf", () => {
  const { legs } = legsOf(mix);
  const budget = (f) => 1000000003n * BigInt(Math.floor(f * 1e12)) / 1000000000000n;
  const xlm = legs.filter(l => l.kind === "swap" && l.symbol === "XLM");
  assert.equal(xlm.length, 1);
  assert.deepEqual(xlm[0].ids, ["xlm", "xlm_buffer"]);
  assert.equal(xlm[0].amountIn, budget(.3) + budget(.025));
  assert.deepEqual(xlm[0].path, [TESTNET.usdc.contract, TESTNET.assets.XLM.address]);
  const reserve = legs.find(l => l.kind === "swap" && l.symbol === "tRESERVE");
  assert.deepEqual(reserve.path, [TESTNET.usdc.contract, TESTNET.assets.tRESERVE.address]);
  const vault = legs.find(l => l.kind === "vault");
  assert.deepEqual([vault.ids, vault.amountIn], [["etesia-tf"], budget(.35)]);
  // Run order: trustlines, swaps, then the vault deposit.
  assert.deepEqual(legs.map(l => l.key), ["trustline:tRESERVE", "swap:XLM", "swap:tRESERVE", "vault:etesia-tf"]);
});

test("with XLM funding the funding swap comes first and keeps XLM back for fees and the reserve", () => {
  const { legs } = legsOf(mix, { symbol: "XLM", amount: "100" }, 1500000000n);
  assert.equal(legs[0].kind, "funding");
  assert.deepEqual([legs[0].amountIn, legs[0].minOut, legs[0].path], [1000000000n, 1500000000n, [TESTNET.assets.XLM.address, TESTNET.usdc.contract]]);
  const { testnetCheck, xlmKeep, FEE_ALLOWANCE } = harness();
  const account = { funded: true, trustline: true, balance: "0.0000000", xlm: "100.0000000", subentries: 1, lines: { USDC: "0.0000000" } };
  // Two base reserves, the USDC line, the tRESERVE line the run adds, and a fee allowance per transaction (5): 7 XLM.
  assert.equal(xlmKeep(1, 1, 5), 4n * 5000000n + 5n * FEE_ALLOWANCE);
  assert.match(testnetCheck(legs, account), /keeping 7\.0000000 XLM back for fees and the account reserve needs 107\.0000000 XLM; the account holds 100\.0000000/);
  assert.equal(testnetCheck(legs, { ...account, xlm: "107.0000000" }), null); // the funding swap supplies the USDC
  assert.equal(testnetCheck(legs, { ...account, xlm: "106.5000000", lines: { USDC: "0", tRESERVE: "0" } }), null); // trustline present: no reserve added for it
  assert.throws(() => legsOf(mix, { symbol: "EURC", amount: "1" }), /EURC cannot fund an allocation on Stellar testnet/);
});

test("XLM funding swaps at most the balance less the run's keep-back, so MAX funding passes the check and Continue after paid fees too", () => {
  const { testnetCheck, xlmFundingIn, runKeep } = harness();
  const account = { funded: true, trustline: true, balance: "0.0000000", xlm: "100.0000000", subentries: 1, lines: { USDC: "0.0000000" } };
  const max = { symbol: "XLM", amount: "100" };
  const fundingIn = xlmFundingIn(1000000000n, legsOf(mix, max, 0n).legs, account);
  assert.equal(fundingIn, 930000000n); // 100 XLM less the 7 XLM kept back
  const { legs } = harness().testnetLegs({ positions: Object.fromEntries(Object.entries(mix).map(([id, allocation_fraction]) => [id, { allocation_fraction }])), funding: max }, 1500000000n, TESTNET, fundingIn);
  assert.equal(legs[0].amountIn, fundingIn);
  assert.equal(testnetCheck(legs, account), null);
  // After the funding swap and the trustline (fees paid), the remaining legs still pass.
  const after = { ...account, xlm: "6.9000000", subentries: 2, lines: { USDC: "15.0000000", tRESERVE: "0" }, balance: "150.0000000" };
  assert.equal(testnetCheck(legs.slice(2), after), null);
  assert.ok(runKeep(legs.slice(2), after) < runKeep(legs, account));
  // An amount within the spare XLM is swapped as entered.
  assert.equal(xlmFundingIn(500000000n, legs, account), 500000000n);
});

test("testnetCheck requires a funded account, the USDC trustline and the USDC the remaining legs spend", () => {
  const { legs } = legsOf(mix);
  const { testnetCheck } = harness();
  const account = { funded: true, trustline: true, balance: "100.0000003", xlm: "50.0000000", subentries: 1, lines: { USDC: "100.0000003" } };
  assert.match(testnetCheck(legs, { ...account, funded: false }), /not funded on testnet/);
  assert.match(testnetCheck(legs, { ...account, trustline: false }), /USDC trustline/);
  assert.equal(testnetCheck(legs, account), null);
  assert.match(testnetCheck(legs, { ...account, balance: "50.0000000" }), /remaining legs spend 87\.\d{7} USDC; the account holds 50\.0000000/);
  assert.match(testnetCheck(legs, { ...account, xlm: "1.0000000" }), /Not enough XLM/);
});

test("an allocation holding a product without a testnet market is refused", () => {
  for (const id of ["btc", "aqua", "eth", "shx", "eurc"]) {
    assert.throws(() => legsOf({ xlm: .5, [id]: .475, usdc: .025 }), new RegExp(`Not selectable on Stellar testnet: ${id.toUpperCase()} \\(no Soroswap testnet market\\)`));
  }
  const { testnetSelectable } = harness();
  assert.deepEqual(["xlm", "xlm_buffer", "etesia-tf", "ustry", "usdc", "usdc_reserve", "eurc", "btc", "aqua", "eth", "shx"].filter(id => testnetSelectable(id, TESTNET)),
    ["xlm", "xlm_buffer", "etesia-tf", "ustry", "usdc", "usdc_reserve"]);
});
