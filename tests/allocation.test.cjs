// D5 allocation on testnet: selectable products, the leg run (order, failures,
// unknown outcomes, the pending-hash guard) and its receipts; mainnet stays simulated.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const sdk = require("@stellar/stellar-sdk");
const root = path.join(__dirname, "..");

function load(file, imports = {}, globals = {}, append = "") {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8") + append, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: path.basename(file),
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), code)(name => imports[name] ?? require(name), module, module.exports, ...Object.values(globals));
  return module.exports;
}
const network = load("lib/network.ts", { "@/data/testnet-manifest.json": require(path.join(root, "data/testnet-manifest.json")) });
const { TESTNET } = network;
const vaults = load("lib/vaults.ts", { "@/lib/network": network });
const assets = load("lib/assets.ts");
const execution = load("lib/execution.ts", { "@/lib/network": network, "@/lib/vaults": vaults, "@/lib/assets": assets, "@/lib/quant": {} });
const vaultLib = load("lib/vault.ts", { "@/lib/network": network, "@/lib/quant": {}, "@/components/stellar/walletKit": { signTx: async () => { throw new Error("not used"); } } });
const panel = load("components/TestnetExecution.jsx", { "@/lib/vault": vaultLib, "@/lib/execution": execution,
  "@/stores/useStellarWalletStore": { __esModule: true, default: () => null } });

