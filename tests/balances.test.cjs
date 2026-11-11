const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const React = require("react");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "components/PortfolioBuilder.jsx"), "utf8");
// Load the actual component with controlled hooks, stores, and pending requests.
// Named test exports keep private components out of the production API.
const compiled = ts.transpileModule(source + "\nexport { FundingPanel, Masthead, CashReservePanel, CoinCard, AllocStage, Sidecar, Ticker, fmtCloseDate, metricNote };", {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  fileName: "PortfolioBuilder.jsx",
}).outputText;
function loadTs(file, imports) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((name) => imports[name] ?? require(name), module, module.exports);
  return module.exports;
}
const network = loadTs("lib/network.ts", { "@/data/testnet-manifest.json": require(path.join(root, "data/testnet-manifest.json")) });
const vaults = loadTs("lib/vaults.ts", { "@/lib/network": network });
const execution = loadTs("lib/execution.ts", { "@/lib/network": network, "@/lib/vaults": vaults, "@/lib/assets": loadTs("lib/assets.ts", {}), "@/lib/quant": {} });
const NetworkSwitch = () => null;
const TestnetExecution = () => null;
// A mainnet deployment of the same manifest shape, as config would add it later.
const manifest = require(path.join(root, "data/testnet-manifest.json"));
const mainnetDeployment = network.vaultNetwork({ ...manifest, passphrase: network.MAINNET.passphrase, network_epoch: "mainnet-fixture" },
  { ...network.MAINNET, rpcUrl: "https://rpc.mainnet.example", explorerUrl: "https://stellar.expert/explorer/public", faucetUrl: null, indexer: "vaults/mainnet-fixture" });
const withMainnet = { ...vaults, VAULTS: vaults.VAULTS.map(v => ({ ...v, networks: { ...v.networks, mainnet: mainnetDeployment } })) };
// The real execution preview (quotes left pending), to check what it says in each mode.
const ExecutionSimulation = (() => {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, "components/ExecutionSimulation.jsx"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)((name) => name === "@/lib/execution" ? { executionQuotes: () => new Promise(() => {}), tokenUnits: String } : require(name), module, module.exports);
  return module.exports.default;
})();
const { renderToStaticMarkup } = require("react-dom/server");

function harness(initialState = [], registry = vaults) {
  const wallet = { address: "A", connected: true };
  const balances = { address: "A", byTk: { USDC: 1.2356789 }, lastUpdated: 1, error: null };
  balances.set = (fn) => fn(balances);
  const prices = { bySymbol: { USDC: { price: 1, ts: "2026-09-19T00:00:00Z", stale: false } }, set: () => {} };
  const effects = [];
  const requests = [];
  const quantRequests = [];
  const buildRef = { current: null };
  const intervals = new Map();
  const state = [];
  const imports = {
    react: {
      ...React,
      useRef: () => buildRef,
      useMemo: (fn) => fn(),
      useEffect: (fn) => effects.push(fn),
      useState: (value) => {
        const index = state.length;
        state.push(index in initialState ? initialState[index] : index === 5 ? [{ id: "usdc", tk: "USDC", name: "USD Coin", mcap: null }] : value);
        return [state[index], (next) => { state[index] = typeof next === "function" ? next(state[index]) : next; }];
      },
    },
    "@/components/AllocationSimulation": () => null,
    "@/components/ExecutionSimulation": () => null,
    "next/dynamic": (loader) => Object.assign(() => null, { loader }),
    "@/stores/useStellarWalletStore": (selector) => selector(wallet),
    "@/stores/useBalanceStore": (selector) => selector(balances),
    "@/stores/usePriceStore": (selector) => selector(prices),
    "@/components/stellar/walletKit": { initWalletKit() {} },
    "@/lib/network": network,
    "@/lib/execution": execution,
    "@/components/TestnetExecution": TestnetExecution,
    "@/lib/vaults": registry,
    "@/components/NetworkSwitch": { __esModule: true, default: NetworkSwitch },
    "@/lib/prices": {
      referenceValue: (prices, symbol, qty) => prices[symbol]?.price == null ? null : prices[symbol].price * qty,
      fundingValue: (prices, symbol, qty) => prices[symbol]?.price == null ? null : prices[symbol].price * qty,
    },
    "@/lib/quant": {
      fetchUniverse: async () => ({ coins: [], prices: {}, cashReserveAssets: ["ustry"] }),
      quantRequest: (endpoint, body, signal) => new Promise((resolve, reject) => quantRequests.push({ endpoint, body, signal, resolve, reject })),
    },
    "@/lib/balances": {
      fetchHoldings: (address, net) => new Promise((resolve, reject) => requests.push({ address, net, resolve, reject })),
    },
  };
  const mod = { exports: {} };
  new Function("require", "module", "exports", "setInterval", "clearInterval", compiled)(
    (name) => name in imports ? imports[name] : require(name.startsWith("@/") ? path.join(root, name.slice(2)) : name),
    mod, mod.exports,
    (fn, ms) => { intervals.set(ms, fn); return ms; },
    (id) => intervals.delete(id),
  );
  const render = () => { effects.length = 0; state.length = 0; return mod.exports.default(); };
  const poll = () => { render(); return effects.at(-1)(); };
  const panel = (overrides = {}) => mod.exports.FundingPanel({
    coins: [{ tk: "USDC", name: "USD Coin" }], allocationCoins: [{ tk: "XLM" }], reserveValid: true, budget: "20", selectedHolding: "USDC", amount: "1", ...overrides,
  });
  return { ...mod.exports, wallet, balances, requests, quantRequests, prices, buildRef, effects, intervals, state, render, poll, panel };
}

