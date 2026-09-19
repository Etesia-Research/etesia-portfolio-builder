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
const compiled = ts.transpileModule(source + "\nexport { FundingPanel, Masthead, CashReservePanel, CoinCard, AllocStage };", {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  fileName: "PortfolioBuilder.jsx",
}).outputText;

function harness(initialState = []) {
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
        return [state[index], (next) => { state[index] = next; }];
      },
    },
    "@/stores/useStellarWalletStore": (selector) => selector(wallet),
    "@/stores/useBalanceStore": (selector) => selector(balances),
    "@/stores/usePriceStore": (selector) => selector(prices),
    "@/components/stellar/walletKit": { initWalletKit() {} },
    "@/lib/prices": {
      referenceValue: (prices, symbol, qty) => prices[symbol]?.price == null ? null : prices[symbol].price * qty,
      fundingValue: (prices, symbol, qty) => prices[symbol]?.price == null ? null : prices[symbol].price * qty,
    },
    "@/lib/quant": {
      fetchUniverse: async () => ({ coins: [], prices: {}, cashReserveAssets: ["ustry"] }),
      quantRequest: (endpoint, body, signal) => new Promise((resolve, reject) => quantRequests.push({ endpoint, body, signal, resolve, reject })),
    },
    "@/lib/balances": {
      fetchHoldings: (address) => new Promise((resolve, reject) => requests.push({ address, resolve, reject })),
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
    coins: [{ tk: "USDC", name: "USD Coin" }], allocationCoins: [{ tk: "XLM" }], excludedCoins: [], reserveValid: true, budget: "20", selectedHolding: "USDC", amount: "1", ...overrides,
  });
  return { ...mod.exports, wallet, balances, requests, quantRequests, buildRef, effects, intervals, state, render, poll, panel };
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

test("EURC reserve selection requires catalog support and a checked route", () => {
  const h = harness();
  let selected;
  const props = { selected: ["usdc"], onChange: value => { selected = value; },
    supported: ["usdc", "eurc", "ustry"], coins: [{ id: "usdc", tk: "USDC" }, { id: "eurc", tk: "EURC" }],
    routes: { USDC: { available: true }, EURC: { available: true } } };
  const inputs = nodes(h.CashReservePanel(props)).filter(node => node.type === "input");
  assert.equal(inputs[1].props.disabled, false);
  inputs[1].props.onChange();
  assert.deepEqual(selected, ["usdc", "eurc"]);
  const split = h.CashReservePanel({ ...props, selected });
  assert.equal((text(split).match(/50% of reserve/g) || []).length, 2);
  for (const override of [{ supported: ["usdc"] }, { routes: { USDC: { available: true } } }]) {
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
    { id: "ustry", tk: "USTRY" }, { id: "etesia-tf", tk: "ETESIA-TF", simulated: true }];
  state[9] = { XLM: { available: true }, USDC: { available: true }, USTRY: { available: true } };
  state[14] = ["usdc", "ustry"];
  state[15] = ["usdc", "ustry"];
  const h = harness(state);
  const panel = nodes(h.render()).find(node => node.type === h.FundingPanel);
  const pending = panel.props.onBuild();
  assert.deepEqual(h.quantRequests[0].body, { assets: ["xlm"], portfolio_value_usdc: 1, annual_volatility_budget: .25, cash_reserves: ["usdc", "ustry"] });
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