function nodes(node) {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const text = (node) => nodes(node).filter((part) => typeof part === "string" || typeof part === "number").join("");

// ---------- Builder: selectable products ----------

function builder(state = [], calls = { init: [] }) {
  const store = { address: "GOWNER", connected: true, byTk: {}, lastUpdated: 1, error: null, networkError: null, set: () => {} };
  const values = [];
  const effects = [];
  const TestnetExecution = () => null;
  const ExecutionSimulation = load("components/ExecutionSimulation.jsx", { "@/lib/execution": { executionQuotes: () => new Promise(() => {}), tokenUnits: String } }).default;
  const mod = load("components/PortfolioBuilder.jsx", {
    react: { ...React, useRef: () => ({ current: null }), useMemo: (fn) => fn(), useEffect: (fn) => effects.push(fn),
      useState: (value) => { const i = values.length; values.push(i in state ? state[i] : typeof value === "function" ? value() : value);
        return [values[i], (next) => { values[i] = typeof next === "function" ? next(values[i]) : next; }]; } },
    "next/dynamic": () => () => null,
    "@/components/AllocationSimulation": () => null,
    "@/components/ExecutionSimulation": { __esModule: true, default: ExecutionSimulation },
    "@/components/TestnetExecution": { __esModule: true, default: TestnetExecution, valueSources: panel.valueSources },
    "@/components/NetworkSwitch": { __esModule: true, default: () => null },
    "@/stores/useStellarWalletStore": (sel) => sel(store),
    "@/stores/useBalanceStore": (sel) => sel(store),
    "@/stores/usePriceStore": (sel) => sel({ bySymbol: {}, set: () => {} }),
    "@/components/stellar/walletKit": { initWalletKit: (config) => calls.init.push(config), connectWallet() {}, disconnectWallet() {} },
    "@/lib/network": network, "@/lib/vaults": vaults, "@/lib/execution": execution, "@/lib/vault": vaultLib,
    "@/lib/prices": { referenceValue: () => null, fundingValue: () => null },
    "@/lib/quant": { fetchUniverse: () => new Promise(() => {}), quantRequest: () => new Promise(() => {}) },
    "@/lib/balances": { fetchHoldings: () => new Promise(() => {}) },
  }, { window: { location: { search: "" }, history: { replaceState() {} } } }, "\nexport { CoinCard, CashReservePanel, AllocStage, ConnectScreen, Sidecar };");
  return { ...mod, values, effects, TestnetExecution, ExecutionSimulation, render: () => { values.length = 0; effects.length = 0; return mod.default(); } };
}
const PRODUCTS = ["xlm", "etesia-tf", "aqua", "eth", "btc", "shx"].map(id => ({ id, tk: id.toUpperCase(), name: id, marketCap: {}, mcap: 1e6, sharpe: 1, analytics: null, allocationSupported: true }));
const card = (h, coin, network) => h.CoinCard({ coin, network, selected: false, hasBasket: false, onToggle() {}, maxMcap: 1e9 });
const button = (tree) => nodes(tree).find(n => n.type === "button");

test("on testnet, AQUA, ETH, BTC, SHX and EURC are disabled with the reason; XLM, ETESIA-TF, USDC and USTRY (the tRESERVE stand-in) are enabled", () => {
  const h = builder();
  for (const coin of PRODUCTS) {
    const tree = card(h, coin, "testnet");
    const selectable = ["xlm", "etesia-tf"].includes(coin.id);
    assert.equal(button(tree).props.disabled, !selectable, coin.tk);
    assert.equal(text(tree).includes(`Not selectable on testnet · no Soroswap testnet market for ${coin.tk}`), !selectable, coin.tk);
  }
  const reserves = h.CashReservePanel({ network: "testnet", selected: ["ustry"], onChange() {}, supported: ["usdc", "eurc", "ustry"],
    coins: ["usdc", "eurc", "ustry"].map(id => ({ id, tk: id.toUpperCase() })) });
  const inputs = nodes(reserves).filter(n => n.type === "input");
  assert.deepEqual(inputs.map(n => n.props.disabled), [false, true, false]);
  assert.match(text(reserves), /EURC.*Not selectable on testnet · no Soroswap testnet market for EURC/);
  assert.ok(text(reserves).includes(`USTRY stand-in on testnet: Etesia-issued tRESERVE ${TESTNET.assets.tRESERVE.address}`));
});

test("on mainnet every card and reserve keeps today's state", () => {
  const h = builder();
  for (const coin of PRODUCTS) {
    const tree = card(h, coin, "mainnet");
    assert.equal(button(tree).props.disabled, false, coin.tk);
    assert.ok(!/Not selectable|testnet/i.test(text(tree)), coin.tk);
  }
  const reserves = h.CashReservePanel({ selected: ["ustry"], onChange() {}, supported: ["usdc", "eurc", "ustry"], coins: ["usdc", "eurc", "ustry"].map(id => ({ id, tk: id.toUpperCase() })) });
  assert.deepEqual(nodes(reserves).filter(n => n.type === "input").map(n => n.props.disabled), [false, false, false]);
  assert.ok(!/stand-in|Not selectable/.test(text(reserves)));
});

test("switching to testnet drops products and reserves without a testnet market, and their cards ignore clicks", () => {
  const state = [];
  state[0] = ["AQUA", "XLM", "ETESIA-TF"];
  state[5] = PRODUCTS;
  state[13] = ["eurc", "ustry"];
  const h = builder(state);
  const tree = h.render();
  const masthead = nodes(tree).find(n => n.props?.onNetwork);
  masthead.props.onNetwork("testnet");
  assert.deepEqual(h.values[0], ["XLM", "ETESIA-TF"]);
  assert.deepEqual(h.values[13], ["ustry"]);
  const testnet = builder([...h.values]);
  const aqua = nodes(testnet.render()).find(n => n.props?.coin?.id === "aqua");
  aqua.props.onToggle();
  assert.deepEqual(testnet.values[0], ["XLM", "ETESIA-TF"]);
});

test("the working basket labels the vault with the active network's deployment, as its card does", () => {
  const h = builder();
  const coins = [{ id: "etesia-tf", tk: "ETESIA-TF", name: "Etesia TF Vault", simulated: true }, { id: "xlm", tk: "XLM", name: "Stellar Lumens" }, { id: "aqua", tk: "AQUA", name: "Aquarius", simulated: true }];
  const basket = (network) => text(h.Sidecar({ basket: ["ETESIA-TF", "XLM", "AQUA"], coins, network, analytics: null, analyticsLoading: false, removeFromBasket() {} }));
  assert.ok(basket("testnet").includes(`Testnet vault · ${TESTNET.epoch}`));
  assert.ok(basket("mainnet").includes("Mainnet vault not deployed yet"));
  for (const network of ["testnet", "mainnet"]) {
    assert.equal(basket(network).match(/Under construction · simulated/g)?.length, 1, network); // AQUA only
    assert.ok(basket(network).includes("Stellar Lumens"), network);
  }
  assert.ok(text(card(h, PRODUCTS[1], "testnet")).includes(`Testnet vault · ${TESTNET.epoch}`));
});

// The selected sources of an allocation and their valuation (USDC units).
const usdcSource = (quantity) => ({ sources: [{ symbol: "USDC", percent: 100, quantity }], valuation: { USDC: { quantity, value: quantity, minOut: quantity } } });
const ALLOCATED = { requested_assets: ["xlm", "etesia-tf"], owner: "GOWNER", generated_at: "2026-11-12T00:00:00Z", model_version: "m", market_data_as_of: "2026-11-11T00:00:00Z", portfolio_value_usdc: 100,
  positions: { "etesia-tf": { allocation_fraction: .8185, notional_usdc: 81.85, quantity: 81.8, mark_usdc: 1 }, xlm: { allocation_fraction: .1315, notional_usdc: 13.15, quantity: 89.3, mark_usdc: .147 },
    ustry: { allocation_fraction: 0, notional_usdc: 0, quantity: 0, mark_usdc: 1 }, usdc: { allocation_fraction: .025, notional_usdc: 2.5, quantity: 2.5, mark_usdc: 1 }, xlm_buffer: { allocation_fraction: .025, notional_usdc: 2.5, quantity: 17, mark_usdc: .147 } },
  parameters: { builder: { annual_volatility_budget: .25 }, cash_reserves: ["ustry"] }, allocated_sleeve_volatility: .1655883689913353,
  binding_constraints: ["gross_allocation_cap"], diagnostics: [], ...usdcSource(1000000000n), usdcUsd: 1 };

test("a selected reserve left empty by the gross allocation cap is explained, with the budget that keeps one", () => {
  const h = builder();
  const note = (allocation) => text(h.AllocStage({ network: "testnet", allocation, coins: [], onReset() {} }));
  assert.ok(note(ALLOCATED).includes("No USTRY reserve: fully invested, the selected products reach 16.56% annual volatility, below the 25.00% budget, so the model invests the 95% maximum and leaves no residual cash for the reserve. A volatility budget below 16.56% keeps a reserve."));
  const funded = { ...ALLOCATED, binding_constraints: ["annual_volatility_budget"], allocated_sleeve_volatility: .1 };
  assert.ok(!note(funded).includes("No USTRY reserve"));
  assert.ok(note({ ...ALLOCATED, parameters: { ...ALLOCATED.parameters, cash_reserves: ["usdc", "ustry"] } }).includes("No USDC and USTRY reserve"));
});

test("once every testnet leg is executed, sections 02–04 unlock, input changes keep section 05, and only the account or network clears it", () => {
  const state = [];
  state[3] = "allocated"; state[4] = ALLOCATED; state[16] = "testnet";
  const h = builder(state);
  const locked = (tree) => nodes(tree).some(n => n.props?.className === "locked");
  let tree = h.render();
  assert.ok(locked(tree), "inputs locked while the allocation runs");
  const invalidate = (b) => b.effects.find(fn => fn.toString().includes("buildRequest.current?.abort();") && fn.toString().includes("executed"))();
  nodes(tree).find(n => n.props?.onExecuted).props.onExecuted();
  assert.equal(h.values[3], "executed");
  const after = builder([...h.values]);
  tree = after.render();
  assert.ok(!locked(tree), "inputs unlocked after every leg executed");
  assert.equal(nodes(tree).find(n => n.props?.onExecuted)?.props.allocation, ALLOCATED, "section 05 and its receipts stay");
  invalidate(after);
  assert.deepEqual([after.values[3], after.values[4]], ["executed", ALLOCATED], "an input change keeps section 05");
  // Before execution, an input change still clears the allocation.
  invalidate(h);
  assert.deepEqual([h.values[3], h.values[4]], ["select", null]);
  // The account and network effect clears an executed allocation too.
  after.effects.find(fn => fn.toString().includes("setTestnet(null)"))()(); // run, then clean up its refresh interval
  assert.deepEqual([after.values[3], after.values[4]], ["select", null]);
});

// ---------- Leg run ----------

const OWNER = sdk.Keypair.random().publicKey();
const ACCOUNT = { funded: true, trustline: true, balance: "1000.0000000", xlm: "100.0000000", subentries: 1, lines: { USDC: "1000.0000000" } };
const ALLOCATION = { owner: OWNER, generated_at: "2026-11-11T12:00:00Z", ...usdcSource(200000000n),
  positions: Object.fromEntries(Object.entries({ xlm: .3, xlm_buffer: .025, "etesia-tf": .35, ustry: .3, usdc: .025 }).map(([id, f]) => [id, { allocation_fraction: f }])) };
const POSITION = { shares: 0n, value: 0n, maxWithdraw: 0n, liquid: 0n, paused: false };
const symbolOf = (contract) => Object.values(TESTNET.assets).find(a => a.address === contract).symbol;
// A scripted client: each signing call reports its envelope, then confirms, fails or ends unknown.
// quote(amountIn, from, to) is a quote's expected output (twice the input by default); quoted lists the quotes asked.
function client({ outcomes = {}, checks = [], account = ACCOUNT, noQuote = [], limited = [], position = POSITION, quote = (amountIn) => amountIn * 2n } = {}) {
  const log = [], quoted = [];
  let n = 0;
  const sign = (name, onSigned) => {
    const signed = { hash: String(++n).repeat(64).slice(0, 64), maxTime: 1000 };
    log.push(name);
    onSigned(signed);
    const outcome = outcomes[name];
    if (outcome === "fail") throw new Error(`${name} failed onchain; only the fee was charged.`);
    if (outcome === "unknown") throw Object.assign(new Error(`Transaction ${signed.hash} outcome unknown`), { unknown: signed });
    return { action: name, hash: signed.hash, ledger: 50 + n, returned: `${n} units` };
  };
  return { log, quoted, net: TESTNET, SHARES: vaultLib.vaultClient(TESTNET).SHARES, swapReturns: (p) => ({ decimals: 7, unit: symbolOf(p.at(-1)) }),
    vaultError: (err) => err.message, readUsdcLine: async () => account,
    quoteSwap: async (amountIn, p) => { log.push(`quote ${p.map(symbolOf).join("→")}`);
      if (noQuote.includes(symbolOf(p.at(-1)))) throw Object.assign(new Error(`No Soroswap testnet quote for ${p.map(symbolOf).join(" → ")}: Soroswap API 400: No path found`), { noPath: true });
      if (limited.includes(symbolOf(p.at(-1)))) throw Object.assign(new Error(`No Soroswap testnet quote for ${p.map(symbolOf).join(" → ")}: The Soroswap API rate limit was reached. Try again in 1 seconds.`), { noPath: false });
      const amountOut = quote(amountIn, symbolOf(p[0]), symbolOf(p.at(-1)));
      quoted.push([amountIn, symbolOf(p[0]), symbolOf(p.at(-1))]);
      return { amountOut, minOut: amountOut * 9950n / 10000n, quote: {} }; },
    preview: async () => 1000000000000n,
    // lib/vault.ts quotes and builds through the Soroswap API inside swapExactIn (tests/vault.test.cjs).
    swapExactIn: async (owner, amountIn, p, onSigned, floor) => { log.push({ amountIn, floor, to: owner });
      if (outcomes[`swap ${symbolOf(p.at(-1))}`] === "unquoted") throw Object.assign(new Error(`No Soroswap testnet quote for ${p.map(symbolOf).join(" → ")}: No path found`), { unquoted: true });
      return sign(`swap ${symbolOf(p.at(-1))}`, onSigned); },
    addUsdcTrustline: async (owner, symbol, onSigned) => sign(`trustline ${symbol}`, onSigned),
    deposit: async (owner, amount, onSigned) => sign(`deposit ${amount}`, onSigned),
    withdraw: async (owner, amount, onSigned) => sign(`withdraw ${amount}`, onSigned),
    exitAll: async (owner, onSigned) => sign("redeem all", onSigned),
    readPosition: async () => { log.push("position"); return position; },
    checkTransaction: async (record) => { log.push(`check ${record.hash}`); return checks.shift(); } };
}
function memoryStorage(initial = {}) {
  const data = { "etesia.builder.pending": JSON.stringify(initial) };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}
async function run(c, states = {}, store = panel.pendingStore(() => memoryStorage()), active, allocation = ALLOCATION) {
  const { legs } = execution.testnetLegs(allocation, TESTNET);
  const updates = [];
  const result = await panel.runLegs({ client: c, owner: OWNER, generatedAt: ALLOCATION.generated_at, legs, states, store, active,
    update: (key, state) => { updates.push([key, state.status]); states[key] = state; } });
  return { legs, states, updates, result, store };
}
const signedCalls = (c) => c.log.filter(e => typeof e === "string" && !e.startsWith("quote") && !e.startsWith("check") && e !== "position");

test("legs run in order, each swap quoted before the run and executed through the API swap with no floor, then the deposit", async () => {
  const c = client();
  const { states, result, store } = await run(c);
  assert.equal(result, true);
  assert.deepEqual(signedCalls(c), ["trustline tRESERVE", "swap XLM", "swap tRESERVE", "deposit 7"]);
  const quoteIndex = c.log.indexOf("quote USDC→XLM"), swap = c.log.find(e => e.amountIn === 65000000n);
  assert.ok(quoteIndex >= 0 && quoteIndex < c.log.indexOf(swap));
  // swapExactIn quotes again and builds right before the signature; only the funding swap has a floor.
  assert.deepEqual(swap, { amountIn: 65000000n, floor: 0n, to: OWNER });
  assert.ok(Object.values(states).every(s => s.status === "confirmed"));
  // Confirmed legs stay stored with their receipts, so a reload does not forget them.
  assert.deepEqual(store.list(OWNER).map(r => [r.leg, r.outcome.status, r.outcome.receipt.hash]), Object.entries(states).map(([key, s]) => [key, "SUCCESS", s.receipt.hash]));
});

test("a swap without a live quote is not executed, nor its trustline, and the other legs and the deposit still run", async () => {
  const c = client({ noQuote: ["tRESERVE"] });
  const { states, result } = await run(c);
  assert.equal(result, true);
  assert.deepEqual(signedCalls(c), ["swap XLM", "deposit 7"]);
  assert.deepEqual([states["trustline:tRESERVE"].status, states["swap:tRESERVE"].status], ["unavailable", "unavailable"]);
  assert.match(states["swap:tRESERVE"].error, /No Soroswap testnet quote for USDC → tRESERVE/);
  assert.equal(states["vault:etesia-tf"].status, "confirmed");
  const html = render({ plan: planFor({ "swap:tRESERVE": { error: "No Soroswap testnet quote" } }), states });
  assert.ok(html.includes("Not executed · No Soroswap testnet quote for USDC → tRESERVE") && html.includes("A buy the Soroswap API finds no path for is not executed"));
  assert.ok(html.includes("Continue with the remaining legs") && !runButton(html)[1]);
});

test("a quote that fails for any reason but No path found (rate limit, outage, missing key) stops the run before anything is signed", async () => {
  const c = client({ limited: ["tRESERVE"] });
  const states = {};
  const { legs } = execution.testnetLegs(ALLOCATION, TESTNET);
  await assert.rejects(panel.runLegs({ client: c, owner: OWNER, generatedAt: ALLOCATION.generated_at, legs, states, store: null, update: (key, state) => { states[key] = state; } }),
    /rate limit was reached\. Try again in 1 seconds\. Nothing was signed; run again once the Soroswap API answers\./);
  assert.deepEqual([signedCalls(c), states], [[], {}]);
});

// An XLM source of 100 XLM valued at 20 USDC (minimum 19.9): it sells 67.5 XLM, the XLM above its 32.5% target.
const XLM_SOURCE = { ...ALLOCATION, sources: [{ symbol: "XLM", percent: 100, quantity: 1000000000n }], valuation: { XLM: { quantity: 1000000000n, value: 200000000n, minOut: 199000000n } } };

test("a buy whose quote fails at signing is not executed, while a sell's failure stops the run before the buys", async () => {
  const c = client({ outcomes: { "swap tRESERVE": "unquoted" } });
  const { states, result } = await run(c);
  assert.equal(result, true);
  assert.deepEqual([states["swap:tRESERVE"].status, states["vault:etesia-tf"].status], ["unavailable", "confirmed"]);
  assert.match(states["swap:tRESERVE"].error, /No path found/);
  const f = client({ outcomes: { "swap USDC": "unquoted" } });
  const prepared = await panel.prepareRun(f, XLM_SOURCE, TESTNET, null);
  const states2 = {};
  const ok = await panel.runLegs({ client: f, owner: OWNER, generatedAt: ALLOCATION.generated_at, legs: prepared.plan.legs, states: states2, store: null,
    update: (key, state) => { states2[key] = state; } });
  assert.equal(ok, false);
  assert.equal(states2["sell:XLM"].status, "failed");
  assert.deepEqual(signedCalls(f), ["trustline tRESERVE"]);
  assert.equal(states2["swap:tRESERVE"], undefined);
});

test("a sell is signed with its share of the valued minimum as its floor; buys have none", async () => {
  const c = client();
  const { legs, states, result } = await run(c, {}, undefined, undefined, XLM_SOURCE);
  assert.equal(result, true);
  const sell = legs.find(l => l.key === "sell:XLM");
  assert.equal(sell.minOut, 199000000n * 675000000n / 1000000000n);
  assert.deepEqual(c.log.filter(e => typeof e === "object").map(e => [e.amountIn, e.floor]), [[675000000n, sell.minOut], [legs.find(l => l.key === "swap:tRESERVE").amountIn, 0n]]);
  assert.deepEqual(signedCalls(c), ["trustline tRESERVE", "swap USDC", "swap tRESERVE", `deposit ${vaultLib.fromUnits(legs.at(-1).amountIn, 7)}`]);
  assert.ok(Object.values(states).every(s => s.status === "confirmed"));
});

test("a sell without a quote stops the run before anything is signed, even when the API finds no path", async () => {
  const c = client({ noQuote: ["USDC"] });
  const states = {};
  const { legs } = execution.testnetLegs(XLM_SOURCE, TESTNET);
  await assert.rejects(panel.runLegs({ client: c, owner: OWNER, generatedAt: ALLOCATION.generated_at, legs, states, store: null, update: (key, state) => { states[key] = state; } }),
    /No Soroswap testnet quote for XLM → USDC: Soroswap API 400: No path found Nothing was signed/);
  assert.deepEqual([signedCalls(c), states], [[], {}]);
});

test("vault withdraw and redeem legs record their signed envelopes like the other legs and run before the buys", async () => {
  const S = 500000000000000n;
  const vaultSource = (percent) => ({ ...ALLOCATION, positions: { xlm: { allocation_fraction: .5 }, xlm_buffer: { allocation_fraction: .025 }, usdc: { allocation_fraction: .475 } },
    sources: [{ symbol: "ETESIA-TF", percent, quantity: S }], valuation: { "ETESIA-TF": { quantity: S, value: 500000000n, minOut: 497500000n, maxWithdraw: 500000000n } } });
  for (const [percent, kind, signed] of [[100, "redeem", "redeem all"], [50, "withdraw", "withdraw 50"]]) {
    const c = client({ position: { ...POSITION, shares: S, maxWithdraw: 500000000n } });
    const { states, store, result } = await run(c, {}, undefined, undefined, vaultSource(percent));
    assert.equal(result, true);
    assert.deepEqual(signedCalls(c), [signed, "swap XLM"]);
    assert.ok(c.log.includes("position"), "the vault position is read for the checks");
    const record = store.list(OWNER).find(r => r.leg === `${kind}:etesia-tf`);
    assert.deepEqual([record.outcome.status, record.action], ["SUCCESS", kind === "redeem" ? "Redeem all · ETESIA-TF redeem_bounded" : "Withdraw · ETESIA-TF withdraw_bounded"]);
    assert.equal(states[`${kind}:etesia-tf`].status, "confirmed");
  }
  // A paused vault refuses the run before any signature.
  const paused = client({ position: { ...POSITION, shares: S, maxWithdraw: 500000000n, paused: true } });
  await assert.rejects(run(paused, {}, undefined, undefined, vaultSource(100)), /The vault is paused/);
  assert.deepEqual(signedCalls(paused), []);
});

test("a run stops when its panel is gone, and refuses while the store holds a transaction signed outside it", async () => {
  let alive = true;
  const c = client();
  const original = c.addUsdcTrustline;
  c.addUsdcTrustline = async (...args) => { const receipt = await original(...args); alive = false; return receipt; };
  const { result } = await run(c, {}, undefined, () => alive);
  assert.equal(result, false);
  assert.deepEqual(signedCalls(c), ["trustline tRESERVE"]);
  // Another run of an older allocation signed a leg meanwhile: nothing more is signed here.
  const storage = memoryStorage({ [OWNER]: [{ generatedAt: "2026-11-10T00:00:00Z", leg: "swap:XLM", hash: "a".repeat(64), maxTime: 1000, action: "USDC → XLM swap" }] });
  const other = client();
  await assert.rejects(run(other, {}, panel.pendingStore(() => storage)), /a{64} \(USDC → XLM swap\) was signed outside this run/);
  assert.deepEqual(signedCalls(other), []);
});

test("an existing trustline needs no transaction, and a failed swap stops the run before the deposit", async () => {
  const c = client({ outcomes: { "swap XLM": "fail" }, account: { ...ACCOUNT, lines: { ...ACCOUNT.lines, tRESERVE: "0.0000000" } } });
  const { states, result, store } = await run(c);
  assert.equal(result, false);
  assert.deepEqual(signedCalls(c), ["swap XLM"]);
  assert.equal(states["trustline:tRESERVE"].status, "skipped");
  assert.deepEqual([states["swap:XLM"].status, states["swap:XLM"].error], ["failed", "swap XLM failed onchain; only the fee was charged."]);
  assert.equal(states["vault:etesia-tf"], undefined);
  assert.deepEqual(store.list(OWNER), []);
  // Continue runs only the remaining legs.
  const again = client({ account: { ...ACCOUNT, lines: { ...ACCOUNT.lines, tRESERVE: "0" } } });
  await run(again, states);
  assert.deepEqual(signedCalls(again), ["swap XLM", "swap tRESERVE", "deposit 7"]);
});

test("a run is refused before any signature when the checks fail", async () => {
  const c = client({ account: { ...ACCOUNT, balance: "1.0000000" } });
  await assert.rejects(run(c), /Not enough USDC/);
  assert.deepEqual(signedCalls(c), []);
});

const render = (props) => renderToStaticMarkup(React.createElement(panel.ExecutionPanel, { net: TESTNET, owner: OWNER, open: [], earlier: [], storageOk: true,
  running: false, networkError: null, wrongAccount: false, onRun() {}, onCheck() {}, onCheckOpen() {}, ...props }));
const planFor = (quotes = {}, allocation = ALLOCATION) => ({ ...execution.testnetLegs(allocation, TESTNET), quotes, check: null });
const runButton = (html) => /<button class="btn lg"( disabled="")?>.*?<\/button>/.exec(html);

test("an unknown leg blocks Continue until Check status resolves it, and is never signed again meanwhile", async () => {
  const c = client({ outcomes: { "swap XLM": "unknown" } });
  const { states, store } = await run(c);
  assert.equal(states["swap:XLM"].status, "unknown");
  const record = states["swap:XLM"].signed;
  assert.deepEqual(store.list(OWNER).filter(r => !r.outcome), [record]); // kept until it resolves
  const plan = planFor();
  let html = render({ plan, states });
  assert.ok(runButton(html)[1], "run disabled while unknown");
  assert.ok(html.includes("Check status") && html.includes(record.hash));
  // Still pending by the network's clock: it stays unknown and blocking.
  assert.equal(panel.checkedState({ status: "PENDING" }, record).status, "unknown");
  // Resolved as confirmed: the receipt shows and Continue is offered.
  states["swap:XLM"] = panel.checkedState({ status: "SUCCESS", receipt: { action: "x", hash: record.hash, ledger: 99, returned: "1.3 XLM" } }, record);
  html = render({ plan, states });
  assert.ok(!runButton(html)[1] && html.includes("Continue with the remaining legs"));
  // Expired without inclusion: the leg can be signed again; failed onchain: only the fee was charged.
  assert.equal(panel.checkedState({ status: "EXPIRED" }, record).status, "pending");
  assert.match(panel.checkedState({ status: "FAILED" }, record).error, /only the fee was charged/);
});

test("a stored unresolved hash blocks a new run after a reload; a resolved one is cleared", async () => {
  const pending = { generatedAt: "2026-11-10T00:00:00Z", leg: "swap:XLM", hash: "c".repeat(64), maxTime: 1000, action: "USDC → XLM swap", returns: { decimals: 7, unit: "XLM" } };
  const expired = { ...pending, leg: "vault:etesia-tf", hash: "d".repeat(64) };
  const storage = memoryStorage({ [OWNER]: [pending, expired] });
  const store = panel.pendingStore(() => storage);
  const c = client({ checks: [{ status: "PENDING" }, { status: "EXPIRED" }] });
  const prepared = await panel.prepareRun(c, ALLOCATION, TESTNET, store);
  assert.deepEqual(c.log.filter(e => typeof e === "string" && e.startsWith("check")), [`check ${pending.hash}`, `check ${expired.hash}`]);
  assert.deepEqual(prepared.open, [pending]);
  assert.deepEqual(store.list(OWNER), [pending]);
  const html = render({ plan: prepared.plan, states: {}, open: prepared.open, earlier: prepared.earlier });
  assert.ok(runButton(html)[1], "run disabled while a stored hash is unresolved");
  assert.ok(html.includes("Pending transaction") && html.includes(pending.hash) && html.includes("nothing can be signed until it resolves"));
  assert.ok(html.includes(`/tx/${expired.hash}`) && html.includes("expired without being included"));
  // Without browser storage the page says so.
  assert.equal(panel.pendingStore(() => { throw new Error("SecurityError"); }), null);
  assert.ok(render({ plan: prepared.plan, states: {}, storageOk: false }).includes("Browser storage is unavailable"));
});

test("after a reload, legs an earlier allocation executed (or may have) block the rebuilt run until acknowledged", async () => {
  const receipt = { action: "Swap 6.5 USDC → XLM", hash: "1".repeat(64), ledger: 60, returned: "13 XLM" };
  const confirmed = { generatedAt: "2026-11-10T00:00:00Z", leg: "swap:XLM", hash: receipt.hash, maxTime: 1000, action: "USDC → XLM swap", outcome: { status: "SUCCESS", receipt } };
  const old = { generatedAt: "2026-11-10T00:00:00Z", leg: "vault:etesia-tf", hash: "2".repeat(64), maxTime: 1000, action: "ETESIA-TF vault deposit" };
  const storage = memoryStorage({ [OWNER]: [confirmed, old] });
  const store = panel.pendingStore(() => storage);
  // A stored receipt is not checked again; a record past its time bound outside the RPC history may have executed.
  const c = client({ checks: [{ status: "OUTSIDE_HISTORY" }] });
  const prepared = await panel.prepareRun(c, ALLOCATION, TESTNET, store);
  assert.deepEqual(c.log.filter(e => typeof e === "string" && e.startsWith("check")), [`check ${old.hash}`]);
  assert.deepEqual(prepared.open, []);
  assert.deepEqual(prepared.earlier.map(e => e.result.status), ["SUCCESS", "OUTSIDE_HISTORY"]);
  assert.equal(store.list(OWNER).length, 2); // both stay until acknowledged
  let html = render({ plan: prepared.plan, states: {}, earlier: prepared.earlier });
  assert.ok(runButton(html)[1], "run disabled until acknowledged");
  assert.ok(html.includes("USDC → XLM swap (earlier allocation)") && html.includes("whether it executed is unknown"));
  assert.ok(html.includes("They are not deducted from this allocation, so running it executes its legs in full again") && html.includes("Acknowledge and allow this run"));
  html = render({ plan: prepared.plan, states: {}, earlier: prepared.earlier.map(e => ({ ...e, acknowledged: true })) });
  assert.ok(!runButton(html)[1] && html.includes("(earlier allocation)"));
  // In this run, an unknown leg resolved outside the RPC history is not signed again and does not block.
  assert.equal(panel.checkedState({ status: "OUTSIDE_HISTORY" }, old).status, "untracked");
});

test("an XLM sell keeps the run's XLM back, and section 05 shows the rebalance, current vs target, above the legs", async () => {
  // XLM quoted at 0.2 USDC, linear: no price impact.
  const c = client({ account: { ...ACCOUNT, xlm: "100.0000000" }, quote: (amountIn, from) => from === "XLM" ? amountIn / 5n : amountIn * 2n });
  const prepared = await panel.prepareRun(c, XLM_SOURCE, TESTNET, null);
  const sell = prepared.plan.legs.find(l => l.key === "sell:XLM");
  // Two base reserves, the USDC line, the tRESERVE line and four transactions: 6 XLM kept back.
  assert.deepEqual([sell.kind, sell.amountIn, prepared.plan.xlmKept], ["sell", 675000000n, 60000000n]);
  assert.equal(prepared.plan.check, null);
  const html = render({ plan: prepared.plan, states: {} });
  assert.ok(html.includes("67.5000000 XLM · keeps 6.0000000 XLM back for fees and the account reserve"));
  // The sell shows its quote's minimum, which is what is signed, the USDC the plan counts on (0.5% below) and its price impact.
  assert.deepEqual(prepared.plan.quotes["sell:XLM"], { amountOut: 135000000n, minOut: 134325000n, impactBps: 0, budgeted: 133653375n });
  assert.ok(html.includes("expected 13.5 USDC · minimum 13.4325 USDC · budgeted 13.3653375 USDC · price impact 0.00%"));
  assert.ok(html.indexOf("Rebalance — current vs target") < html.indexOf("Sell · XLM → USDC"));
  assert.ok(html.includes("Current 100 XLM · 20.0000000 USDC → target 6.5000000 USDC") && html.includes("Sell 67.5000000 XLM"));
  assert.ok(html.includes("Buy · USDC → tRESERVE · USTRY stand-in on testnet") && html.includes("Deposit · ETESIA-TF deposit_bounded"));
  assert.ok(html.includes("scaled down to the USDC the sells provide"));
  // A source within tolerance of its target is shown, with no trade.
  const close = { ...ALLOCATION, sources: [{ symbol: "USDC", percent: 100, quantity: 135000000n }, { symbol: "XLM", percent: 50, quantity: 500000000n }],
    valuation: { USDC: { quantity: 135000000n, value: 135000000n, minOut: 135000000n }, XLM: { quantity: 500000000n, value: 65000000n, minOut: 64000000n } } };
  const html2 = render({ plan: planFor({}, close), states: {} });
  assert.ok(html2.includes("Current 50 XLM · 6.5000000 USDC → target 6.5000000 USDC") && html2.includes("Within tolerance, no trade"));
  assert.ok(!html2.includes("sell:XLM") && !html2.includes("swap:XLM"));
});

test("receipts render only for a SUCCESS, as testnet transactions and not simulations", () => {
  const plan = planFor({ "swap:XLM": { amountOut: 130000000n, minOut: 129350000n } });
  const receipt = { action: "Swap 6.5 USDC → XLM", hash: "e".repeat(64), ledger: 77, returned: "13 XLM" };
  const none = render({ plan, states: { "swap:XLM": { status: "submitted", signed: { hash: receipt.hash } }, "vault:etesia-tf": { status: "unknown", signed: { hash: "f".repeat(64) } } } });
  assert.ok(!none.includes("not a simulation") && !none.includes("tx-receipt"));
  const html = render({ plan, states: { "swap:XLM": { status: "confirmed", receipt } } });
  assert.equal((html.match(/class="tx-receipt"/g) || []).length, 1);
  assert.ok(html.includes("Stellar testnet transaction, not a simulation · Buy · USDC → XLM"));
  assert.ok(html.includes("Confirmed in ledger 77 · contract returned 13 XLM"));
  assert.ok(html.includes(`${TESTNET.explorerUrl}/tx/${receipt.hash}`));
  assert.ok(html.includes("Execution — Stellar testnet transactions signed by your wallet · test funds only"));
  assert.ok(html.includes("Soroswap testnet pool quote; testnet prices are not market prices"));
  assert.ok(html.includes("expected 13 XLM · minimum 12.935 XLM"));
  assert.ok(html.includes("Kept as USDC") && !/Simulat/.test(html));
});

test("a finished run reports it once to the Builder and keeps its records for the next build's acknowledgement", () => {
  const plan = planFor();
  const mine = plan.legs.map((leg, i) => ({ generatedAt: ALLOCATION.generated_at, leg: leg.key, hash: String(i + 1).repeat(64), outcome: { status: "SUCCESS", receipt: { hash: String(i + 1).repeat(64), ledger: 1 } } }));
  const mount = (states) => {
    const store = panel.pendingStore(() => memoryStorage({ [OWNER]: mine }));
    const values = [store, plan, states, [], [], null, null, false], effects = [], finished = [];
    const component = load("components/TestnetExecution.jsx", { "@/lib/vault": vaultLib, "@/lib/execution": execution,
      "@/stores/useStellarWalletStore": { __esModule: true, default: (sel) => sel({ address: OWNER, networkError: null }) },
      react: { ...React, useRef: () => ({ current: null }), useMemo: (fn) => fn(), useEffect: (fn) => effects.push(fn),
        useState: () => [values.shift(), () => {}] } }).default;
    component({ allocation: ALLOCATION, net: TESTNET, onFinished: () => finished.push(1) });
    effects.filter(fn => fn.toString().includes("onFinished")).forEach(fn => fn());
    return { finished, kept: store.list(OWNER).map(r => r.hash) };
  };
  const done = Object.fromEntries(plan.legs.map(leg => [leg.key, { status: "confirmed" }]));
  assert.deepEqual(mount(done), { finished: [1], kept: mine.map(r => r.hash) });
  assert.deepEqual(mount({ ...done, [plan.legs.at(-1).key]: { status: "failed" } }), { finished: [], kept: mine.map(r => r.hash) });
});

test("testnet sources are valued at testnet prices, and a sell counts on 0.5% below its quote's minimum", async () => {
  const c = client();
  const valuation = await panel.valueSources(c, [{ symbol: "USDC", percent: 100, quantity: 50000000n }, { symbol: "XLM", percent: 50, quantity: 1000000000n }], null);
  // The scripted quote returns 2× the input with a 0.5% minimum; the sell counts on 0.5% below that minimum.
  assert.deepEqual(valuation.USDC, { quantity: 50000000n, value: 50000000n, minOut: 50000000n });
  // Valued at a one-XLM reference quote, kept with the valuation.
  assert.deepEqual(valuation.XLM, { quantity: 1000000000n, value: 2000000000n, minOut: 1990000000n * 9950n / 10000n, ref: { amountIn: 10000000n, amountOut: 20000000n } });
  assert.deepEqual(c.quoted, [[10000000n, "XLM", "USDC"]]);
});

// ---------- Price impact (shallow testnet pools) ----------

// Constant-product pools with the 0.3% fee, reserves in units: quote(amountIn, from, to).
const XLM = 10000000n;
const pools = (...pairs) => (amountIn, from, to) => {
  const pool = pairs.find(p => from in p && to in p);
  return amountIn * 997n * pool[to] / (pool[from] * 1000n + amountIn * 997n);
};
// The dry run's testnet pools: XLM/USDC 65,166 / 8,850 and tRESERVE/USDC about 1,000 / 1,000.
const SHALLOW = pools({ XLM: 65166n * XLM, USDC: 8850n * XLM }, { tRESERVE: 1000n * XLM, USDC: 1000n * XLM });
const DEEP = pools({ XLM: 4500n * XLM, USDC: 900n * XLM }, { tRESERVE: 1000000n * XLM, USDC: 1000000n * XLM });
// An allocation from an XLM source, valued as the build values it.
async function xlmAllocation(c, quantity, fractions) {
  const sources = [{ symbol: "XLM", percent: 100, quantity }];
  return { owner: OWNER, generated_at: ALLOCATION.generated_at, sources, valuation: await panel.valueSources(c, sources, null),
    positions: Object.fromEntries(Object.entries(fractions).map(([id, f]) => [id, { allocation_fraction: f }])) };
}
const RICH = { ...ACCOUNT, xlm: "10115.0000000", lines: { ...ACCOUNT.lines, tRESERVE: "0" } };

test("price impact is 1 − (out/in) / (refOut/refIn) in basis points, rounded up, and only a swap above 2% is refused", () => {
  // Reference 10 XLM → 1.3537369 USDC; 8975.516397 XLM → 1068.5082724 USDC: 12.0605%, shown as 12.07%.
  assert.equal(execution.priceImpactBps(89755163970n, 10685082724n, 100000000n, 13537369n), 1207);
  assert.equal(execution.priceImpactBps(1000n, 980n, 10n, 10n), 200);
  assert.equal(execution.priceImpactBps(1000n, 979n, 10n, 10n), 210);
  assert.equal(execution.priceImpactBps(1000n, 1001n, 10n, 10n), 0); // better than the reference
  assert.deepEqual([execution.referenceIn(5n), execution.referenceIn(10000000n), execution.referenceIn(99999999n)], [5n, 10000000n, 10000000n]);
  const legs = [{ key: "sell:XLM", kind: "sell", symbol: "XLM" }, { key: "swap:tRESERVE", kind: "swap", symbol: "tRESERVE" }];
  assert.equal(panel.impactProblem(legs, { "sell:XLM": { impactBps: 200 }, "swap:tRESERVE": { impactBps: 0 } }), null);
  assert.equal(panel.impactProblem(legs, { "sell:XLM": { impactBps: 1205 }, "swap:tRESERVE": { impactBps: 3300 } }),
    "Sell · XLM → USDC: price impact 12.05% is above the 2% limit of the shallow testnet pool. Lower the XLM source's percentage and rebuild. "
    + "Buy · USDC → tRESERVE · USTRY stand-in on testnet: price impact 33.00% is above the 2% limit of the shallow testnet pool. Lower the sources' percentages and rebuild.");
});

test("XLM is valued at the one-XLM reference rate, so the XLM kept is no longer undervalued by the impact of selling all of it", async () => {
  const c = client({ quote: SHALLOW });
  const quantity = 10115n * XLM;
  const { XLM: valued } = await panel.valueSources(c, [{ symbol: "XLM", percent: 100, quantity }], null);
  const ref = SHALLOW(XLM, "XLM", "USDC");
  assert.deepEqual(c.quoted, [[XLM, "XLM", "USDC"]]);
  assert.deepEqual([valued.value, valued.ref], [quantity * ref / XLM, { amountIn: XLM, amountOut: ref }]);
  // A quote of the whole holding is about 13% lower.
  assert.ok(valued.value * 100n > SHALLOW(quantity, "XLM", "USDC") * 113n);
  // Below one unit, the reference quote is of the selected quantity.
  const small = client({ quote: SHALLOW });
  await panel.valueSources(small, [{ symbol: "XLM", percent: 1, quantity: 5000000n }], null);
  assert.deepEqual(small.quoted, [[5000000n, "XLM", "USDC"]]);
});

test("prepareRun quotes each sell at the amount it sells, counts 0.5% below its minimum, sizes the buys on that and signs the sell with it as its floor", async () => {
  const c = client({ quote: DEEP, account: RICH });
  const allocation = await xlmAllocation(c, 100n * XLM, { xlm: .3, xlm_buffer: .025, "etesia-tf": .35, ustry: .3, usdc: .025 });
  c.quoted.length = 0;
  const { plan } = await panel.prepareRun(c, allocation, TESTNET, null);
  const sell = plan.legs.find(l => l.key === "sell:XLM");
  const quoteMin = DEEP(sell.amountIn, "XLM", "USDC") * 9950n / 10000n;
  assert.deepEqual(c.quoted[0], [sell.amountIn, "XLM", "USDC"]);
  assert.equal(sell.minOut, quoteMin * 9950n / 10000n);
  // The buys are the rebalance with that minimum, not with the valuation's.
  assert.deepEqual(plan.legs, execution.testnetLegs(allocation, TESTNET, { XLM: sell.minOut }).legs);
  assert.notDeepEqual(plan.legs, execution.testnetLegs(allocation, TESTNET).legs);
  const spent = plan.legs.filter(l => l.kind === "swap" || l.kind === "vault").reduce((sum, l) => sum + l.amountIn, 0n);
  assert.equal(spent + plan.kept, sell.minOut);
  // The sell is valued against the build's reference quote, not quoted for one again; the buys against fresh ones.
  assert.ok(!c.quoted.some(([amountIn, from]) => amountIn === XLM && from === "XLM"));
  assert.ok(c.quoted.some(([amountIn, from, to]) => amountIn === XLM && from === "USDC" && to === "tRESERVE"));
  assert.ok(plan.quotes["sell:XLM"].impactBps > 0 && plan.quotes["sell:XLM"].impactBps <= 200, String(plan.quotes["sell:XLM"].impactBps));
  assert.equal(plan.impact, null);
  // A leg at or below 2% runs, the sell signed with its minimum as its floor.
  const html = render({ plan, states: {} });
  assert.ok(!runButton(html)[1] && html.includes(`price impact ${(plan.quotes["sell:XLM"].impactBps / 100).toFixed(2)}%`));
  const states = {};
  const ok = await panel.runLegs({ client: c, owner: OWNER, generatedAt: ALLOCATION.generated_at, legs: plan.legs, states, store: null, update: (key, state) => { states[key] = state; } });
  assert.equal(ok, true);
  assert.deepEqual(c.log.find(e => typeof e === "object"), { amountIn: sell.amountIn, floor: sell.minOut, to: OWNER });
  // The account already holds the tRESERVE line: its leg needs no transaction.
  assert.deepEqual(signedCalls(c), ["swap USDC", "swap tRESERVE", `deposit ${vaultLib.fromUnits(plan.legs.at(-1).amountIn, 7)}`]);
});

test("a swap above 2% price impact blocks the run with a message naming it, and nothing is signed", async () => {
  // The dry run: 10,115 XLM into XLM and the vault, with a USTRY reserve.
  const c = client({ quote: SHALLOW, account: RICH });
  const allocation = await xlmAllocation(c, 10115n * XLM, { xlm: .1, xlm_buffer: .025, "etesia-tf": .45, ustry: .4, usdc: .025 });
  const { plan } = await panel.prepareRun(c, allocation, TESTNET, null);
  const sell = plan.quotes["sell:XLM"].impactBps, buy = plan.quotes["swap:tRESERVE"].impactBps;
  assert.ok(sell > 1000 && buy > 200, `${sell} ${buy}`);
  assert.match(plan.impact, new RegExp(`^Sell · XLM → USDC: price impact ${(sell / 100).toFixed(2)}% is above the 2% limit of the shallow testnet pool\\. Lower the XLM source's percentage and rebuild\\. Buy · USDC → tRESERVE · USTRY stand-in on testnet: price impact ${(buy / 100).toFixed(2)}% is above the 2% limit of the shallow testnet pool\\. Lower the sources' percentages and rebuild\\.$`));
  const html = render({ plan, states: {} });
  assert.ok(runButton(html)[1], "run disabled above the limit");
  assert.ok(html.includes(`role="alert" class="data-note" style="color:var(--bad)">Sell · XLM → USDC: price impact ${(sell / 100).toFixed(2)}% is above the 2% limit`));
  assert.ok(html.includes(`· price impact ${(sell / 100).toFixed(2)}%</span>`) && html.includes(`· price impact ${(buy / 100).toFixed(2)}%</span>`));
  // runLegs refuses it too, before any signature.
  const states = {};
  await assert.rejects(panel.runLegs({ client: c, owner: OWNER, generatedAt: ALLOCATION.generated_at, legs: plan.legs, states, store: null, update: (key, state) => { states[key] = state; } }),
    (err) => err.message === plan.impact);
  assert.deepEqual([signedCalls(c), states], [[], {}]);
});

test("the run-start re-check stops before signing when a swap's fresh quote is now above 2%", async () => {
  let quote = DEEP;
  const c = client({ quote: (...args) => quote(...args), account: RICH });
  const allocation = await xlmAllocation(c, 100n * XLM, { xlm: .3, xlm_buffer: .025, "etesia-tf": .35, ustry: .3, usdc: .025 });
  const { plan } = await panel.prepareRun(c, allocation, TESTNET, null);
  assert.equal(plan.impact, null);
  // The XLM pool drained meanwhile: the fresh quotes, with fresh reference quotes, find the sell above the limit.
  quote = pools({ XLM: 450n * XLM, USDC: 90n * XLM }, { tRESERVE: 1000000n * XLM, USDC: 1000000n * XLM });
  c.quoted.length = 0;
  const states = {};
  await assert.rejects(panel.runLegs({ client: c, owner: OWNER, generatedAt: ALLOCATION.generated_at, legs: plan.legs, states, store: null, update: (key, state) => { states[key] = state; } }),
    /^Error: Sell · XLM → USDC: price impact \d+\.\d\d% is above the 2% limit of the shallow testnet pool\. Lower the XLM source's percentage and rebuild\.$/);
  assert.ok(c.quoted.some(([amountIn, from]) => amountIn === XLM && from === "XLM"), "a fresh XLM reference quote");
  assert.deepEqual([signedCalls(c), states], [[], {}]);
});

test("a sell whose prepareRun quote fails blocks the plan, so no run starts on a floor from the spot rate", async () => {
  // 1,000 XLM into the shallow XLM pool: the 400 XLM sell is about 0.6% impact, within the limit,
  // but its spot-rate placeholder floor is above what its quote's minimum can meet.
  let fail = false;
  const c = client({ account: RICH, quote: (amountIn, from, to) => {
    if (fail && from === "XLM") { fail = false; throw Object.assign(new Error("The Soroswap API rate limit was reached. Try again in 1 seconds."), { noPath: false }); }
    return SHALLOW(amountIn, from, to); } });
  c.swapExactIn = ((swap) => async (owner, amountIn, p, onSigned, floor) => {
    const minOut = SHALLOW(amountIn, symbolOf(p[0]), symbolOf(p.at(-1))) * 9950n / 10000n;
    if (minOut < floor) throw new Error(`The quote's minimum ${minOut} is now below ${floor}. Rebuild the allocation.`);
    return swap(owner, amountIn, p, onSigned, floor);
  })(c.swapExactIn);
  const allocation = await xlmAllocation(c, 1000n * XLM, { xlm: .575, xlm_buffer: .025, "etesia-tf": .35, ustry: .025, usdc: .025 });
  fail = true;
  await assert.rejects(panel.prepareRun(c, allocation, TESTNET, null),
    { message: "Sell · XLM → USDC has no quote (The Soroswap API rate limit was reached. Try again in 1 seconds.), and the buys are sized on it. Nothing was signed; rebuild the allocation once the Soroswap API answers." });
  assert.deepEqual(signedCalls(c), []);
  // Once the API answers, the sell's floor comes from its own quote and the run signs it.
  const { plan } = await panel.prepareRun(c, allocation, TESTNET, null);
  const sell = plan.legs.find(l => l.key === "sell:XLM");
  assert.ok(plan.quotes["sell:XLM"].impactBps > 50 && plan.impact === null, String(plan.quotes["sell:XLM"].impactBps));
  assert.equal(sell.minOut, plan.quotes["sell:XLM"].budgeted);
  const states = {};
  assert.equal(await panel.runLegs({ client: c, owner: OWNER, generatedAt: ALLOCATION.generated_at, legs: plan.legs, states, store: null, update: (key, state) => { states[key] = state; } }), true);
  assert.equal(states["sell:XLM"].status, "confirmed");
});

test("a wallet network mismatch or another account blocks signing", () => {
  const plan = planFor();
  assert.ok(runButton(render({ plan, states: {}, networkError: "Wallet network mismatch: switch your wallet to Stellar testnet" }))[1]);
  assert.ok(runButton(render({ plan, states: {}, wrongAccount: true }))[1]);
  assert.ok(!runButton(render({ plan, states: {} }))[1]);
});

test("the connect screen describes testnet execution in testnet mode and keeps the mainnet text", () => {
  const h = builder();
  const intro = (network) => text(h.ConnectScreen({ network, onConnect() {}, connecting: false, error: null }));
  assert.match(intro("testnet"), /execute allocations from your testnet balances as wallet-signed testnet transactions/);
  assert.ok(!/simulated vault|preview allocations/.test(intro("testnet")));
  assert.match(intro("mainnet"), /compare the simulated vault, and preview allocations using your wallet balances/);
});

test("mainnet still renders Simulate execution and signs nothing", () => {
  const h = builder();
  const allocation = { requested_assets: ["xlm"], positions: { xlm: { allocation_fraction: .975, notional_usdc: 97.5, quantity: 300 }, usdc: { allocation_fraction: .025, notional_usdc: 2.5, quantity: 2.5 } },
    model_version: "m", market_data_as_of: "2026-09-19T00:00:00Z", portfolio_value_usdc: 100, allocated_sleeve_volatility: null, binding_constraints: [], diagnostics: [], ...usdcSource(1000000000n), usdcUsd: 1 };
  const tree = h.AllocStage({ network: "mainnet", allocation, coins: [], onReset() {} });
  assert.ok(!nodes(tree).some(n => n.type === h.TestnetExecution));
  const simulation = nodes(tree).find(n => n.type === h.ExecutionSimulation);
  assert.ok(renderToStaticMarkup(simulation).includes("Simulate execution"));
  const source = fs.readFileSync(path.join(root, "components/ExecutionSimulation.jsx"), "utf8");
  assert.ok(!/walletKit|signTx|@\/lib\/vault/.test(source));
  assert.ok(nodes(h.AllocStage({ network: "testnet", allocation, coins: [], onReset() {} })).some(n => n.type === h.TestnetExecution));
});

test("the Builder initialises the wallet kit on the active mode's network", () => {
  for (const [search, expected] of [["?network=testnet", TESTNET], ["", network.MAINNET]]) {
    const calls = { init: [] };
    const state = [];
    state[16] = search ? "testnet" : "mainnet";
    const h = builder(state, calls);
    h.render();
    h.effects.find(fn => fn.toString().includes("initWalletKit"))();
    assert.deepEqual(calls.init, [expected]);
  }
});