function nodes(node) {
  if (node == null || typeof node === "boolean") return [];
  if (Array.isArray(node)) return node.flatMap(nodes);
  return [node, ...nodes(node.props?.children)];
}
const text = (node) => nodes(node).filter((part) => typeof part === "string" || typeof part === "number").join("");
const buildButton = (tree) => nodes(tree).find((node) => node.type === "button" && text(node).includes("Build risk-parity"));
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("account switch hides old holdings before the effect and clears allocation state", async () => {
  const h = harness([["XLM", "USDC"], "USDC", "1", "allocated", null, []]);
  h.wallet.address = "B";
  assert.equal(buildButton(h.panel()).props.disabled, true);
  assert.ok(!text(h.panel()).includes("1.2357"));
  const tree = h.render();
  const masthead = nodes(tree).find((node) => node.type === h.Masthead);
  assert.equal(masthead.props.wallet.balance, null);
  h.poll();
  assert.deepEqual(h.balances.byTk, {});
  assert.equal(h.balances.lastUpdated, null);
  assert.equal(h.balances.address, "B");
  assert.deepEqual(h.state.slice(1, 5), [null, "", "select", null]);
  h.requests[0].reject(new Error("Horizon 503"));
  await flush();
  assert.deepEqual(h.balances.byTk, {});
  assert.match(text(h.panel()), /Could not read balances/);
});

test("late results from an old account cannot replace the new account's balances", async () => {
  const h = harness();
  const cleanup = h.poll();
  cleanup();
  h.wallet.address = "B";
  h.poll();
  h.requests[1].resolve({ USDC: 2 });
  await flush();
  h.requests[0].resolve({ USDC: 100 });
  await flush();
  assert.equal(h.balances.address, "B");
  assert.deepEqual(h.balances.byTk, { USDC: 2 });
});

test("disconnect clears balances and returns to the connection screen", () => {
  const h = harness();
  h.wallet.address = null;
  h.poll();
  assert.deepEqual(h.balances.byTk, {});
  assert.equal(h.balances.lastUpdated, null);
  assert.equal(h.state[3], "connect");
  assert.equal(h.requests.length, 0);
});

test("quick amounts preserve MAX and round fractions down to seven decimals", () => {
  const h = harness();
  for (const balance of [1.2356789, 0.0000001, 0.0000019, 999.9999999]) {
    h.balances.byTk.USDC = balance;
    let amount;
    const buttons = nodes(h.panel({ setAmount: (value) => { amount = value; } }))
      .filter((node) => node.type === "button" && node.props.className === "qa");
    buttons.forEach((button, index) => {
      button.props.onClick();
      assert.match(amount, /^\d+\.\d{7}$/);
      assert.ok(Number(amount) <= balance * ((index + 1) / 4));
      if (index === 3) {
        assert.equal(Number(amount), balance);
        assert.equal(buildButton(h.panel({ amount })).props.disabled, false);
      }
    });
  }
});

