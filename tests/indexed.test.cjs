// D5-06: the Builder proxy's indexed vault routes and the testnet vault page's
// panels fed by them, with fixture responses shaped like the D5-05 metrics API.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { NextRequest } = require("next/server");
const sdk = require("@stellar/stellar-sdk");
const root = path.join(__dirname, "..");

function load(file, imports = {}, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), code)(name => imports[name] ?? require(name), module, module.exports, ...Object.values(globals));
  return module.exports;
}
const network = load("lib/network.ts", { "@/data/testnet-manifest.json": require(path.join(root, "data/testnet-manifest.json")) });
const { TESTNET } = network;
const OWNER = sdk.Keypair.random().publicKey();
const [USDC, XLM, RESERVE] = [TESTNET.usdc.contract, TESTNET.assets.XLM.address, TESTNET.assets.tRESERVE.address];
const hash = (c) => c.repeat(64);

const vaults = load("lib/vaults.ts", { "@/lib/network": network });
function vaultModule(quantRequest = async () => { throw new Error("not used"); }) {
  return load("lib/vault.ts", { "@/lib/network": network, "@/components/stellar/walletKit": { signTx: async () => { throw new Error("not used"); } }, "@/lib/quant": { quantRequest } });
}
// The testnet client merged with the module's network-free helpers.
function vaultLib(quantRequest) {
  const lib = vaultModule(quantRequest);
  return { ...lib, ...lib.vaultClient(TESTNET) };
}

