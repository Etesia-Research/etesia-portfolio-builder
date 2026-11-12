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
    "@/components/TestnetExecution": { __esModule: true, default: TestnetExecution },
    "@/components/NetworkSwitch": { __esModule: true, default: () => null },
    "@/stores/useStellarWalletStore": (sel) => sel(store),
    "@/stores/useBalanceStore": (sel) => sel(store),
    "@/stores/usePriceStore": (sel) => sel({ bySymbol: {}, set: () => {} }),
    "@/components/stellar/walletKit": { initWalletKit: (config) => calls.init.push(config), connectWallet() {}, disconnectWallet() {} },
    "@/lib/network": network, "@/lib/vaults": vaults, "@/lib/execution": execution,
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

const ALLOCATED = { requested_assets: ["xlm", "etesia-tf"], owner: "GOWNER", generated_at: "2026-11-12T00:00:00Z", model_version: "m", market_data_as_of: "2026-11-11T00:00:00Z", portfolio_value_usdc: 100,
  positions: { "etesia-tf": { allocation_fraction: .8185, notional_usdc: 81.85, quantity: 81.8, mark_usdc: 1 }, xlm: { allocation_fraction: .1315, notional_usdc: 13.15, quantity: 89.3, mark_usdc: .147 },
    ustry: { allocation_fraction: 0, notional_usdc: 0, quantity: 0, mark_usdc: 1 }, usdc: { allocation_fraction: .025, notional_usdc: 2.5, quantity: 2.5, mark_usdc: 1 }, xlm_buffer: { allocation_fraction: .025, notional_usdc: 2.5, quantity: 17, mark_usdc: .147 } },
  parameters: { builder: { annual_volatility_budget: .25 }, cash_reserves: ["ustry"] }, allocated_sleeve_volatility: .1655883689913353,
  binding_constraints: ["gross_allocation_cap"], diagnostics: [], funding: { symbol: "USDC", amount: "100" }, usdcUsd: 1 };

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
  after.effects.find(fn => fn.toString().includes("fetchHoldings"))()(); // run, then clean up its refresh interval
  assert.deepEqual([after.values[3], after.values[4]], ["select", null]);
});

// ---------- Leg run ----------

const OWNER = sdk.Keypair.random().publicKey();
const ACCOUNT = { funded: true, trustline: true, balance: "1000.0000000", xlm: "100.0000000", subentries: 1, lines: { USDC: "1000.0000000" } };
const ALLOCATION = { owner: OWNER, generated_at: "2026-11-11T12:00:00Z", funding: { symbol: "USDC", amount: "20" },
  positions: Object.fromEntries(Object.entries({ xlm: .3, xlm_buffer: .025, "etesia-tf": .35, ustry: .3, usdc: .025 }).map(([id, f]) => [id, { allocation_fraction: f }])) };
const symbolOf = (contract) => Object.values(TESTNET.assets).find(a => a.address === contract).symbol;
// A scripted client: each signing call reports its envelope, then confirms, fails or ends unknown.
function client({ outcomes = {}, checks = [], account = ACCOUNT, noQuote = [], limited = [] } = {}) {
  const log = [];
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
  return { log, net: TESTNET, SHARES: vaultLib.vaultClient(TESTNET).SHARES, swapReturns: (p) => ({ decimals: 7, unit: symbolOf(p.at(-1)) }),
    vaultError: (err) => err.message, readUsdcLine: async () => account,
    quoteSwap: async (amountIn, p) => { log.push(`quote ${p.map(symbolOf).join("→")}`);
      if (noQuote.includes(symbolOf(p.at(-1)))) throw Object.assign(new Error(`No Soroswap testnet quote for ${p.map(symbolOf).join(" → ")}: Soroswap API 400: No path found`), { noPath: true });
      if (limited.includes(symbolOf(p.at(-1)))) throw Object.assign(new Error(`No Soroswap testnet quote for ${p.map(symbolOf).join(" → ")}: The Soroswap API rate limit was reached. Try again in 1 seconds.`), { noPath: false });
      return { amountOut: amountIn * 2n, minOut: amountIn * 2n * 9950n / 10000n, quote: {} }; },
    preview: async () => 1000000000000n,
    // lib/vault.ts quotes and builds through the Soroswap API inside swapExactIn (tests/vault.test.cjs).
    swapExactIn: async (owner, amountIn, p, onSigned, floor) => { log.push({ amountIn, floor, to: owner });
      if (outcomes[`swap ${symbolOf(p.at(-1))}`] === "unquoted") throw Object.assign(new Error(`No Soroswap testnet quote for ${p.map(symbolOf).join(" → ")}: No path found`), { unquoted: true });
      return sign(`swap ${symbolOf(p.at(-1))}`, onSigned); },
    addUsdcTrustline: async (owner, symbol, onSigned) => sign(`trustline ${symbol}`, onSigned),
    deposit: async (owner, amount, onSigned) => sign(`deposit ${amount}`, onSigned),
    checkTransaction: async (record) => { log.push(`check ${record.hash}`); return checks.shift(); } };
}
function memoryStorage(initial = {}) {
  const data = { "etesia.builder.pending": JSON.stringify(initial) };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = v; } };
}
async function run(c, states = {}, store = panel.pendingStore(() => memoryStorage()), active) {
  const { legs } = execution.testnetLegs(ALLOCATION, 200000000n, TESTNET);
  const updates = [];
  const result = await panel.runLegs({ client: c, owner: OWNER, generatedAt: ALLOCATION.generated_at, legs, states, store, active,
    update: (key, state) => { updates.push([key, state.status]); states[key] = state; } });
  return { legs, states, updates, result, store };
}
const signedCalls = (c) => c.log.filter(e => typeof e === "string" && !e.startsWith("quote") && !e.startsWith("check"));

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
  assert.ok(html.includes("Not executed · No Soroswap testnet quote for USDC → tRESERVE") && html.includes("A swap the Soroswap API finds no path for is not executed"));
  assert.ok(html.includes("Continue with the remaining legs") && !runButton(html)[1]);
});