test("refresh errors remain visible with holdings and recovery enables construction", async () => {
  const h = harness();
  h.poll();
  h.requests[0].resolve({ USDC: 10 });
  await flush();
  assert.equal(buildButton(h.panel()).props.disabled, false);
  h.intervals.get(30000)();
  h.requests[1].reject(new Error("Horizon 503"));
  await flush();
  assert.match(text(h.panel()), /Displayed balances are stale/);
  assert.equal(buildButton(h.panel()).props.disabled, true);
  const tree = h.render();
  const masthead = nodes(tree).find((node) => node.type === h.Masthead);
  assert.match(text(h.Masthead(masthead.props)), /stale \(refresh failed\)/);
  h.intervals.get(30000)();
  h.requests[2].resolve({ USDC: 9 });
  await flush();
  assert.equal(h.balances.error, null);
  assert.ok(!text(h.panel()).includes("stale"));
  assert.equal(buildButton(h.panel()).props.disabled, false);
});


test("reserve selector rejects missing EURC data and toggles equal reserve selections", () => {
  const h = harness();
  let selected;
  const tree = h.CashReservePanel({ selected: ["ustry"], onChange: value => { selected = value; },
    supported: ["usdc", "ustry"], coins: [{ id: "usdc", tk: "USDC" }, { id: "ustry", tk: "USTRY" }],
    routes: { USDC: { available: true }, USTRY: { available: true } } });
  const inputs = nodes(tree).filter(node => node.type === "input");
  assert.deepEqual(inputs.map(node => node.props.checked), [false, false, true]);
  assert.equal(inputs[1].props.disabled, true);
  inputs[0].props.onChange();
  assert.deepEqual(selected, ["ustry", "usdc"]);
  assert.match(text(tree), /Daily data unavailable/);
  assert.match(text(tree), /100% of reserve/);
});

test("EURC reserve selection requires catalog support without a route", () => {
  const h = harness();
  let selected;
  const props = { selected: ["usdc"], onChange: value => { selected = value; },
    supported: ["usdc", "eurc", "ustry"], coins: [{ id: "usdc", tk: "USDC" }, { id: "eurc", tk: "EURC" }],
    routes: { USDC: { available: true }, EURC: { available: true } } };
  props.routes = {};
  const inputs = nodes(h.CashReservePanel(props)).filter(node => node.type === "input");
  assert.equal(inputs[1].props.disabled, false);
  inputs[1].props.onChange();
  assert.deepEqual(selected, ["usdc", "eurc"]);
  const split = h.CashReservePanel({ ...props, selected });
  assert.equal((text(split).match(/50% of reserve/g) || []).length, 2);
  for (const override of [{ supported: ["usdc"] }, { coins: [{ id: "usdc", tk: "USDC" }] }]) {
    const unavailable = nodes(h.CashReservePanel({ ...props, ...override })).filter(node => node.type === "input");
    assert.equal(unavailable[1].props.disabled, true);
  }
});

test("reserve products are absent from the initial product selection", () => {
  const state = [];
  state[5] = ["xlm", "usdc", "ustry", "eurc", "etesia-tf"].map(id => ({ id, tk: id.toUpperCase() }));
  const h = harness(state);
  const cards = nodes(h.render()).filter(node => node.type === h.CoinCard);
  assert.deepEqual(cards.map(node => node.props.coin.id), ["xlm", "etesia-tf"]);
});

test("allocation requests carry selected products and reserves, and cancelled responses are ignored", async () => {
  const state = [];
  state[0] = ["XLM", "ETESIA-TF"];
  state[1] = "USDC";
  state[2] = "1";
  state[3] = "select";
  state[5] = [{ id: "xlm", tk: "XLM", allocationSupported: true }, { id: "usdc", tk: "USDC" },
    { id: "ustry", tk: "USTRY" }, { id: "etesia-tf", tk: "ETESIA-TF", simulated: true, allocationSupported: true }];
  state[13] = ["usdc", "ustry"];
  state[14] = ["usdc", "ustry"];
  const h = harness(state);
  const panel = nodes(h.render()).find(node => node.type === h.FundingPanel);
  assert.equal(buildButton(h.FundingPanel(panel.props)).props.disabled, false);
  const pending = panel.props.onBuild();
  assert.deepEqual(h.quantRequests[0].body, { assets: ["xlm", "etesia-tf"], portfolio_value_usdc: 1, annual_volatility_budget: .25, cash_reserves: ["usdc", "ustry"] });
  h.buildRef.current.abort();
  h.quantRequests[0].resolve({ status: "valid", positions: { xlm: {} } });
  await pending;
  assert.equal(h.state[4], null);
  assert.equal(h.state[3], "select");
});