// Responses shaped like d5-05 routes (summary values from the 2026-11-11 testnet sample).
const header = (status, as_of = null, age_seconds = null) => ({ status, as_of, age_seconds, vault: "flagship", contract: TESTNET.vault, network_epoch: "pre-2026-12-16-reset", network: "testnet" });
const target = { epoch: 3, expiry: 1794400000, assets: [XLM, RESERVE, USDC], weights_bps: [1200, 8550, 250], yield_bps: 400 };
const holding = (captured_at, ledger, supply) => ({ captured_at, ledger, errors: {}, assets: [
  { asset: USDC, symbol: "USDC", amount: 800 + supply, spot: 800, supply, collateral: 0, debt: 0, value_usdc: 800 + supply, fraction: .9 },
  { asset: XLM, symbol: "XLM", amount: 500, spot: 500, supply: 0, collateral: 0, debt: 0, value_usdc: 100, fraction: .1 },
] });
const fixtures = {
  summary: { ...header("fresh", "2026-11-11T12:55:00+00:00", 120), ledger: 5680000, tvl_usdc: 1000.8164, share_price_usdc: 1.0006921, total_supply_shares: 1000.1242,
    paused: false, nonce: 47, target, errors: { [`mark:${XLM}`]: "oracle:Stale" },
    indexer: { status: "fresh", as_of: "2026-11-11T12:57:00+00:00", age_seconds: 30, next_ledger: 5680001, latest_ledger: 5680003, lag_ledgers: 3, gaps: [] } },
  history: { ...header("stale", "2026-11-11T12:00:00+00:00", 3300),
    points: Array.from({ length: 12 }, (_, i) => ({ captured_at: `2026-11-11T${String(i).padStart(2, "0")}:00:00+00:00`, ledger: 5679000 + i, tvl_usdc: 1000 + i / 10, share_price_usdc: 1 + i / 10000, total_supply_shares: 1000.1242, errors: {} })),
    plan_equity: [{ ledger: 5679500, closed_at: "2026-11-11T05:00:00Z", tx_hash: hash("a"), kind: "plan", nonce: 46, before_usdc: 1000.5, after_usdc: 1000.4 }] },
  allocations: { ...header("fresh", "2026-11-11T12:55:00+00:00", 120),
    // A vault supply of 100 USDC (position event at ledger 5679500) falls between the first two snapshots.
    holdings: [holding("2026-11-11T04:00:00+00:00", 5679300, 0), holding("2026-11-11T10:00:00+00:00", 5679700, 100), holding("2026-11-11T12:50:00+00:00", 5679990, 100.0123), { captured_at: "2026-11-11T12:55:00+00:00", ledger: 5680001, assets: null, errors: { holdings: "vault:Pricing" } }],
    targets: [{ ledger: 5679400, closed_at: "2026-11-11T04:59:00Z", tx_hash: hash("b"), hash: hash("c"), ...target }] },
  performance: { ...header("fresh", "2026-11-11T12:55:00+00:00", 120),
    actual: { basis: "actual", annualized: false, start_source: "init-event", start_at: "2026-11-09T00:00:00+00:00", end_at: "2026-11-11T12:55:00+00:00", start_share_price_usdc: 1, end_share_price_usdc: 1.0006921, return_fraction: .0006921, window_days: 2.54 },
    backtest: { basis: "backtest", run_id: "a".repeat(20), start: "2024-01-01", end: "2026-11-10", metrics: { cumulative_net_return: .25, cagr: .08, maximum_drawdown: .12 }, performance: `/v1/vault/backtests/${"a".repeat(20)}/performance` } },
  events: { ...header("fresh", "2026-11-11T12:57:00+00:00", 30), kinds: ["target", "plan", "unwind", "position", "fees", "rewards"], events: [
    { id: "0001", ledger: 5679400, closed_at: "2026-11-11T04:59:00Z", tx_hash: hash("b"), contract: TESTNET.vault, kind: "target", topics: ["target"], data: [hash("c"), {}] },
    { id: "0002", ledger: 5679500, closed_at: "2026-11-11T05:00:00Z", tx_hash: hash("a"), contract: TESTNET.vault, kind: "plan", topics: ["plan"], data: [46, hash("c"), 10005000000, 10004000000, 1] },
    { id: "0003", ledger: 5679500, closed_at: "2026-11-11T05:00:00Z", tx_hash: hash("a"), contract: TESTNET.vault, kind: "position", topics: ["position", 1], data: [0, USDC, "1000000000", [], []] },
  ] },
  position: { ...header("fresh", "2026-11-11T12:57:00+00:00", 30), address: OWNER, shares: 2, shares_atomic: "2000000000000", share_price_usdc: 1.0006921,
    share_price_as_of: "2026-11-11T12:55:00+00:00", value_usdc: 2.0013842, flows: [{ kind: "deposit", ledger: 5679990, closed_at: "2026-11-11T12:40:00Z", tx_hash: hash("d"), assets_usdc: 2, shares: 2 }] },
};

test("proxy allowlists the indexed vault routes, forwards their query string and keeps the key server-side", async () => {
  const calls = [];
  const proxy = load("app/api/quant/[...path]/route.ts", {}, {
    process: { env: { ETESIA_API_URL: "quant.example.test", ETESIA_API_KEY: "private-test-key" } },
    fetch: async (url, options) => { calls.push({ url: String(url), options }); return Response.json({ ...header("missing"), key: undefined }); },
  });
  const get = (endpoint) => proxy.GET(new NextRequest(`http://localhost/api/quant/${endpoint}`), { params: Promise.resolve({ path: endpoint.split("?")[0].split("/") }) });
  for (const view of ["summary", "history", "allocations", "performance", "events", `positions/${OWNER}`, `positions/${TESTNET.vault}`]) {
    for (const name of ["flagship", "guard"]) {
      const response = await get(`vaults/${name}/${view}`);
      assert.equal(response.status, 200);
      assert.equal(calls.at(-1).url, `https://quant.example.test/v1/vaults/${name}/${view}`);
      assert.equal(calls.at(-1).options.headers.Authorization, "Bearer private-test-key");
      assert.ok(!(await response.text()).includes("private-test-key"));
    }
  }
  await get("vaults/flagship/events?kind=plan&kind=position&limit=5");
  assert.equal(calls.at(-1).url, "https://quant.example.test/v1/vaults/flagship/events?kind=plan&kind=position&limit=5");
  await get("vaults/flagship/history?limit=288");
  assert.equal(calls.at(-1).url, "https://quant.example.test/v1/vaults/flagship/history?limit=288");
  await get("tokens?limit=5"); // existing paths keep their exact upstream URL
  assert.equal(calls.at(-1).url, "https://quant.example.test/v1/tokens");
  const before = calls.length;
  for (const endpoint of ["vaults/other/summary", "vaults/flagship/status", "vaults/flagship/summary/extra", `vaults/flagship/positions/M${OWNER.slice(1)}`,
    `vaults/flagship/positions/${OWNER.toLowerCase()}`, "vaults/flagship/positions/GABC", "vaults/../tokens"]) {
    assert.equal((await get(endpoint)).status, 404, endpoint);
  }
  const post = new NextRequest("http://localhost/api/quant/vaults/flagship/summary", { method: "POST", body: "{}" });
  assert.equal((await proxy.POST(post, { params: Promise.resolve({ path: ["vaults", "flagship", "summary"] }) })).status, 404);
  assert.equal(calls.length, before);
});

