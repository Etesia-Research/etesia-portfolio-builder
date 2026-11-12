// Vault registry, the /<vault>/<network> pages and the network mode: the two
// networks never mix, and a network without a manifest cannot deposit.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const React = require("react");
const sdk = require("@stellar/stellar-sdk");
const { renderToStaticMarkup } = require("react-dom/server");
const root = path.join(__dirname, "..");

function load(file, imports = {}, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), code)(name => imports[name] ?? require(name), module, module.exports, ...Object.values(globals));
  return module.exports;
}
const testnetManifest = JSON.parse(fs.readFileSync(path.join(root, "data/testnet-manifest.json"), "utf8"));
const network = load("lib/network.ts", { "@/data/testnet-manifest.json": testnetManifest });
const { MAINNET, TESTNET } = network;
const vaults = load("lib/vaults.ts", { "@/lib/network": network });
// A mainnet deployment of the same manifest shape, as config would add it later.
// Its own contract ids, so any testnet id on a mainnet page is a leak.
const mainnetManifest = JSON.parse(JSON.stringify(testnetManifest).replaceAll(TESTNET.vault, sdk.StrKey.encodeContract(Buffer.alloc(32, 7)))
  .replaceAll(TESTNET.usdc.contract, sdk.StrKey.encodeContract(Buffer.alloc(32, 9))).replaceAll(TESTNET.usdc.issuer, sdk.Keypair.random().publicKey()));
const mainnetDeployment = network.vaultNetwork({ ...mainnetManifest, passphrase: MAINNET.passphrase, network_epoch: "mainnet-fixture" },
  { ...MAINNET, wallets: ["Freighter", "xBull"], rpcUrl: "https://rpc.mainnet.example", explorerUrl: "https://stellar.expert/explorer/public", faucetUrl: null, indexer: "vaults/mainnet-fixture" });
const withMainnet = { ...vaults, VAULTS: vaults.VAULTS.map(v => ({ ...v, networks: { ...v.networks, mainnet: mainnetDeployment } })) };
withMainnet.findVault = (slug) => withMainnet.VAULTS.find(v => v.slug === slug);
// Testnet values that must never appear on a mainnet page.
const TESTNET_VALUES = [TESTNET.vault, TESTNET.passphrase, TESTNET.epoch, TESTNET.usdc.issuer, TESTNET.explorerUrl, TESTNET.rpcUrl, "Test SDF"];

const NetworkSwitch = (registry) => load("components/NetworkSwitch.jsx", { "@/lib/vaults": registry });
const Desk = (props) => React.createElement("vault-desk", { "data-network": props.network, "data-slug": props.slug });
function page(registry = vaults) {
  const notFound = () => { throw new Error("NEXT_NOT_FOUND"); };
  return load("app/[vault]/[network]/page.tsx", { "next/navigation": { notFound }, "@/lib/vaults": registry,
    "@/components/NetworkSwitch": NetworkSwitch(registry), "@/components/VaultDeskLoader": { __esModule: true, default: Desk } });
}
const render = async (params, registry) => renderToStaticMarkup(await page(registry).default({ params: Promise.resolve(params) }));

test("the registry lists one page per vault and network; mainnet has no deployment yet", () => {
  assert.deepEqual(page().generateStaticParams(), [{ vault: "stellar_tf_vault", network: "mainnet" }, { vault: "stellar_tf_vault", network: "testnet" }]);
  const [vault] = vaults.VAULTS;
  assert.equal(vault.networks.mainnet, null);
  assert.equal(vault.networks.testnet, TESTNET);
  assert.equal(vault.networks.testnet.passphrase, sdk.Networks.TESTNET);
  assert.equal(vaults.vaultHref(vault, "testnet"), "/stellar_tf_vault/testnet");
  assert.equal(page().dynamicParams, false);
});