test("funding risk-cap slider displays its percentage and updates the calculator budget", () => {
  const h = harness();
  let budget;
  const tree = h.panel({ budget: "25", setBudget: value => { budget = value; } });
  const slider = nodes(tree).find(node => node.type === "input" && node.props.type === "range");
  assert.equal(slider.props.value, "25");
  assert.equal(slider.props["aria-valuetext"], "25% annual volatility");
  slider.props.onChange({ target: { value: "35" } });
  assert.equal(budget, "35");
});


test("Working basket shows pairwise correlation and buy-and-hold Sharpe with honest empty states", () => {
  const h = harness();
  const props = { basket: ["XLM", "ETESIA-TF"], coins: [], analyticsLoading: false,
    analytics: { average_pairwise_correlation: -.1234, sharpe_annualized: 1.2345, return_annualized: .12, max_drawdown: .08, calmar: 1.5, window_end: "2026-09-19T00:00:00Z" } };
  const rendered = text(h.Sidecar(props));
  assert.match(rendered, /Avg. pairwise correlation-0.12/);
  assert.match(rendered, /Basket SR · annualized1.23/);
  assert.match(rendered, /Return · annualized \(CAGR\)12.00%/);
  assert.match(rendered, /Max drawdown-8.00%/);
  assert.match(rendered, /Calmar · annualized1.50/);
  assert.ok(!rendered.includes("Cash reserve assets are selected"));
  assert.match(rendered, /buy and hold/);
  assert.match(rendered, /simulated vault returns/);
  assert.match(rendered, /Window · unavailable to 9\/18\/2026/);
  const single = text(h.Sidecar({ ...props, basket: ["XLM"], analytics: { sharpe_annualized: 0, pairwise_reason: "Select at least two products" } }));
  assert.match(single, /correlation—/);
  assert.match(single, /Select at least two products/);
  assert.match(single, /Basket SR · annualized0.00/);
  const loading = text(h.Sidecar({ ...props, analytics: null, analyticsLoading: true }));
  assert.match(loading, /Calculating basket metrics/);
  assert.ok(!loading.includes("1.23"));
  const failed = text(h.Sidecar({ ...props, analytics: { error: "Quant unavailable" } }));
  assert.match(failed, /Quant unavailable/);
  assert.match(failed, /Basket SR · annualized—/);
  assert.ok(!text(h.Sidecar({ ...props, basket: [] })).includes("Basket SR"));
});

test("basket analytics requests follow selection and ignore cancelled results", async () => {
  const state = [];
  state[0] = ["XLM"];
  state[5] = [{ id: "xlm", tk: "XLM" }];
  const h = harness(state);
  h.render();
  const effect = h.effects.find(fn => fn.toString().includes("basket/analytics"));
  const cleanup = effect();
  await new Promise(resolve => setTimeout(resolve, 230));
  assert.equal(h.quantRequests[0].endpoint, "basket/analytics");
  assert.deepEqual(h.quantRequests[0].body, { basket: ["xlm"] });
  cleanup();
  h.quantRequests[0].resolve({ sharpe_annualized: 99 });
  await flush();
  assert.equal(h.state[15].value, null);
  const cleanupCurrent = effect();
  await new Promise(resolve => setTimeout(resolve, 230));
  h.quantRequests[1].resolve({ sharpe_annualized: 1.23 });
  await flush();
  assert.deepEqual(h.state[15], { key: "XLM", value: { sharpe_annualized: 1.23 } });
  cleanupCurrent();
});