test("readIndexed requests the flagship views and turns a failed request into an unavailable view", async () => {
  const paths = [];
  const lib = vaultLib(async (p) => {
    paths.push(p);
    if (p.endsWith("/summary")) throw new Error("Quant service is temporarily unavailable");
    return fixtures[Object.keys(fixtures).find(key => p.includes(key === "position" ? "positions/" : `/${key}`))];
  });
  const indexed = await lib.readIndexed(OWNER);
  assert.deepEqual(paths.sort(), ["vaults/flagship/allocations?limit=288", "vaults/flagship/events?limit=100", "vaults/flagship/history?limit=288",
    "vaults/flagship/performance", `vaults/flagship/positions/${OWNER}`, "vaults/flagship/summary"]);
  assert.deepEqual(indexed.summary, { status: "error", error: "Quant service is temporarily unavailable" });
  assert.equal(indexed.position.shares_atomic, "2000000000000");
  assert.equal(lib.freshness(indexed.summary), "Unavailable · Quant service is temporarily unavailable");
  paths.length = 0;
  assert.equal("position" in await lib.readIndexed(null), false);
  assert.equal(paths.length, 5);
});

test("freshness, sampling, event details and Blend accrual read the D5-05 shapes", () => {
  const lib = vaultLib();
  assert.equal(lib.freshness(undefined), "Reading the indexer…");
  assert.equal(lib.freshness(fixtures.summary), "Fresh · indexed as of 2026-11-11T12:55:00+00:00 · 2 min old");
  assert.equal(lib.freshness(fixtures.history), "Stale · indexed as of 2026-11-11T12:00:00+00:00 · 55 min old");
  assert.equal(lib.freshness(header("missing")), "Missing · the indexer has no data for this view yet");
  const sampled = lib.sample(fixtures.history.points, 8);
  assert.equal(sampled.length, 8);
  assert.equal(sampled[0], fixtures.history.points[0]);
  assert.equal(sampled.at(-1), fixtures.history.points.at(-1));
  assert.equal(lib.sample([1, 2], 8).length, 2);
  const [targetEvent, plan, position] = fixtures.events.events;
  assert.equal(lib.eventDetail(plan, fixtures.history, fixtures.allocations), "nonce 46 · equity 1000.5 → 1000.4 USDC");
  assert.equal(lib.eventDetail(targetEvent, fixtures.history, fixtures.allocations), "epoch 3 · XLM 12% · tRESERVE 85.5% · USDC 2.5% · Blend yield 4% of the residual reserve");
  assert.equal(lib.eventDetail(position), "Blend supply 100 USDC");
  assert.equal(lib.eventDetail({ kind: "rewards", tx_hash: hash("e"), data: [USDC, "9007199254740993"] }), `["${USDC}","9007199254740993"]`);
});

