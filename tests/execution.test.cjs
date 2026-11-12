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
const positionsOf = (fractions) => Object.fromEntries(Object.entries(fractions).map(([id, allocation_fraction]) => [id, { allocation_fraction }]));
// An allocation with its sources: symbol -> [percent, quantity, value, minOut (default value), maxWithdraw].
const sourced = (fractions, parts) => ({ positions: positionsOf(fractions),
  sources: Object.entries(parts).map(([symbol, [percent, quantity]]) => ({ symbol, percent, quantity })),
  valuation: Object.fromEntries(Object.entries(parts).map(([symbol, [, quantity, value, minOut = value, maxWithdraw]]) => [symbol, { quantity, value, minOut, ...(maxWithdraw != null && { maxWithdraw }) }])) });
const usdcOnly = (fractions, capital) => sourced(fractions, { USDC: [100, capital, capital] });
const positions = { btc: .25, "etesia-tf": .4, ustry: .3, usdc: .025, xlm_buffer: .025 };
// Quotes return out(body) (twice the input by default), at least 99.5% of it.
function harness(fail = false, out = (body) => BigInt(body.amount) * 2n) {
  const calls = [];
  const execution = load("lib/execution.ts", { "@/lib/assets": assets, "@/lib/network": network, "@/lib/vaults": vaults, "@/lib/quant": { quantRequest: async (path, body) => {
    calls.push(body);
    if (fail) throw new Error("Provider unavailable");
    return { fetched_at: new Date().toISOString(), quote: { assetIn: body.asset_in, assetOut: body.asset_out,
      amountIn: body.amount, amountOut: String(out(body)), otherAmountThreshold: String(out(body) * 995n / 1000n) } };
  } } });
  return { ...execution, calls };
}
test("mainnet simulation: a source outside the targets is sold to USDC, the rest bought from USDC, capital conserved and vault shares at $1", async () => {
  const h = harness();
  const result = await h.executionQuotes(sourced(positions, { EURC: [100, 1231234567n, 1330000000n] }), .99);
  assert.equal(result.capital, "1330000000");
  const sell = result.rows.find(row => row.trade === "sell");
  assert.deepEqual([sell.symbol, sell.amountIn, BigInt(sell.amountOut)], ["EURC", "1231234567", 2462469134n]);
  assert.deepEqual(h.calls.find(call => call.asset_out === assets.ASSET_CONTRACTS.USDC.contract), { asset_in: assets.ASSET_CONTRACTS.EURC.contract, asset_out: assets.ASSET_CONTRACTS.USDC.contract, amount: "1231234567" });
  const buys = result.rows.filter(row => row.trade === "buy");
  const cash = result.rows.find(row => row.symbol === "USDC");
  assert.equal(buys.reduce((sum, row) => sum + BigInt(row.amountIn), 0n) + BigInt(cash.target), 1330000000n);
  assert.equal(h.calls.length, 4); // The EURC sell, then BTC, USTRY and XLM buys; vault and cash need no swap.
  for (const row of buys.filter(row => row.kind === "swap")) {
    assert.equal(BigInt(row.amountOut), BigInt(row.amountIn) * 2n);
    assert.ok(row.minimumOut);
  }
  const vault = result.rows.find(row => row.kind === "vault");
  assert.equal(BigInt(vault.amountOut), BigInt(vault.amountIn) * 99n / 100n);
  assert.equal(vault.fetchedAt, null);
});
test("mainnet simulation nets: an XLM source sells only its excess over the XLM target, USDC is kept and nothing else is quoted", async () => {
  const h = harness();
  const result = await h.executionQuotes(sourced({ xlm: .5, xlm_buffer: .025, usdc: .025, "etesia-tf": .45 }, { XLM: [100, 1000000000n, 200000000n], USDC: [100, 100000000n, 100000000n] }), 1);
  assert.equal(result.capital, "300000000");
  assert.deepEqual(result.rows.map(row => [row.symbol, row.trade, row.kind]), [["XLM", "sell", "swap"], ["USDC", "none", "cash"], ["ETESIA-TF", "buy", "vault"]]);
  // XLM target 52.5% of 30 USDC = 15.75 USDC; the 20 USDC held sells its 4.25 USDC excess: 21.25 of the 100 XLM.
  assert.deepEqual(h.calls, [{ asset_in: assets.ASSET_CONTRACTS.XLM.contract, asset_out: assets.ASSET_CONTRACTS.USDC.contract, amount: "212500000" }]);
});
test("mainnet simulation sizes the buys from the USDC the sells are quoted to return, not their daily-close value", async () => {
  // XLM closes at 0.20 USDC but is quoted at 0.18: the 47.5 XLM sold return 8.55 USDC, at least 8.507250.
  const h = harness(false, (body) => BigInt(body.amount) * (body.asset_in === assets.ASSET_CONTRACTS.XLM.contract ? 18n : 200n) / 100n);
  const result = await h.executionQuotes(sourced({ xlm: .5, usdc: .025, "etesia-tf": .475 }, { XLM: [100, 1000000000n, 200000000n], USDC: [100, 10000000n, 10000000n] }), 1);
  const sell = result.rows.find(row => row.trade === "sell"), cash = result.rows.find(row => row.symbol === "USDC");
  const buys = result.rows.filter(row => row.trade === "buy");
  assert.deepEqual([sell.symbol, sell.amountIn, sell.amountOut, sell.minimumOut], ["XLM", "475000000", "85500000", "85072500"]);
  assert.deepEqual(buys.map(row => [row.symbol, row.amountIn]), [["ETESIA-TF", "89822500"]]); // 9.975 USDC wanted, scaled to what is there
  assert.ok(result.rows.every(row => !row.error));
  assert.equal(buys.reduce((sum, row) => sum + BigInt(row.amountIn), 0n) + BigInt(cash.target), 10000000n + BigInt(sell.minimumOut));
});
test("failed quotes remain visible on every trade row", async () => {
  const h = harness(true);
  const result = await h.executionQuotes(sourced(positions, { XLM: [100, 1000000000n, 1000000000n] }), 1);
  assert.equal(result.rows.filter(row => row.error).length, 3); // the BTC and USTRY buys and the sell of the XLM above its 2.5% buffer
  assert.equal(result.rows.find(row => row.kind === "vault").amountOut, "400000000");
});
test("token units keep large integers exact", () => {
  const h = harness();
  assert.equal(h.tokenUnits(9007199254740993n), "900719925.4740993");
  assert.equal(h.tokenUnits("5000000"), "0.5000000");
});
function component(initial = []) {
  const state = [], effects = [], requests = [];
  const execution = harness();
  const module = load("components/ExecutionSimulation.jsx", {
    react: { ...React, useEffect: fn => effects.push(fn), useState: value => {
      const i = state.length; state.push(i in initial ? initial[i] : value);
      return [state[i], next => { state[i] = typeof next === "function" ? next(state[i]) : next; }];
    } },
    "@/lib/execution": { TOLERANCE: execution.TOLERANCE, tokenUnits: execution.tokenUnits, executionQuotes: (...args) => new Promise((resolve, reject) => requests.push({ args, resolve, reject })) },
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
  const stamp = new Date().toISOString();
  const row = { symbol: "BTC", ids: ["btc"], trade: "buy", kind: "swap", current: "0", target: "10000000", amountIn: "10000000", amountOut: "20000000", minimumOut: "19900000", fetchedAt: stamp, error: null };
  const sell = { symbol: "XLM", ids: [], trade: "sell", kind: "swap", current: "30000000", target: "0", amountIn: "100000000", amountOut: "30000000", minimumOut: "29850000", fetchedAt: stamp, error: null };
  const held = { symbol: "USDC", ids: ["usdc"], trade: "none", kind: "cash", current: "10000000", target: "10050000", amountIn: "0", amountOut: null, minimumOut: null, fetchedAt: null, error: null };
  const close = { symbol: "AQUA", ids: ["aqua"], trade: "none", kind: "none", current: "10000000", target: "10050000", amountIn: "0", amountOut: null, minimumOut: null, fetchedAt: null, error: null };
  const preview = { rows: [row, sell, held, close], expiresAt: Date.now() + 60000 };
  const button = tree => nodes(tree).find(n => n.type === "button" && text(n).includes("Simulate execution"));
  const props = { allocation: {}, usdcUsd: 1 };
  const h = component([preview]);
  const tree = h.default(props);
  assert.match(text(tree), /Buy · USDC → BTC1.0000000 USDC → 2.0000000 BTC/);
  assert.match(text(tree), /Sell · XLM → USDC10.0000000 XLM → 3.0000000 USDC/);
  assert.match(text(tree), /Retained USDC · no swap required/);
  assert.match(text(tree), /AQUA · no tradeCurrent 1.0000000 USDC → target 1.0050000 USDCWithin tolerance, no trade/);
  assert.equal(button(tree).props.disabled, false);
  button(tree).props.onClick(); assert.equal(h.state[4], true);
  assert.equal(button(component([{ ...preview, expiresAt: 0 }]).default(props)).props.disabled, true);
  assert.equal(button(component([{ ...preview, rows: [{ ...row, error: "Unavailable" }] }]).default(props)).props.disabled, true);
  assert.match(text(component([preview, null, 0, Date.now(), true]).default(props)), /no transactions submitted, and no funds moved/);
});
test("cancelled quotes cannot populate a changed allocation", async () => {
  const h = component();
  h.default({ allocation: {}, usdcUsd: 1 });
  const cleanup = h.effects[0](); cleanup();
  assert.equal(h.requests[0].args[2].aborted, true);
  h.requests[0].resolve({ rows: [] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state[0], null);
});

test("EURC quotes use Circle's verified Stellar identity", () => {
  const { Asset, Networks } = require("@stellar/stellar-sdk");
  const eurc = assets.ASSET_CONTRACTS.EURC;
  assert.equal(eurc.contract, new Asset("EURC", eurc.issuer).contractId(Networks.PUBLIC));
});

// D5 allocation on testnet: the rebalance plan executed by components/TestnetExecution.jsx.
const { TESTNET } = network;
const legsOf = (fractions, capital = 1000000003n) => harness().testnetLegs(usdcOnly(fractions, capital), TESTNET);
const spent = (legs) => legs.filter(l => l.kind === "swap" || l.kind === "vault").reduce((sum, l) => sum + l.amountIn, 0n);
const mix = { xlm: .3, xlm_buffer: .025, "etesia-tf": .35, ustry: .2, usdc_reserve: .1, usdc: .025, btc: 0 };
const budgetOf = (capital) => (f) => capital * BigInt(Math.floor(f * 1e12)) / 1000000000000n;
const ACCOUNT = { funded: true, trustline: true, balance: "0.0000000", xlm: "100.0000000", subentries: 1, lines: { USDC: "0.0000000" } };

test("a single 100% USDC source reproduces the allocation legs: capital conserved to the stroop, usdc, usdc_reserve and dust kept as USDC", () => {
  for (const capital of [1000000003n, 123456789012345n]) {
    const { legs, kept } = legsOf(mix, capital);
    assert.equal(spent(legs) + kept, capital);
  }
  const { legs, kept, capital } = legsOf(mix);
  const budget = budgetOf(1000000003n);
  assert.equal(capital, 1000000003n);
  assert.equal(kept, 1000000003n - budget(.3) - budget(.025) - budget(.35) - budget(.2));
  assert.ok(kept >= budget(.1) + budget(.025));
  assert.ok(!legs.some(l => l.ids.some(id => id.startsWith("usdc"))));
});

test("a single USDC source merges xlm and xlm_buffer into one USDC → XLM buy and sizes the vault deposit from etesia-tf", () => {
  const { legs } = legsOf(mix);
  const budget = budgetOf(1000000003n);
  const xlm = legs.filter(l => l.kind === "swap" && l.symbol === "XLM");
  assert.equal(xlm.length, 1);
  assert.deepEqual(xlm[0].ids, ["xlm", "xlm_buffer"]);
  assert.equal(xlm[0].amountIn, budget(.3) + budget(.025));
  assert.deepEqual(xlm[0].path, [TESTNET.usdc.contract, TESTNET.assets.XLM.address]);
  const reserve = legs.find(l => l.kind === "swap" && l.symbol === "tRESERVE");
  assert.deepEqual(reserve.path, [TESTNET.usdc.contract, TESTNET.assets.tRESERVE.address]);
  const vault = legs.find(l => l.kind === "vault");
  assert.deepEqual([vault.ids, vault.amountIn], [["etesia-tf"], budget(.35)]);
  // Run order: trustlines, swaps, then the vault deposit; no sell, as only USDC is selected.
  assert.deepEqual(legs.map(l => l.key), ["trustline:tRESERVE", "swap:XLM", "swap:tRESERVE", "vault:etesia-tf"]);
});

test("an XLM-only 100% source sells only the XLM above its target, counting on its share of the valued minimum, and buys the rest scaled to that USDC", () => {
  const plan = harness().testnetLegs(sourced(mix, { XLM: [100, 1000000000n, 200000000n, 199000000n] }), TESTNET);
  const budget = budgetOf(200000000n);
  assert.deepEqual(plan.legs.map(l => l.key), ["trustline:tRESERVE", "sell:XLM", "swap:tRESERVE", "vault:etesia-tf"]);
  const sell = plan.legs[1];
  const excess = 200000000n - budget(.3) - budget(.025);
  assert.deepEqual([sell.kind, sell.path, sell.ids], ["sell", [TESTNET.assets.XLM.address, TESTNET.usdc.contract], ["xlm", "xlm_buffer"]]);
  assert.equal(sell.amountIn, 1000000000n * excess / 200000000n); // 67.5 of the 100 XLM selected
  assert.equal(sell.minOut, 199000000n * sell.amountIn / 1000000000n);
  // The sell's minimum less the USDC target is short of the buys: each is scaled down by the same factor.
  const spendable = sell.minOut - plan.rows.find(r => r.symbol === "USDC").target, wanted = budget(.35) + budget(.2);
  assert.ok(spendable < wanted);
  const [reserve, vault] = plan.legs.slice(2);
  assert.deepEqual([reserve.amountIn, vault.amountIn], [budget(.2) * spendable / wanted, budget(.35) * spendable / wanted]);
  assert.ok(reserve.amountIn + vault.amountIn <= spendable);
  const row = plan.rows.find(r => r.symbol === "XLM");
  assert.deepEqual([row.current, row.target, row.trade], [200000000n, budget(.3) + budget(.025), "sell"]);
});

test("vault shares above their target are withdrawn in USDC, capped at the max withdraw; a 0 target with every share selected redeems them all", () => {
  const S = 500000000000000n; // 500 shares (twelve decimals)
  const withdraw = (maxWithdraw, percent = 50) => harness().testnetLegs(sourced({ "etesia-tf": .2, usdc: .8 }, { "ETESIA-TF": [percent, S, 500000000n, 497500000n, maxWithdraw], USDC: [100, 500000000n, 500000000n] }), TESTNET);
  let plan = withdraw(1000000000n);
  assert.deepEqual(plan.legs.map(l => [l.key, l.kind, l.amountIn, l.minOut, l.cap]), [["withdraw:etesia-tf", "withdraw", 300000000n, 300000000n, undefined]]);
  plan = withdraw(100000000n);
  assert.deepEqual(plan.legs.map(l => [l.key, l.amountIn, l.cap]), [["withdraw:etesia-tf", 100000000n, 100000000n]]);
  assert.equal(plan.rows.find(r => r.symbol === "ETESIA-TF").cap, 100000000n);
  // Target 0: every selected share redeemed, counting on the redeem preview's minimum; the buys spend it.
  const exit = (percent) => harness().testnetLegs(sourced({ xlm: .5, xlm_buffer: .025, usdc: .475 }, { "ETESIA-TF": [percent, S, 500000000n, 497500000n, 500000000n] }), TESTNET);
  plan = exit(100);
  assert.deepEqual(plan.legs.map(l => [l.key, l.kind]), [["redeem:etesia-tf", "redeem"], ["swap:XLM", "swap"]]);
  assert.deepEqual([plan.legs[0].amountIn, plan.legs[0].minOut], [S, 497500000n]);
  assert.equal(plan.legs[1].amountIn, 497500000n - plan.kept);
  // Part of the shares selected: their value is withdrawn, never a redeem of every share.
  assert.deepEqual(exit(50).legs.map(l => [l.key, l.amountIn]), [["withdraw:etesia-tf", 500000000n], ["swap:XLM", 500000000n - exit(50).kept]]);
});

test("a bucket within 0.01 USDC of its target is not traded; tRESERVE sold needs no trustline, bought needs one", () => {
  const close = harness().testnetLegs(sourced({ xlm: .5, usdc: .5 }, { USDC: [100, 100000000n, 100000000n], XLM: [100, 500000000n, 100050000n] }), TESTNET);
  assert.deepEqual(close.legs, []);
  assert.deepEqual(close.rows.map(r => [r.symbol, r.trade]), [["XLM", "none"], ["USDC", "none"]]);
  const sold = harness().testnetLegs(sourced({ xlm: .5, usdc: .5 }, { tRESERVE: [100, 100000000n, 100000000n] }), TESTNET);
  assert.deepEqual(sold.legs.map(l => l.key), ["sell:tRESERVE", "swap:XLM"]);
  assert.deepEqual(legsOf({ ustry: .5, usdc: .5 }).legs.map(l => l.key), ["trustline:tRESERVE", "swap:tRESERVE"]);
  assert.deepEqual(legsOf({ xlm: .5, usdc: .5 }).legs.map(l => l.key), ["swap:XLM"]);
  // Capital below the tolerance: nothing is traded and it stays as USDC.
  assert.deepEqual([legsOf(mix, 7n).legs, legsOf(mix, 7n).kept], [[], 7n]);
});

test("the XLM source's maximum keeps back the most a run can: every market asset and the vault traded, every missing trustline added", () => {
  const { xlmSourceKeep, runKeep, testnetCheck, FEE_ALLOWANCE } = harness();
  // Two base reserves, the USDC line, the tRESERVE line a run may add, and four transactions: 6 XLM.
  assert.equal(xlmSourceKeep(ACCOUNT, TESTNET), 4n * 5000000n + 4n * FEE_ALLOWANCE);
  assert.equal(xlmSourceKeep({ ...ACCOUNT, subentries: 2, lines: { USDC: "0", tRESERVE: "0" } }, TESTNET), 4n * 5000000n + 3n * FEE_ALLOWANCE);
  // An XLM source sized to the balance less that keep-back passes the check.
  const quantity = 1000000000n - xlmSourceKeep(ACCOUNT, TESTNET);
  const { legs } = harness().testnetLegs(sourced(mix, { XLM: [100, quantity, 200000000n] }), TESTNET);
  assert.ok(runKeep(legs, ACCOUNT) <= xlmSourceKeep(ACCOUNT, TESTNET));
  assert.equal(testnetCheck(legs, ACCOUNT), null);
  assert.match(testnetCheck(legs, { ...ACCOUNT, xlm: "60.0000000" }), /Not enough XLM: selling 63\.4500000 XLM while keeping 6\.0000000 XLM back for fees and the account reserve needs 69\.4500000 XLM; the account holds 60\.0000000\. Rebuild the allocation to size the XLM source again\./);
});

test("testnetCheck requires a funded account, the USDC trustline, the assets and shares sold, an unpaused vault and the USDC the buys spend beyond the sells", () => {
  const { legs } = legsOf(mix);
  const { testnetCheck } = harness();
  const account = { funded: true, trustline: true, balance: "100.0000003", xlm: "50.0000000", subentries: 1, lines: { USDC: "100.0000003" } };
  const position = { shares: 0n, maxWithdraw: 0n, paused: false };
  assert.match(testnetCheck(legs, { ...account, funded: false }), /not funded on testnet/);
  assert.match(testnetCheck(legs, { ...account, trustline: false }), /USDC trustline/);
  assert.equal(testnetCheck(legs, account, position), null);
  assert.match(testnetCheck(legs, { ...account, balance: "50.0000000" }), /remaining legs spend 87\.\d{7} USDC; the account holds 50\.0000000/);
  assert.match(testnetCheck(legs, { ...account, xlm: "1.0000000" }), /Not enough XLM/);
  assert.match(testnetCheck(legs, account, { ...position, paused: true }), /The vault is paused/);
  // A tRESERVE sell needs the tRESERVE it sells; its minimum counts toward the buys' USDC.
  const sold = harness().testnetLegs(sourced({ xlm: .5, usdc: .5 }, { tRESERVE: [100, 100000000n, 100000000n] }), TESTNET).legs;
  assert.match(testnetCheck(sold, { ...account, balance: "0", lines: { USDC: "0", tRESERVE: "9.0000000" } }), /Not enough tRESERVE: the run sells 10\.0000000 tRESERVE; the account holds 9\.0000000/);
  assert.equal(testnetCheck(sold, { ...account, balance: "0", lines: { USDC: "0", tRESERVE: "10.0000000" } }), null);
  // Vault exits need the max withdraw or the shares they take.
  const S = 500000000000000n;
  const exit = (percent, maxWithdraw) => harness().testnetLegs(sourced({ xlm: .5, xlm_buffer: .025, usdc: .475 }, { "ETESIA-TF": [percent, S, 500000000n, 497500000n, maxWithdraw] }), TESTNET).legs;
  assert.match(testnetCheck(exit(50, 500000000n), { ...account, balance: "0" }, { shares: S, maxWithdraw: 400000000n, paused: false }), /Not enough vault liquidity: the run withdraws 50\.0000000 USDC; the vault's max withdraw for this account is 40\.0000000 USDC/);
  assert.match(testnetCheck(exit(100, 500000000n), { ...account, balance: "0" }, { shares: S - 1n, maxWithdraw: 0n, paused: false }), /Not enough vault shares/);
  assert.equal(testnetCheck(exit(100, 500000000n), { ...account, balance: "0" }, { shares: S, maxWithdraw: 0n, paused: false }), null);
});

test("an allocation holding a product without a testnet market is refused", () => {
  for (const id of ["btc", "aqua", "eth", "shx", "eurc"]) {
    assert.throws(() => legsOf({ xlm: .5, [id]: .475, usdc: .025 }), new RegExp(`Not selectable on Stellar testnet: ${id.toUpperCase()} \\(no Soroswap testnet market\\)`));
  }
  const { testnetSelectable } = harness();
  assert.deepEqual(["xlm", "xlm_buffer", "etesia-tf", "ustry", "usdc", "usdc_reserve", "eurc", "btc", "aqua", "eth", "shx"].filter(id => testnetSelectable(id, TESTNET)),
    ["xlm", "xlm_buffer", "etesia-tf", "ustry", "usdc", "usdc_reserve"]);
});