test("close labels show the completed UTC candle date without changing price timestamps", () => {
  const h = harness();
  for (const [stamp, expected] of [
    ["2026-09-19T00:00:00Z", "9/18/2026"],
    ["2026-01-01T00:00:00Z", "12/31/2025"],
    ["2024-03-01T00:00:00Z", "2/29/2024"],
  ]) assert.equal(h.fmtCloseDate(stamp), expected);
  assert.equal(h.fmtCloseDate(null), "unavailable");
  const stamp = h.prices.bySymbol.USDC.ts;
  assert.match(text(h.Ticker({ coins: [{ tk: "USDC" }] })), /close 9\/18\/2026/);
  assert.equal(h.prices.bySymbol.USDC.ts, stamp);
  assert.equal(h.metricNote({ window_end: stamp, simulated: true, stale: true }), "Simulated · Stale · Window · unavailable to 9/18/2026");
});

test("unsupported selected vault blocks construction instead of silently disappearing", () => {
  const h = harness();
  const tree = h.panel({ allocationCoins: [{ tk: "XLM", allocationSupported: true }, { tk: "ETESIA-TF", allocationSupported: false }] });
  assert.equal(buildButton(tree).props.disabled, true);
  assert.match(text(tree), /Allocation API update required for ETESIA-TF/);
  assert.ok(!text(tree).includes("Analytics only in this preview"));
});

const allocationWith = (positions) => ({ requested_assets: Object.keys(positions), positions, model_version: "m", market_data_as_of: "2026-09-19T00:00:00Z",
  portfolio_value_usdc: 100, allocated_sleeve_volatility: null, binding_constraints: [], diagnostics: [], funding: {}, usdcUsd: 1 });
const links = (tree) => nodes(tree).filter((node) => node.type === "a").map((node) => node.props.href);

test("in testnet mode every leg executes on testnet: the testnet execution replaces the simulation and the vault hand-off", () => {
  const h = harness();
  const allocation = allocationWith({ "etesia-tf": { allocation_fraction: .4, notional_usdc: 40.25, quantity: 40.25 }, xlm: { allocation_fraction: .6, notional_usdc: 60, quantity: 200 } });
  const tree = h.AllocStage({ network: "testnet", allocation, coins: [], onReset() {} });
  const execution = nodes(tree).filter((node) => node.type === TestnetExecution);
  assert.equal(execution.length, 1);
  assert.equal(execution[0].props.allocation, allocation);
  assert.equal(execution[0].props.net, network.TESTNET);
  assert.ok(!nodes(tree).some((node) => node.props && "vaultReason" in node.props));
  assert.deepEqual(links(tree), []);
  assert.ok(!/not executed|Simulated allocation/.test(text(tree)));
  assert.match(text(tree), /units at the daily-close marks\. The testnet execution below fills at Soroswap testnet pool prices/);
});

test("in mainnet mode the vault leg cannot deposit: it links to the mainnet vault page, never to testnet", () => {
  const h = harness();
  const tree = h.AllocStage({ network: "mainnet", allocation: allocationWith({ "etesia-tf": { allocation_fraction: .4, notional_usdc: 40.25, quantity: 40.25 } }), coins: [], onReset() {} });
  assert.deepEqual(links(tree), ["/stellar_tf_vault/mainnet"]);
  assert.match(text(tree), /Mainnet vault not deployed yet: the Etesia-TF leg is not executed\./);
  assert.ok(!/testnet|amount=/i.test(text(tree) + links(tree).join(" ")));
  // The real execution preview it mounts names no testnet vault and links nowhere.
  const execution = nodes(tree).find((node) => node.props && "vaultReason" in node.props);
  const html = renderToStaticMarkup(React.createElement(ExecutionSimulation, execution.props));
  assert.match(html, /simulated at \$1 per share: there is no mainnet vault\./);
  assert.ok(!/testnet|<a /i.test(html), html);
  assert.ok(!nodes(tree).some((node) => node.type === TestnetExecution));
});

const vaultCard = (h, network, extra = {}) => h.CoinCard({ coin: { id: "etesia-tf", tk: "ETESIA-TF", name: "Etesia TF Vault", simulated: true, marketCap: {}, mcap: null, sharpe: 0.84, analytics: { simulated: true, window_start: "2023-09-19T00:00:00Z", window_end: "2026-09-19T00:00:00Z" } },
  network, selected: false, hasBasket: false, onToggle() {}, maxMcap: 1, ...extra });