test("Blend interest leaves out intervals with a supply or withdraw and intervals the events do not cover", () => {
  const lib = vaultLib();
  const { holdings } = fixtures.allocations;
  const accrual = (events = fixtures.events, next = 5680001, list = holdings) =>
    lib.supplyAccrual(list, events, next).map(a => ({ ...a, change: Number(a.change.toFixed(7)) }));
  // The 0 → 100 USDC step is the vault's own supply (position event), not interest.
  assert.deepEqual(accrual(), [{ symbol: "USDC", from: "2026-11-11T04:00:00+00:00", to: "2026-11-11T12:50:00+00:00", change: .0123, counted: 1, intervals: 2 }]);
  // Without the event the step would count: the events view decides what is interest.
  assert.equal(accrual({ ...fixtures.events, events: [] })[0].change, 100.0123);
  // A Blend withdraw of USDC inside the last interval removes it as well.
  const withdraw = { id: "0004", ledger: 5679800, closed_at: "2026-11-11T11:00:00Z", tx_hash: hash("f"), contract: TESTNET.vault, kind: "position", topics: ["position", 1], data: [1, USDC, "50000", [], []] };
  assert.deepEqual(accrual({ ...fixtures.events, events: [...fixtures.events.events, withdraw] })[0], { symbol: "USDC", from: "2026-11-11T04:00:00+00:00", to: "2026-11-11T12:50:00+00:00", change: 0, counted: 0, intervals: 2 });
  // A position event for another asset does not.
  assert.equal(accrual({ ...fixtures.events, events: [...fixtures.events.events, { ...withdraw, data: [1, XLM, "50000", [], []] }] })[0].counted, 1);
  // A full page of events that starts after an interval does not cover it.
  const page = Array.from({ length: lib.EVENTS_LIMIT }, (_, i) => ({ ...withdraw, id: String(i), ledger: 5679995, data: [1, XLM, "1", [], []] }));
  assert.equal(accrual({ ...fixtures.events, events: page })[0].counted, 0);
  // Snapshots at or past the indexer's next ledger may hold unindexed events.
  assert.equal(accrual(fixtures.events, 5679990)[0].counted, 0);
  assert.deepEqual(accrual(fixtures.events, null), []);
  assert.deepEqual(accrual({ status: "error", error: "down" }), []);
  // An asset absent from the earlier snapshot is not counted from zero.
  const absent = holdings.map((h, i) => i === 1 ? { ...h, assets: h.assets.filter(a => a.symbol !== "USDC") } : h);
  assert.equal(accrual({ ...fixtures.events, events: [] }, 5680001, absent)[0].counted, 0);
  assert.deepEqual(lib.supplyAccrual([], fixtures.events, 5680001), []);
});

function component(imports = {}, globals = {}) {
  return load("components/VaultDesk.jsx", { "@/lib/vault": vaultModule(), "@/lib/vaults": vaults,
    "@/components/NetworkSwitch": { __esModule: true, default: () => null },
    "@/stores/useStellarWalletStore": { default: () => null }, "@/components/stellar/walletKit": {}, ...imports }, globals);
}

test("the testnet vault page mounts the indexed vault section before any wallet connects", () => {
  const { default: VaultDesk } = component({
    "@/stores/useStellarWalletStore": { __esModule: true, default: sel => sel({ address: null, connected: false }) },
    "@/components/stellar/walletKit": { initWalletKit() {}, connectWallet() {}, disconnectWallet() {} } }, { window: { location: { search: "" } } });
  const html = renderToStaticMarkup(React.createElement(VaultDesk, { slug: "stellar_tf_vault", network: "testnet" }));
  assert.ok(html.includes("Vault — indexed metrics"));
  assert.ok(html.includes("Key metrics · Stellar testnet vault (pre-2026-12-16-reset), indexed"));
  assert.ok(html.includes("Vault summary") && html.includes("Reading the indexer…"));
  // The deposit is reached directly: the wallet comes right after the key metrics, the detailed panels after it.
  assert.ok(html.indexOf("Key metrics") < html.indexOf("Connect wallet") && html.indexOf("Connect wallet") < html.indexOf("Vault summary"));
});