test("a manifest is accepted only on its own network", () => {
  const endpoints = { ...MAINNET, rpcUrl: "https://rpc.mainnet.example", explorerUrl: "https://stellar.expert/explorer/public", faucetUrl: null, indexer: "vaults/x" };
  assert.throws(() => network.vaultNetwork(testnetManifest, endpoints), /is not Stellar mainnet/);
  assert.equal(mainnetDeployment.passphrase, sdk.Networks.PUBLIC);
});

test("an unknown vault or network is a 404", async () => {
  for (const params of [{ vault: "other_vault", network: "testnet" }, { vault: "stellar_tf_vault", network: "devnet" }, { vault: "stellar_tf_vault", network: "Testnet" }])
    await assert.rejects(render(params), /NEXT_NOT_FOUND/, JSON.stringify(params));
});

test("without a mainnet manifest the mainnet vault page cannot deposit and shows no testnet values", async () => {
  const html = await render({ vault: "stellar_tf_vault", network: "mainnet" });
  assert.ok(html.includes("Mainnet vault not deployed yet"));
  assert.ok(!html.includes("<vault-desk"));
  // Every form control is disabled; nothing can sign.
  assert.equal((html.match(/<(button|input)\b/g) || []).length, (html.match(/<(button|input)\b[^>]*disabled/g) || []).length);
  assert.ok(html.includes("Deposit unavailable") && !/Sign &amp;|Connect wallet/.test(html));
  for (const value of TESTNET_VALUES) assert.ok(!html.includes(value), value);
  assert.ok(html.includes('href="/stellar_tf_vault"')); // strategy factsheet
  assert.ok(html.includes('href="/stellar_tf_vault/mainnet" aria-current="page"') && html.includes('href="/stellar_tf_vault/testnet"'));
  assert.ok(html.includes('href="/">← Portfolio Atelier'));
});

test("a network with a deployment gets the deposit desk for that network only", async () => {
  assert.ok((await render({ vault: "stellar_tf_vault", network: "testnet" })).includes('<vault-desk data-network="testnet" data-slug="stellar_tf_vault">'));
  // Providing a mainnet deployment (config only) switches the mainnet page to the desk.
  const html = await render({ vault: "stellar_tf_vault", network: "mainnet" }, withMainnet);
  assert.ok(html.includes('<vault-desk data-network="mainnet"'));
  assert.ok(!html.includes("not deployed"));
});

function desk(registry) {
  const calls = { init: [], quant: [] };
  const runEffects = { ...React, useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}], useEffect: (fn) => { fn(); } };
  const lib = load("lib/vault.ts", { "@/lib/network": network, "@/components/stellar/walletKit": { signTx: async () => { throw new Error("not used"); } },
    "@/lib/quant": { quantRequest: async (p) => { calls.quant.push(p); return { status: "missing" }; } } });
  const { default: VaultDesk } = load("components/VaultDesk.jsx", { "@/components/SharesInWallet": load("components/SharesInWallet.jsx"), react: runEffects, "@/lib/vault": lib, "@/lib/vaults": registry,
    "@/components/NetworkSwitch": NetworkSwitch(registry),
    "@/stores/useStellarWalletStore": { __esModule: true, default: sel => sel({ address: null, connected: false }) },
    "@/components/stellar/walletKit": { initWalletKit: (config) => calls.init.push(config), connectWallet() {}, disconnectWallet() {} } },
    { window: { location: { search: "?amount=12.5" } } });
  return { calls, html: (network) => renderToStaticMarkup(React.createElement(VaultDesk, { slug: "stellar_tf_vault", network })) };
}

test("the testnet desk signs on the testnet passphrase and reads the testnet indexer", () => {
  const { calls, html } = desk(vaults);
  const out = html("testnet");
  assert.deepEqual(calls.init.map(c => c.passphrase), [sdk.Networks.TESTNET]);
  assert.ok(calls.quant.every(p => p.startsWith("vaults/flagship/")) && calls.quant.length > 0);
  assert.ok(out.includes("Stellar testnet · deployment pre-2026-12-16-reset") && out.includes("test funds only"));
  assert.ok(out.includes('href="/?network=testnet">← Portfolio Atelier'));
  assert.ok(out.includes('href="/stellar_tf_vault/testnet" aria-current="page"'));
});