test("mainnet mode: the vault card shows only mainnet research figures and links to the mainnet vault page", () => {
  const h = harness();
  const tree = vaultCard(h, "mainnet");
  assert.equal(nodes(tree).some(node => node.type?.loader), false); // no indexed testnet figures are mounted
  assert.match(text(tree), /Mainnet vault not deployed yet/);
  assert.match(text(tree), /Sharpe · annualized · simulated/);
  assert.deepEqual(links(tree), ["/stellar_tf_vault/mainnet"]);
  assert.match(text(tree), /Open vault/);
  assert.ok(!/testnet|pre-2026|indexed|Market cap/i.test(text(tree)));
  // One figure: the vault has no market cap.
  assert.equal(nodes(tree).filter(node => node.props?.className === "stat-val").length, 1);
});

test("mainnet mode with a mainnet deployment (config only): the card shows that deployment's indexed figures, never testnet's", () => {
  const h = harness([], withMainnet);
  const tree = vaultCard(h, "mainnet");
  assert.deepEqual(nodes(tree).find(node => node.type?.loader).props, { indexer: "vaults/mainnet-fixture" });
  assert.match(text(tree), /Mainnet vault · mainnet-fixture/);
  assert.deepEqual(links(tree), ["/stellar_tf_vault/mainnet"]);
  assert.ok(!/testnet|simulated|Sharpe/i.test(text(tree)), text(tree));
  const note = text(h.Sidecar({ network: "mainnet", basket: ["ETESIA-TF"], coins: [], analytics: null, analyticsLoading: false, removeFromBasket() {} }));
  assert.ok(note.includes("a simulated $1 share price: not the mainnet vault's indexed share price."));
});

test("testnet mode: the vault card shows only the testnet vault's two indexed figures and links to the testnet vault page", () => {
  const h = harness();
  const tree = vaultCard(h, "testnet", { hasBasket: true, correlation: { status: "available", correlation: 0.2, simulated: true } });
  const entry = nodes(tree).find(node => node.type?.loader);
  assert.match(String(entry.type.loader), /components\/VaultCatalogEntry/);
  assert.deepEqual(entry.props, { indexer: "vaults/flagship" });
  assert.match(text(tree), /Testnet vault · pre-2026-12-16-reset/);
  assert.deepEqual(links(tree), ["/stellar_tf_vault/testnet"]);
  // No simulated (mainnet research) analytics, correlation pill or factsheet link in testnet mode.
  assert.ok(!/simulated|Sharpe|Market cap|ρ|Window|factsheet/i.test(text(tree)), text(tree));
});

test("other asset cards are the same in both modes and have no vault link", () => {
  const h = harness();
  const card = (network) => h.CoinCard({ coin: { id: "xlm", tk: "XLM", name: "Stellar", marketCap: {}, mcap: 1e9, sharpe: 0.5, analytics: null }, network, selected: false, hasBasket: false, onToggle() {}, maxMcap: 1e9 });
  for (const network of ["mainnet", "testnet"]) {
    assert.equal(nodes(card(network)).some(node => node.type?.loader), false);
    assert.deepEqual(links(card(network)), []);
  }
  assert.equal(text(card("mainnet")), text(card("testnet")));
});

test("the basket note keeps the simulated $1 share price and names only the active network", () => {
  const h = harness();
  const note = (network) => text(h.Sidecar({ network, basket: ["ETESIA-TF"], coins: [{ tk: "ETESIA-TF", name: "Etesia TF Vault", simulated: true }], analytics: null, analyticsLoading: false, removeFromBasket() {} }));
  assert.ok(note("mainnet").includes("a simulated $1 share price: there is no mainnet vault."));
  assert.ok(!/testnet/i.test(note("mainnet")));
  assert.ok(note("testnet").includes("a simulated $1 share price: not the testnet vault's indexed share price."));
  assert.ok(!/assumed \$1/.test(source));
});

test("the masthead shows the Mainnet | Testnet switch with shareable Builder URLs; mainnet is the default", () => {
  const h = harness();
  const select = () => {};
  const tree = h.Masthead({ wallet: null, onDisconnect() {}, network: "testnet", onNetwork: select });
  const toggle = nodes(tree).find(node => node.type === NetworkSwitch);
  assert.equal(toggle.props.active, "testnet");
  assert.equal(toggle.props.onSelect, select);
  assert.deepEqual(["mainnet", "testnet"].map(toggle.props.href), ["/", "/?network=testnet"]);
  assert.equal(vaults.builderNetwork(""), "mainnet");
  assert.equal(vaults.builderNetwork("?network=testnet"), "testnet");
  assert.equal(vaults.builderNetwork("?network=Testnet"), "mainnet");
  assert.equal(vaults.builderNetwork("?network=mainnet&x=1"), "mainnet");
});