test("indexed panels show each view's values with its status, and stale, missing and failed views are labelled", () => {
  const { IndexedVault } = component();
  const client = vaultLib();
  const html = renderToStaticMarkup(React.createElement(IndexedVault, { indexed: fixtures, client }));
  for (const text of ["1,000.8164 USDC", "1.0006921 USDC", "1,000.1242 shares", "Open", "nonce 47", "XLM 12% · tRESERVE 85.5% · USDC 2.5%", "3 ledgers behind",
    `mark:${XLM} oracle:Stale`, "Fresh · indexed as of 2026-11-11T12:55:00+00:00", "Stale · indexed as of 2026-11-11T12:00:00+00:00",
    "12 snapshots", "Holdings at 2026-11-11 12:50 UTC", "Blend interest · supplied USDC +0.0123 over 1 of 2 snapshot intervals",
    "Latest snapshot at 2026-11-11 12:55 UTC failed (holdings vault:Pricing); showing the last successful snapshot at 2026-11-11 12:50 UTC.",
    "Weights over time · 4 of 4 snapshots", "<td>90.00%</td><td>10.00%</td>", "— · holdings vault:Pricing", "Newest 3 of the latest 3 returned",
    "Actual share-price return", "0.07%", "Backtest · simulated", "cumulative 25.00%", "simulated history, not vault results",
    "Rebalance · plan", "nonce 46 · equity 1000.5 → 1000.4 USDC", "Blend yield · position", "Blend supply 100 USDC", `/tx/${hash("a")}`]) {
    assert.ok(html.includes(text), text);
  }
  const degraded = renderToStaticMarkup(React.createElement(IndexedVault, { client, indexed: {
    summary: { ...fixtures.summary, ...header("missing"), tvl_usdc: null },
    history: { status: "error", error: "Quant request timed out" },
    performance: { ...fixtures.performance, backtest: null },
  } }));
  assert.ok(degraded.includes("Missing · the indexer has no data for this view yet"));
  assert.ok(degraded.includes("Unavailable · Quant request timed out"));
  assert.ok(degraded.includes("Reading the indexer…")); // allocations and events not loaded yet
  assert.ok(degraded.includes("No published backtest"));
  assert.ok(!degraded.includes("TVL")); // a missing view shows no stand-in values
  // The latest snapshot succeeded: no stale-holdings note.
  const current = renderToStaticMarkup(React.createElement(IndexedVault, { client, indexed: { ...fixtures, allocations: { ...fixtures.allocations, holdings: fixtures.allocations.holdings.slice(0, 3) } } }));
  assert.ok(current.includes("Holdings at 2026-11-11 12:50 UTC") && !current.includes("showing the last successful snapshot"));
});

test("the indexed position sits next to the contract read and says whether the shares match", () => {
  const { IndexedPosition } = component();
  const render = (props) => renderToStaticMarkup(React.createElement(IndexedPosition, props));
  const same = render({ view: fixtures.position, contractShares: BigInt("2000000000000") });
  assert.ok(same.includes("2 shares") && same.includes("matches the contract read") && same.includes("2.0013842 USDC") && same.includes("1 indexed deposits"));
  assert.ok(render({ view: fixtures.position, contractShares: BigInt(1) }).includes("differs from the contract read"));
  assert.ok(render({ view: { ...fixtures.position, ...header("missing") }, contractShares: BigInt(1) }).includes("Missing"));
});