test("a quote that fails for any reason but No path found (rate limit, outage, missing key) stops the run before anything is signed", async () => {
  const c = client({ limited: ["tRESERVE"] });
  const states = {};
  const { legs } = execution.testnetLegs(ALLOCATION, 200000000n, TESTNET);
  await assert.rejects(panel.runLegs({ client: c, owner: OWNER, generatedAt: ALLOCATION.generated_at, legs, states, store: null, update: (key, state) => { states[key] = state; } }),
    /rate limit was reached\. Try again in 1 seconds\. Nothing was signed; run again once the Soroswap API answers\./);
  assert.deepEqual([signedCalls(c), states], [[], {}]);
});

test("a swap whose quote fails at signing is not executed, while a funding swap's failure stops the run", async () => {
  const c = client({ outcomes: { "swap tRESERVE": "unquoted" } });
  const { states, result } = await run(c);
  assert.equal(result, true);
  assert.deepEqual([states["swap:tRESERVE"].status, states["vault:etesia-tf"].status], ["unavailable", "confirmed"]);
  assert.match(states["swap:tRESERVE"].error, /No path found/);
  const allocation = { ...ALLOCATION, funding: { symbol: "XLM", amount: "100" } };
  const f = client({ outcomes: { "swap USDC": "unquoted" } });
  const prepared = await panel.prepareRun(f, allocation, TESTNET, null);
  const states2 = {};
  const ok = await panel.runLegs({ client: f, owner: OWNER, generatedAt: ALLOCATION.generated_at, legs: prepared.plan.legs, states: states2, store: null,
    update: (key, state) => { states2[key] = state; } });
  assert.equal(ok, false);
  assert.equal(states2.funding.status, "failed");
  // The funding swap's floor is the USDC the plan was budgeted from: 0.5% below the funding quote's minimum.
  const funding = f.log.find(e => typeof e === "object");
  assert.equal(funding.floor, prepared.plan.capital);
  assert.equal(prepared.plan.capital, 930000000n * 2n * 9950n / 10000n * 9950n / 10000n);
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
const planFor = (quotes = {}) => ({ ...execution.testnetLegs(ALLOCATION, 200000000n, TESTNET), capital: 200000000n, quotes, check: null });
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

test("XLM funding keeps the run's XLM back and the funding leg shows it", async () => {
  const allocation = { ...ALLOCATION, funding: { symbol: "XLM", amount: "100" } };
  const c = client({ account: { ...ACCOUNT, xlm: "100.0000000" } });
  const prepared = await panel.prepareRun(c, allocation, TESTNET, null);
  const [funding] = prepared.plan.legs;
  // Two base reserves, the USDC line, the tRESERVE line and five transactions: 7 XLM kept back.
  assert.deepEqual([funding.kind, funding.amountIn, prepared.plan.xlmKept], ["funding", 930000000n, 70000000n]);
  assert.equal(prepared.plan.check, null);
  const html = render({ plan: prepared.plan, states: {} });
  assert.ok(html.includes("93.0000000 XLM of the 100 XLM entered · keeps 7.0000000 XLM back for fees and the account reserve"));
  // The funding swap shows the fresh quote's minimum, which is what is signed, and the budgeted USDC it must cover.
  assert.deepEqual(prepared.plan.quotes.funding, { amountOut: 1860000000n, minOut: 1850700000n, budgeted: prepared.plan.capital });
  assert.ok(html.includes("expected 186 USDC · minimum 185.07 USDC · budgeted 184.14465 USDC"));
});

test("receipts render only for a SUCCESS, as testnet transactions and not simulations", () => {
  const plan = planFor({ "swap:XLM": { amountOut: 130000000n, minOut: 129350000n } });
  const receipt = { action: "Swap 6.5 USDC → XLM", hash: "e".repeat(64), ledger: 77, returned: "13 XLM" };
  const none = render({ plan, states: { "swap:XLM": { status: "submitted", signed: { hash: receipt.hash } }, "vault:etesia-tf": { status: "unknown", signed: { hash: "f".repeat(64) } } } });
  assert.ok(!none.includes("not a simulation") && !none.includes("tx-receipt"));
  const html = render({ plan, states: { "swap:XLM": { status: "confirmed", receipt } } });
  assert.equal((html.match(/class="tx-receipt"/g) || []).length, 1);
  assert.ok(html.includes("Stellar testnet transaction, not a simulation · USDC → XLM swap · XLM, XLM fee buffer"));
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
    model_version: "m", market_data_as_of: "2026-09-19T00:00:00Z", portfolio_value_usdc: 100, allocated_sleeve_volatility: null, binding_constraints: [], diagnostics: [], funding: { symbol: "USDC", amount: "100" }, usdcUsd: 1 };
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