test("the masthead, banner and ticker name only the active network", () => {
  const masthead = (h, network) => text(h.Masthead({ wallet: null, onDisconnect() {}, network, onNetwork() {} }));
  const page = (network) => { const state = []; state[16] = network; return harness(state); };
  const vaultCoin = { id: "etesia-tf", tk: "ETESIA-TF", simulated: true };
  const mainnet = page("mainnet");
  assert.match(masthead(mainnet, "mainnet"), /Stellar mainnet(?! market data)/);
  assert.ok(!/testnet/i.test(masthead(mainnet, "mainnet") + text(mainnet.render())));
  assert.match(text(mainnet.render()), /Beta · Quant market data and allocation · Vault returns and execution are simulated/);
  assert.match(text(mainnet.Ticker({ coins: [vaultCoin], network: "mainnet" })), /ETESIA-TF.*under construction/);
  const testnet = page("testnet");
  assert.match(masthead(testnet, "testnet"), /Stellar mainnet market data · testnet balances and execution/);
  assert.match(text(testnet.render()), /Testnet mode · market data from mainnet daily closes · balances, quotes and execution on Stellar testnet, test funds only/);
  // The testnet card shows the indexed share price, so the ticker drops the simulated $1 one.
  assert.ok(!text(testnet.Ticker({ coins: [vaultCoin, { tk: "USDC" }], network: "testnet" })).includes("ETESIA-TF"));
});

// lib/balances.ts itself: mainnet reads mainnet Horizon by the catalog identities;
// testnet mode reads testnet Horizon by the manifest's identities.
function holdingsModule(balances) {
  const urls = [];
  const code = ts.transpileModule(fs.readFileSync(path.join(root, "lib/balances.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", "fetch", code)((name) => name === "@/lib/assets" ? loadTs("lib/assets.ts", {}) : require(name), mod, mod.exports,
    async (url) => { urls.push(url); return { ok: true, status: 200, json: async () => ({ balances }) }; });
  return { ...mod.exports, urls };
}

test("testnet holdings come from testnet Horizon by manifest issuer; mainnet behaviour is unchanged", async () => {
  const assets = loadTs("lib/assets.ts", {}).ASSET_CONTRACTS;
  const [reserveCode, reserveIssuer] = network.TESTNET.assets.tRESERVE.classic.split(":");
  const balances = [
    { asset_type: "native", balance: "9999.9865156" },
    { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: network.TESTNET.usdc.issuer, balance: "99.9987113" },
    { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: assets.USDC.issuer, balance: "7.0000000" },
    { asset_type: "credit_alphanum12", asset_code: reserveCode, asset_issuer: reserveIssuer, balance: "3.0000000" },
    { asset_type: "credit_alphanum4", asset_code: "AQUA", asset_issuer: assets.AQUA.issuer, balance: "5.0000000" },
  ];
  const testnet = holdingsModule(balances);
  const t = await testnet.fetchHoldings("GABC", network.TESTNET);
  assert.deepEqual(testnet.urls, ["https://horizon-testnet.stellar.org/accounts/GABC"]);
  // Testnet USDC by the manifest issuer; mainnet identities and tRESERVE (outside the universe) are ignored.
  assert.deepEqual([t.XLM, t.USDC, t.AQUA, t.USTRY], [9999.9865156, 99.9987113, 0, 0]);
  assert.equal("tRESERVE" in t, false);
  const mainnet = holdingsModule(balances);
  const m = await mainnet.fetchHoldings("GABC");
  assert.deepEqual(mainnet.urls, ["https://horizon.stellar.org/accounts/GABC"]);
  assert.deepEqual([m.XLM, m.USDC, m.AQUA], [9999.9865156, 7, 5]);
});

test("the Builder reads balances on the active mode's network", () => {
  for (const [mode, net] of [["testnet", network.TESTNET], ["mainnet", undefined]]) {
    const state = [];
    state[16] = mode;
    const h = harness(state);
    h.render();
    h.effects.find(fn => fn.toString().includes("fetchHoldings"))();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].net, net);
  }
});