test("the execution row is labelled as simulated at $1 per share, naming only the active network", () => {
  const { default: ExecutionSimulation } = load("components/ExecutionSimulation.jsx", { "@/lib/execution": { executionQuotes: () => new Promise(() => {}), tokenUnits: String } });
  const html = renderToStaticMarkup(React.createElement(ExecutionSimulation, { allocation: {}, funding: {}, usdcUsd: 1, vaultReason: "there is no mainnet vault" }));
  assert.ok(html.includes("The Etesia-TF row is simulated at $1 per share: there is no mainnet vault."));
  assert.ok(!/testnet/i.test(html), html);
  const source = fs.readFileSync(path.join(root, "components/ExecutionSimulation.jsx"), "utf8");
  assert.ok(source.includes("`Simulated at $1 per share · ${vaultReason} · no swap quote`"));
  assert.ok(!/[Aa]ssumed \$1|testnet/i.test(source));
});

// The key metrics moved from the catalog card to the vault page (VaultDesk).
function catalogEntry() {
  const { VaultMetrics } = component();
  const client = vaultLib();
  return { IndexedVaultEntry: ({ indexed }) => React.createElement(VaultMetrics, { indexed, client }) };
}

test("the vault page's key metrics show the indexed testnet vault metrics, each with its freshness", () => {
  const { IndexedVaultEntry } = catalogEntry();
  const html = renderToStaticMarkup(React.createElement(IndexedVaultEntry, { indexed: fixtures }));
  for (const text of ["Key metrics · Stellar testnet vault (pre-2026-12-16-reset), indexed", "1.0006921 USDC", "1,000.8164 USDC",
    "USDC 90.00% vs 2.5% target · XLM 10.00% vs 12% target · tRESERVE — vs 85.5% target · holdings at 2026-11-11 12:50 UTC · target epoch 3 expired at 2026-11-11 12:26 UTC",
    'data-status="stale">Latest snapshot at 2026-11-11 12:55 UTC failed (holdings vault:Pricing); showing the last successful snapshot at 2026-11-11 12:50 UTC.',
    "2026-11-11 05:00 UTC · plan · nonce 46 · equity 1000.5 → 1000.4 USDC", `${TESTNET.explorerUrl}/tx/${hash("a")}`,
    "USDC +0.0123 interest over 1 of 2 snapshot intervals from 2026-11-11 04:00 UTC to 2026-11-11 12:50 UTC", "0.07% over 2.54 days · not annualized",
    "0.00% over 12 snapshots from 2026-11-11 00:00 UTC to 2026-11-11 11:00 UTC · share price, not annualized", "Stale · indexed as of 2026-11-11T12:00:00+00:00",
    "Fresh · indexed as of 2026-11-11T12:55:00+00:00 · 2 min old", "events · Fresh · indexed as of 2026-11-11T12:57:00+00:00",
    "Not used in the Builder allocation or the simulated execution, which price the vault at $1 per share."]) {
    assert.ok(html.includes(text), text);
  }
  assert.ok(!html.includes("unavailable"));
});