test("a mainnet desk (once deployed) signs on the mainnet passphrase and shows no testnet values", () => {
  const { calls, html } = desk(withMainnet);
  const out = html("mainnet");
  assert.deepEqual(calls.init.map(c => c.passphrase), [sdk.Networks.PUBLIC]);
  assert.ok(calls.quant.length > 0 && calls.quant.every(p => p.startsWith("vaults/mainnet-fixture/")), calls.quant.join());
  for (const value of TESTNET_VALUES) assert.ok(!out.includes(value), value);
  assert.ok(!/testnet|test funds/i.test(out.replace(/href="[^"]*"|>Testnet</g, "")), "only the mode switch may name testnet");
});

test("the network switch links every mode and marks the active one", () => {
  const { default: Switch } = NetworkSwitch(vaults);
  const html = renderToStaticMarkup(React.createElement(Switch, { active: "mainnet", href: vaults.builderHref }));
  assert.equal(html, '<nav class="network-switch" aria-label="Network mode"><a href="/" aria-current="page">Mainnet</a><a href="/?network=testnet">Testnet</a></nav>');
});

test("the old /testnet URL redirects to the testnet vault page", async () => {
  const config = require(path.join(root, "next.config.js"))("phase-production-build");
  assert.deepEqual(await config.redirects(), [{ source: "/testnet", destination: "/stellar_tf_vault/testnet", permanent: false }]);
  assert.equal(fs.existsSync(path.join(root, "app/testnet")), false);
});

// D5 allocation: the testnet markets come from the hash-pinned manifest.
const execution = load("lib/execution.ts", { "@/lib/network": network, "@/lib/vaults": vaults, "@/lib/assets": load("lib/assets.ts"), "@/lib/quant": {} });

test("TESTNET.router and markets come from the manifest; mainnet has no markets", () => {
  assert.equal(TESTNET.router, testnetManifest.aggregator_config.soroswap_router);
  assert.equal(TESTNET.router, "CCJUD55AG6W5HAI5LRVNKAE5WDP5XGZBUDS5WNTIVDU7O264UZZE7BRD");
  assert.deepEqual(TESTNET.markets, { xlm: "XLM", ustry: "tRESERVE" });
  for (const symbol of Object.values(TESTNET.markets)) assert.ok(testnetManifest.assets.some(a => a.symbol === symbol), symbol);
  assert.equal(TESTNET.assets.tRESERVE.address, "CCOF6WEYQQUFIMR4SEVELW4AGZAOYMGZCYCQVXN7AFGWZXXVEDPXQ5K7");
  assert.equal("markets" in MAINNET, false);
  assert.equal("router" in MAINNET, false);
});

test("a market symbol missing from the manifest throws", () => {
  const endpoints = { label: "Stellar testnet", passphrase: sdk.Networks.TESTNET, horizonUrl: "h", wallets: [], rpcUrl: "r", explorerUrl: "e", faucetUrl: null, indexer: "i" };
  assert.throws(() => network.vaultNetwork(testnetManifest, endpoints, { aqua: "AQUA" }), /Market asset AQUA is not in the manifest/);
  assert.deepEqual(network.vaultNetwork(testnetManifest, endpoints).markets, {});
});

test("every non-native market output has a changeTrust step before its swap (the trustline guard)", () => {
  for (const [id, symbol] of Object.entries(TESTNET.markets)) {
    const asset = TESTNET.assets[symbol];
    // The manifest address is the SAC of its classic identity.
    const sac = asset.classic === "native" ? sdk.Asset.native() : new sdk.Asset(...asset.classic.split(":"));
    assert.equal(sac.contractId(TESTNET.passphrase), asset.address, symbol);
    const { legs } = execution.testnetLegs({ positions: { [id]: { allocation_fraction: .975 }, usdc: { allocation_fraction: .025 } },
      sources: [{ symbol: "USDC", percent: 100, quantity: 10000000n }], valuation: { USDC: { quantity: 10000000n, value: 10000000n, minOut: 10000000n } } }, TESTNET);
    const keys = legs.map(l => l.key);
    if (asset.classic === "native") assert.deepEqual(keys, [`swap:${symbol}`]);
    else assert.deepEqual(keys, [`trustline:${symbol}`, `swap:${symbol}`]);
  }
});

test("after a deposit the vault page shows how to add the share token to a wallet", async () => {
  const owner = sdk.Keypair.random().publicKey();
  const real = load("lib/vault.ts", { "@/lib/network": network, "@/components/stellar/walletKit": {}, "@/lib/quant": { quantRequest: async () => ({ status: "missing" }) } });
  // The client's receipts carry no kind: the desk tags each with the action it ran.
  const receipt = (action) => ({ action, hash: "a".repeat(64), ledger: 1 });
  const lib = { ...real, vaultClient: (net) => ({ ...real.vaultClient(net), readUsdcLine: async () => null, readPosition: async () => null, readIndexed: async () => ({}),
    deposit: async () => receipt("Deposit 10 USDC"), withdraw: async () => receipt("Withdraw 1 USDC"), exitAll: async () => receipt("Full exit: redeem 1 shares") }) };
  // The receipts list is the desk's only state that starts as []; effects do not run.
  const desk = (receipts, updates = []) => load("components/VaultDesk.jsx", { "@/components/SharesInWallet": load("components/SharesInWallet.jsx"), "@/lib/vault": lib, "@/lib/vaults": vaults,
    react: { ...React, useEffect() {}, useCallback: (fn) => fn, useMemo: (fn) => fn(), useRef: () => ({ current: 0 }),
      useState: (initial) => Array.isArray(initial) && !initial.length ? [receipts, (fn) => updates.push(fn)] : [typeof initial === "function" ? initial() : initial, () => {}] },
    "@/components/NetworkSwitch": NetworkSwitch(vaults),
    "@/stores/useStellarWalletStore": { __esModule: true, default: sel => sel({ address: owner, connected: true, walletKind: "Varial" }) },
    "@/components/stellar/walletKit": { initWalletKit() {}, connectWallet() {}, disconnectWallet() {} } },
    { window: { location: { search: "" } } }).default;
  // Run one action through the desk's own handler and return the receipts it leaves.
  const act = async (receipts, pick) => {
    const updates = [];
    const tree = desk(receipts, updates)({ slug: "stellar_tf_vault", network: "testnet" });
    const all = (node) => node == null || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(all) : [node, ...all(node.props?.children)];
    const target = all(tree).find(pick);
    assert.ok(target, "control found");
    await (target.props.onSubmit ?? target.props.onClick)("1");
    return updates.reduce((current, fn) => fn(current), receipts);
  };
  const html = (receipts) => renderToStaticMarkup(React.createElement(desk(receipts), { slug: "stellar_tf_vault", network: "testnet" }));
  const NOTE = "Your vault shares in your wallet";
  const afterWithdraw = await act([], (n) => n.props?.kind === "withdraw");
  const afterExit = await act([], (n) => n.type === "button" && /redeem all/.test(JSON.stringify(n.props.children)));
  for (const receipts of [[], afterWithdraw, afterExit]) assert.ok(!html(receipts).includes(NOTE), JSON.stringify(receipts));
  const afterDeposit = await act(afterWithdraw, (n) => n.props?.kind === "deposit");
  const page = html(afterDeposit);
  const note = page.indexOf(NOTE);
  assert.ok(note > page.indexOf("Deposit 10 USDC") && page.indexOf(TESTNET.vault, note) > note);
});
