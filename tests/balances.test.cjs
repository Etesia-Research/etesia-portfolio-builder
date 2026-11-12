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
const vaultLib = loadTs("lib/vault.ts", { "@/lib/network": network, "@/lib/quant": {}, "@/components/stellar/walletKit": { signTx: async () => { throw new Error("not used"); } } });
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

function harness(initialState = [], registry = vaults, testnet = {}) {
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
    "@/components/TestnetExecution": { __esModule: true, default: TestnetExecution, valueSources: testnet.valueSources },
    "@/lib/vault": { ...vaultLib, vaultClient: testnet.vaultClient ?? vaultLib.vaultClient },
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
    coins: [{ tk: "USDC", name: "USD Coin" }], allocationCoins: [{ tk: "XLM" }], reserveValid: true, budget: "20", sources: { USDC: "100" }, setSources() {}, ...overrides,
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
  const h = harness([["XLM", "USDC"], { USDC: "100" }, null, "allocated", null, []]);
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
  assert.deepEqual(h.state.slice(1, 5), [{}, null, "select", null]);
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

test("multi-source holdings: selecting a holding sets it to 100% (MAX); each source's percent adjusts, rounds down, and an invalid one blocks the build", () => {
  const h = harness();
  h.balances.byTk = { USDC: 1.2356789, XLM: 10 };
  h.prices.bySymbol.XLM = { price: .2, ts: "2026-09-19T00:00:00Z", stale: false };
  const coins = [{ tk: "USDC", name: "USD Coin" }, { tk: "XLM", name: "Stellar Lumens" }];
  let sources = {};
  const setSources = (next) => { sources = typeof next === "function" ? next(sources) : next; };
  const tree = () => h.panel({ coins, sources, setSources });
  const rows = (t) => nodes(t).filter((node) => node.props?.className?.startsWith("holding-row"));
  const quick = (t, symbol) => nodes(nodes(t).find((node) => node.props?.["data-source"] === symbol)).filter((node) => node.type === "button");
  assert.match(text(tree()), /Your holdings — select the sources to allocate or rebalance/);
  assert.deepEqual(rows(tree()).map((row) => row.props["aria-checked"]), [false, false]);
  assert.equal(buildButton(tree()).props.disabled, true);
  rows(tree())[0].props.onClick();
  rows(tree())[1].props.onClick();
  assert.deepEqual(sources, { USDC: "100", XLM: "100" });
  assert.match(text(tree()), /1\.2356789 USDC ≈ \$1\.24 · daily close/);
  assert.match(text(tree()), /10 XLM ≈ \$2\.00 · daily close/);
  assert.match(text(tree()), /Hypothetical capital: 3\.24 USDC/);
  assert.equal(buildButton(tree()).props.disabled, false);
  quick(tree(), "USDC")[0].props.onClick();
  assert.equal(sources.USDC, "25");
  assert.match(text(tree()), /0\.3089197 USDC/); // 25% of 1.2356789, rounded down to the stroop
  quick(tree(), "USDC")[3].props.onClick();
  assert.equal(sources.USDC, "100");
  const input = nodes(tree()).find((node) => node.type === "input" && node.props["aria-label"] === "Percent of XLM");
  for (const bad of ["0", "0.5", "100.5", "12.345", "", "."]) {
    input.props.onChange({ target: { value: bad } });
    assert.match(text(tree()), /Enter a percentage from 1 to 100, with at most two decimals\./, bad);
    assert.equal(buildButton(tree()).props.disabled, true, bad);
  }
  input.props.onChange({ target: { value: "12.5" } });
  assert.match(text(tree()), /1\.25 XLM/);
  assert.equal(buildButton(tree()).props.disabled, false);
  rows(tree())[1].props.onClick();
  assert.deepEqual(sources, { USDC: "100" });
});

// The connected owner's testnet account and vault position, as the Builder reads them.
const TESTNET_ACCOUNT = { owner: "A", account: { funded: true, trustline: true, balance: "50.0000000", xlm: "100.0000000", subentries: 1, lines: { USDC: "50.0000000" } },
  position: { shares: 81330000000000n, value: 818500000n, maxWithdraw: 818500000n, liquid: 0n, paused: false } };
const TESTNET_COINS = [{ id: "xlm", tk: "XLM", name: "Stellar Lumens", allocationSupported: true }, { id: "usdc", tk: "USDC", name: "USD Coin" },
  { id: "ustry", tk: "USTRY", name: "USTRY" }, { id: "etesia-tf", tk: "ETESIA-TF", name: "Etesia TF Vault", allocationSupported: true }];
const testnetPage = (sources = {}, testnet = {}, account = TESTNET_ACCOUNT) => {
  const state = [];
  state[0] = ["XLM"]; state[1] = sources; state[2] = account; state[3] = "select"; state[5] = TESTNET_COINS; state[16] = "testnet";
  const h = harness(state, vaults, testnet);
  h.balances.byTk = { XLM: 100, USDC: 50, tRESERVE: 3 };
  const props = nodes(h.render()).find((node) => node.type === h.FundingPanel).props;
  return { h, props, tree: h.FundingPanel(props) };
};

test("testnet holdings: XLM less the most a run keeps back, USDC, tRESERVE as the USTRY stand-in and the vault's shares with their USDC value", () => {
  const { tree } = testnetPage({ XLM: "100", "ETESIA-TF": "50" });
  const rows = nodes(tree).filter((node) => node.props?.className?.startsWith("holding-row")).map(text);
  assert.equal(rows.length, 4);
  assert.match(rows[0], /^XLMStellar Lumens · MAX keeps 6\.0000000 XLM back for fees and the account reserve100/);
  assert.match(rows[1], /^USDCUSD Coin50/);
  assert.match(rows[2], /^tRESERVEUSTRY stand-in on testnet3/);
  assert.match(rows[3], /^ETESIA-TFVault shares · 81\.85 USDC81\.33\$81\.85$/);
  // 100% of XLM is the balance less the keep-back; 50% of the shares.
  assert.match(text(tree), /94 XLM/);
  assert.match(text(tree), /40\.665 shares/);
  assert.match(text(tree), /Valued at testnet Soroswap spot rates \(one-unit quotes\) and the vault's share value when built/);
  assert.ok(!/Hypothetical capital|daily close/.test(text(tree)));
  assert.equal(buildButton(tree).props.disabled, false);
  // Before the testnet account is read, the XLM maximum is 0 and the vault row is absent.
  const { tree: tree2 } = testnetPage({ XLM: "100" }, {}, null);
  assert.ok(!text(tree2).includes("ETESIA-TF"));
  assert.match(text(tree2), /reading the testnet account…/);
  assert.match(text(tree2), /Nothing to allocate: no XLM is selectable at this percentage\./);
  assert.equal(buildButton(tree2).props.disabled, true);
});

test("a testnet build values the selected sources at testnet execution prices, sends their sum as the capital and stores sources and valuation; a failed quote blocks it", async () => {
  const valued = [];
  const valuation = { XLM: { quantity: 940000000n, value: 150000000n, minOut: 149250000n }, "ETESIA-TF": { quantity: 40665000000000n, value: 409250000n, minOut: 407000000n, maxWithdraw: 818500000n } };
  const { h, props } = testnetPage({ XLM: "100", "ETESIA-TF": "50" }, { vaultClient: () => "client", valueSources: async (...args) => { valued.push(args); return valuation; } });
  const pending = props.onBuild();
  await flush();
  assert.deepEqual(valued, [["client", [{ symbol: "XLM", percent: 100, quantity: 940000000n }, { symbol: "ETESIA-TF", percent: 50, quantity: 40665000000000n }], TESTNET_ACCOUNT.position]]);
  assert.equal(h.quantRequests[0].body.portfolio_value_usdc, 55.925);
  h.quantRequests[0].resolve({ status: "valid", positions: { xlm: {} } });
  await pending;
  assert.deepEqual([h.state[4].sources, h.state[4].valuation, h.state[4].owner, "funding" in h.state[4]], [valued[0][1], valuation, "A", false]);
  const failed = testnetPage({ XLM: "100" }, { vaultClient: () => "client", valueSources: async () => { throw new Error("No Soroswap testnet quote for XLM → USDC: Soroswap API 503"); } });
  await failed.props.onBuild();
  assert.equal(failed.h.state[12], "No Soroswap testnet quote for XLM → USDC: Soroswap API 503");
  assert.equal(failed.h.quantRequests.length, 0);
});

test("a testnet selection worth more than 100 USDC is scaled down: every source's percent and quantity by 100/value, valued again, and the cap is stored and shown", async () => {
  const valued = [];
  // 400 USDC selected, then 100 USDC once each part is a quarter of what it was.
  const replies = [
    { XLM: { quantity: 940000000n, value: 1500000000n, minOut: 1492500000n }, "ETESIA-TF": { quantity: 40665000000000n, value: 2500000000n, minOut: 2487500000n, maxWithdraw: 818500000n } },
    { XLM: { quantity: 235000000n, value: 375000000n, minOut: 373125000n }, "ETESIA-TF": { quantity: 10166250000000n, value: 625000000n, minOut: 621875000n, maxWithdraw: 818500000n } },
  ];
  const { h, props, tree } = testnetPage({ XLM: "100", "ETESIA-TF": "50" }, { vaultClient: () => "client", valueSources: async (...args) => { valued.push(args); return replies[valued.length - 1]; } });
  assert.match(text(tree), /Testnet builds use at most 100 USDC of the selected value; a larger selection is scaled down proportionally\./);
  const pending = props.onBuild();
  await flush();
  assert.equal(valued.length, 2);
  assert.deepEqual(valued[1], ["client", [{ symbol: "XLM", percent: 25, quantity: 235000000n }, { symbol: "ETESIA-TF", percent: 12.5, quantity: 10166250000000n }], TESTNET_ACCOUNT.position]);
  assert.equal(h.quantRequests[0].body.portfolio_value_usdc, 100);
  h.quantRequests[0].resolve({ status: "valid", positions: { xlm: {} } });
  await pending;
  assert.deepEqual([h.state[4].sources, h.state[4].valuation, h.state[4].capped], [valued[1][1], replies[1], { from: 4000000000n, to: 1000000000n }]);
  const stage = (capped) => text(h.AllocStage({ network: "testnet", allocation: { ...allocationWith({ xlm: { allocation_fraction: 1, notional_usdc: 100, quantity: 700 } }), ...(capped && { capped }) }, coins: [], onReset() {} }));
  assert.ok(stage({ from: 4000000000n, to: 1000000000n }).includes("Capped: 400 USDC selected, scaled to 100 USDC (25.00% of each source)."));
  assert.ok(!stage(null).includes("Capped"));
  // At or below the cap: valued once, nothing scaled or stored.
  const below = testnetPage({ XLM: "100" }, { vaultClient: () => "client", valueSources: async (...args) => { valued.push(args); return { XLM: { quantity: 940000000n, value: 1000000000n, minOut: 995000000n } }; } });
  valued.length = 0;
  const done = below.props.onBuild();
  await flush();
  below.h.quantRequests[0].resolve({ status: "valid", positions: { xlm: {} } });
  await done;
  assert.deepEqual([valued.length, below.h.quantRequests[0].body.portfolio_value_usdc, "capped" in below.h.state[4]], [1, 100, false]);
});

test("after a finished testnet run the holdings and the vault position are read again for the same owner", async () => {
  const reads = [];
  const client = { readUsdcLine: async (owner) => { reads.push(owner); return TESTNET_ACCOUNT.account; }, readPosition: async () => ({ ...TESTNET_ACCOUNT.position, shares: 1n }), vaultError: (err) => err.message };
  const state = [];
  state[2] = null; state[3] = "executed"; state[5] = TESTNET_COINS; state[16] = "testnet";
  const page = harness(state, vaults, { vaultClient: () => client });
  page.render();
  const effect = page.effects.find((fn) => fn.toString().includes("phase !== 'executed'"));
  effect();
  page.requests[0].resolve({ XLM: 50 });
  await flush(); await flush();
  assert.deepEqual(page.balances.byTk, { XLM: 50 });
  assert.deepEqual([reads, page.state[2].owner, page.state[2].position.shares], [["A"], "A", 1n]);
  // A cancelled refresh (account or network changed) writes nothing.
  const late = harness(state, vaults, { vaultClient: () => client });
  late.render();
  late.effects.find((fn) => fn.toString().includes("phase !== 'executed'"))()();
  late.requests[0].resolve({ XLM: 1 });
  await flush();
  assert.deepEqual(late.balances.byTk, { USDC: 1.2356789 });
  assert.equal(late.state[2], null);
});

test("a failed vault read keeps the testnet account and blocks only builds that involve the vault; a failed account read says so on the XLM row", async () => {
  const client = { readUsdcLine: async () => TESTNET_ACCOUNT.account, readPosition: async () => { throw new Error("RPC 503"); }, vaultError: (err) => err.message };
  const state = [];
  state[2] = null; state[3] = "executed"; state[5] = TESTNET_COINS; state[16] = "testnet";
  const page = harness(state, vaults, { vaultClient: () => client });
  page.render();
  page.effects.find((fn) => fn.toString().includes("phase !== 'executed'"))();
  page.requests[0].resolve({ XLM: 100 });
  await flush(); await flush();
  const read = page.state[2];
  assert.deepEqual([read.owner, read.account, read.position, read.accountError, read.positionError], ["A", TESTNET_ACCOUNT.account, undefined, null, "RPC 503"]);
  // USDC for an XLM basket never needs the vault: Build stays enabled and builds.
  const usdc = testnetPage({ USDC: "100" }, { vaultClient: () => "client", valueSources: async () => ({ USDC: { quantity: 500000000n, value: 500000000n, minOut: 500000000n } }) }, read);
  assert.match(text(usdc.tree), /Could not read the vault position \(RPC 503\)\./);
  assert.match(text(usdc.tree), /MAX keeps 6\.0000000 XLM back/);
  assert.equal(buildButton(usdc.tree).props.disabled, false);
  const pending = usdc.props.onBuild();
  await flush();
  assert.equal(usdc.h.quantRequests.length, 1);
  usdc.h.quantRequests[0].resolve({ status: "valid", positions: { xlm: {} } });
  await pending;
  // The vault in the basket, or its shares selected, needs the position.
  const basket = testnetPage({ USDC: "100" }, {}, read);
  assert.equal(buildButton(basket.h.FundingPanel({ ...basket.props, allocationCoins: [{ tk: "XLM" }, { tk: "ETESIA-TF" }] })).props.disabled, true);
  assert.equal(buildButton(testnetPage({ USDC: "100", "ETESIA-TF": "100" }, {}, read).tree).props.disabled, true);
  // A failed account read: the XLM row says so instead of "reading".
  const { tree } = testnetPage({ XLM: "100" }, {}, { owner: "A", account: undefined, position: TESTNET_ACCOUNT.position, accountError: "Horizon 503", positionError: null });
  assert.match(text(tree), /Could not read the testnet account \(Horizon 503\)\./);
  assert.match(text(tree), /Stellar Lumens · could not read the testnet account/);
  assert.ok(!/reading the testnet account…/.test(text(tree)));
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
  state[1] = { USDC: "100" };
  state[2] = null;
  state[3] = "select";
  state[5] = [{ id: "xlm", tk: "XLM", allocationSupported: true }, { id: "usdc", tk: "USDC" },
    { id: "ustry", tk: "USTRY" }, { id: "etesia-tf", tk: "ETESIA-TF", simulated: true, allocationSupported: true }];
  state[13] = ["usdc", "ustry"];
  state[14] = ["usdc", "ustry"];
  const h = harness(state);
  const panel = nodes(h.render()).find(node => node.type === h.FundingPanel);
  assert.equal(buildButton(h.FundingPanel(panel.props)).props.disabled, false);
  const pending = panel.props.onBuild();
  assert.deepEqual(h.quantRequests[0].body, { assets: ["xlm", "etesia-tf"], portfolio_value_usdc: 1.2356789, annual_volatility_budget: .25, cash_reserves: ["usdc", "ustry"] });
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
  // Testnet USDC and tRESERVE (the USTRY stand-in) by the manifest issuer; mainnet identities are ignored.
  assert.deepEqual([t.XLM, t.USDC, t.tRESERVE, t.AQUA, t.USTRY], [9999.9865156, 99.9987113, 3, 0, 0]);
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
    h.effects.find(fn => fn.toString().includes("setTestnet(null)"))();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].net, net);
  }
});