test("the key metrics label stale, missing, failed and loading views and never shows a stand-in number", () => {
  const { IndexedVaultEntry } = catalogEntry();
  const render = (indexed) => renderToStaticMarkup(React.createElement(IndexedVaultEntry, { indexed }));
  const degraded = render({
    summary: { status: "error", error: "Quant request timed out" },
    allocations: { ...fixtures.allocations, ...header("missing"), holdings: [], targets: [] },
    events: { ...fixtures.events, ...header("stale", "2026-11-11T11:00:00+00:00", 7000), events: [] },
    performance: { ...fixtures.performance, actual: { ...fixtures.performance.actual, return_fraction: null } },
  });
  assert.ok(degraded.includes("Unavailable · Quant request timed out"));
  assert.ok(degraded.includes("Missing · the indexer has no data for this view yet"));
  assert.ok(degraded.includes('data-status="stale">Stale · indexed as of 2026-11-11T11:00:00+00:00 · 117 min old'));
  assert.ok(degraded.includes("None in the latest 0 indexed events"));
  // Share price, TVL, allocation, Blend yield and the null actual return.
  assert.equal(degraded.match(/<dd>unavailable<\/dd>/g).length, 5);
  assert.ok(!/\d USDC|vs \d/.test(degraded));
  // A snapshot whose holdings() failed throughout has no allocation, and no target is stated as such.
  const noTarget = render({ ...fixtures, allocations: { ...fixtures.allocations, targets: [] } });
  assert.ok(noTarget.includes("USDC 90.00% · XLM 10.00% · no published target"));
  const failed = render({ ...fixtures, allocations: { ...fixtures.allocations, holdings: fixtures.allocations.holdings.slice(3) } });
  assert.equal(failed.match(/<dd>unavailable<\/dd>/g).length, 2); // allocation and Blend yield
  const loading = render({});
  assert.equal(loading.match(/<dd>…<\/dd>/g).length, 7);
  assert.ok(loading.includes("Reading the indexer…") && !loading.includes("unavailable"));
});

test("a failed allocations, events, performance or history request leaves its metrics unavailable without breaking the page", () => {
  const { IndexedVaultEntry } = catalogEntry();
  const down = { status: "error", error: "Quant request failed with 504" };
  const html = renderToStaticMarkup(React.createElement(IndexedVaultEntry, { indexed: { ...fixtures, allocations: down, events: down, performance: down, history: down } }));
  // Allocation, last rebalance, Blend yield, actual return and max drawdown.
  assert.equal(html.match(/<dd>unavailable<\/dd>/g).length, 5);
  assert.ok(html.includes("1.0006921 USDC") && html.includes("Unavailable · Quant request failed with 504"));
  assert.ok(!html.includes("showing the last successful snapshot"));
});

test("the key metrics compare against the newest target and shows the latest rebalance or unwind", () => {
  const { IndexedVaultEntry } = catalogEntry();
  const newer = { ...fixtures.allocations.targets[0], ledger: 5679600, tx_hash: hash("g"), epoch: 4, expiry: 1794500000, assets: [XLM, USDC], weights_bps: [3000, 7000] };
  const unwind = { id: "0004", ledger: 5679800, closed_at: "2026-11-11T11:00:00Z", tx_hash: hash("h"), contract: TESTNET.vault, kind: "unwind", topics: ["unwind"], data: [47] };
  const html = renderToStaticMarkup(React.createElement(IndexedVaultEntry, { indexed: { ...fixtures,
    allocations: { ...fixtures.allocations, targets: [...fixtures.allocations.targets, newer] },
    events: { ...fixtures.events, events: [...fixtures.events.events, unwind] } } }));
  // The newest target, not expired at the 12:50 snapshot; tRESERVE is in neither the holdings nor this target.
  assert.ok(html.includes("USDC 90.00% vs 70% target · XLM 10.00% vs 30% target · holdings at 2026-11-11 12:50 UTC</dd>"));
  assert.ok(html.includes("2026-11-11 11:00 UTC · unwind · [47]") && html.includes(`${TESTNET.explorerUrl}/tx/${hash("h")}`));
  // A held asset outside the target is compared with 0%.
  const held = renderToStaticMarkup(React.createElement(IndexedVaultEntry, { indexed: { ...fixtures,
    allocations: { ...fixtures.allocations, targets: [{ ...newer, assets: [USDC], weights_bps: [10000] }] } } }));
  assert.ok(held.includes("USDC 90.00% vs 100% target · XLM 10.00% vs 0% target"));
});

test("Blend yield shows no unmeasured zero, says when nothing is supplied, and max drawdown reads the indexed share price", () => {
  const { IndexedVaultEntry } = catalogEntry();
  const render = (indexed) => renderToStaticMarkup(React.createElement(IndexedVaultEntry, { indexed: { ...fixtures, ...indexed } }));
  const position = (ledger) => ({ ...fixtures.events.events[2], id: String(ledger), ledger });
  // A vault supply or withdraw in every interval: no interval measures interest.
  const moved = render({ events: { ...fixtures.events, events: [...fixtures.events.events, position(5679800)] } });
  assert.ok(!moved.includes("USDC +0") && !moved.includes("interest over"));
  assert.equal(moved.match(/<dd>unavailable<\/dd>/g).length, 1);
  // The latest interval reaches the indexer's next ledger, so its events may not be indexed yet.
  const behind = render({ summary: { ...fixtures.summary, indexer: { ...fixtures.summary.indexer, next_ledger: 5679990 } } });
  assert.ok(!behind.includes("interest over") && behind.match(/<dd>unavailable<\/dd>/g).length === 1);
  const unsupplied = fixtures.allocations.holdings.map(h => h.assets ? { ...h, assets: h.assets.map(a => ({ ...a, supply: 0 })) } : h);
  assert.ok(render({ allocations: { ...fixtures.allocations, holdings: unsupplied } }).includes("<dd>No Blend supply in the latest snapshot</dd>"));
  const prices = [1, 1.1, 0.99, 1.05];
  const dip = render({ history: { ...fixtures.history, points: fixtures.history.points.slice(0, 4).map((p, i) => ({ ...p, share_price_usdc: prices[i] })) } });
  assert.ok(dip.includes("10.00% over 4 snapshots from 2026-11-11 00:00 UTC to 2026-11-11 03:00 UTC · share price, not annualized"));
  const one = render({ history: { ...fixtures.history, points: fixtures.history.points.slice(0, 1) } });
  assert.equal(one.match(/<dd>unavailable<\/dd>/g).length, 1);
});

test("the compact catalog card reads only the summary of the active network's indexer and refreshes every 300 s", async () => {
  const paths = [], intervals = [];
  const runEffects = { ...React, useState: (initial) => [initial, () => {}], useEffect: (fn) => { fn(); } };
  const { default: VaultCatalogEntry } = load("components/VaultCatalogEntry.jsx", { react: runEffects,
    "@/lib/quant": { quantRequest: async (p) => { paths.push(p); return header("missing"); } } }, { setInterval: (fn, ms) => intervals.push(ms), clearInterval() {} });
  renderToStaticMarkup(React.createElement(VaultCatalogEntry, { indexer: TESTNET.indexer }));
  assert.deepEqual(paths, ["vaults/flagship/summary"]);
  assert.deepEqual(intervals, [300000]);
});

test("the compact catalog card shows at most share price and TVL with one freshness line, never a stand-in", () => {
  const { VaultFigures } = load("components/VaultCatalogEntry.jsx", { "@/lib/quant": {} });
  const render = (summary) => renderToStaticMarkup(React.createElement(VaultFigures, { summary }));
  const html = render(fixtures.summary);
  assert.ok(html.includes("Share price · USDC") && html.includes(">1.0007<") && html.includes("TVL · USDC") && html.includes(">1,000.82<"));
  assert.ok(html.includes('data-status="fresh">Fresh · indexed 2026-11-11 12:55 UTC'));
  assert.equal(html.match(/class="stat-val"/g).length, 2);
  for (const detail of ["target", "rebalance", "Blend", "drawdown", "return"]) assert.ok(!html.includes(detail), detail);
  assert.ok(render(header("stale", "2026-11-11T12:00:00+00:00", 3300)).includes('data-status="stale">Stale · indexed 2026-11-11 12:00 UTC'));
  const down = render({ status: "error", error: "Quant request timed out" });
  assert.equal(down.match(/>—</g).length, 2);
  assert.ok(down.includes("Indexer unavailable") && !/\d\.\d/.test(down));
  assert.equal(render(header("missing")).match(/>—</g).length, 2);
  assert.equal(render(null).match(/>…</g).length, 2);
});
