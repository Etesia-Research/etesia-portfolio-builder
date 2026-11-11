const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const root = path.join(__dirname, "..");

function load(file, imports = {}, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), code)(name => imports[name] ?? require(name), module, module.exports, ...Object.values(globals));
  return module.exports;
}
const network = load("lib/network.ts", { "@/data/testnet-manifest.json": require(path.join(root, "data/testnet-manifest.json")) });
const { MAINNET, TESTNET } = network;

// A stubbed Stellar Wallets Kit: the wallet reports `wallet.passphrase`, and
// signing fails with `wallet.signError` when set. A `restored` session
// ({ id, address }) is emitted on subscribe, as the kit does from localStorage.
function harness(config = TESTNET, restored = null) {
  const wallet = { id: restored?.id ?? "varial", passphrase: TESTNET.passphrase, signError: null, address: "GTESTER" };
  const calls = { init: [], setNetwork: [], getNetwork: 0, sign: [], disconnect: 0 };
  const handlers = {};
  const listeners = {};
  const kit = {
    init: (params) => calls.init.push(params.modules.map(m => m.id)),
    setNetwork: (passphrase) => calls.setNetwork.push(passphrase),
    on: (type, fn) => {
      handlers[type] = fn;
      if (restored && type === "state") fn({ payload: { address: restored.address } });
      if (restored && type === "selected") fn({ payload: { id: restored.id } });
    },
    // The modal reports the picked wallet before returning its address.
    authModal: async () => { handlers.selected({ payload: { id: wallet.id } }); return { address: wallet.address }; },
    getNetwork: async () => {
      calls.getNetwork++;
      if (wallet.id === "xbull") throw { code: -3, message: 'xBull does not support the "getNetwork" function' };
      return { network: "wallet", networkPassphrase: wallet.passphrase };
    },
    signTransaction: async (xdr, opts) => {
      calls.sign.push({ xdr, opts });
      if (wallet.signError) throw wallet.signError;
      return { signedTxXdr: `signed:${xdr}` };
    },
    disconnect: async () => { calls.disconnect++; },
  };
  const module = (id, name) => ({ [`${name.toUpperCase()}_ID`]: id, [`${name}Module`]: class { constructor() { this.id = id; } } });
  const store = load("stores/useStellarWalletStore.ts").default;
  const walletKit = load("components/stellar/walletKit.ts", {
    "@/stores/useStellarWalletStore": store,
    "@/lib/network": network,
    "@creit-tech/stellar-wallets-kit/sdk": { StellarWalletsKit: kit },
    "@creit-tech/stellar-wallets-kit/types": { KitEventType: { STATE_UPDATED: "state", WALLET_SELECTED: "selected", DISCONNECT: "disconnect" } },
    "@creit-tech/stellar-wallets-kit/modules/varial": { VARIAL_ID: "varial", VarialModule: class { constructor() { this.id = "varial"; } } },
    "@creit-tech/stellar-wallets-kit/modules/albedo": module("albedo", "Albedo"),
    "@creit-tech/stellar-wallets-kit/modules/xbull": { XBULL_ID: "xbull", xBullModule: class { constructor() { this.id = "xbull"; } } },
    "@creit-tech/stellar-wallets-kit/modules/lobstr": module("lobstr", "Lobstr"),
    "@creit-tech/stellar-wallets-kit/modules/hotwallet": { HOTWALLET_ID: "hot", HotWalletModule: class { constructor() { this.id = "hot"; } } },
  }, { window: { addEventListener: (type, fn) => { listeners[type] = fn; } } });
  const connect = async (id = "varial") => {
    wallet.id = id;
    await walletKit.initWalletKit(config);
    return walletKit.connectWallet();
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { walletKit, wallet, calls, listeners, connect, flush, state: () => store.getState() };
}

test("testnet kit offers Varial and xBull on the manifest passphrase; mainnet keeps its wallets", async () => {
  const h = harness();
  await h.walletKit.initWalletKit(TESTNET);
  assert.deepEqual(h.calls.init, [["varial", "xbull"]]);
  assert.deepEqual(h.calls.setNetwork, ["Test SDF Network ; September 2015"]);
  const m = harness(MAINNET);
  await m.walletKit.initWalletKit();
  assert.deepEqual(m.calls.init, [["varial", "albedo", "xbull", "lobstr", "hot"]]);
  assert.deepEqual(m.calls.setNetwork, ["Public Global Stellar Network ; September 2015"]);
});

test("matching wallet network connects and signs with the passphrase and address", async () => {
  const h = harness();
  assert.equal(await h.connect(), "GTESTER");
  assert.equal(h.calls.getNetwork, 1);
  assert.equal(h.state().networkError, null);
  assert.equal(await h.walletKit.signTx("XDR"), "signed:XDR");
  assert.equal(h.calls.getNetwork, 2); // checked again before signing
  assert.deepEqual(h.calls.sign[0].opts, { networkPassphrase: TESTNET.passphrase, address: "GTESTER" });
});

test("a wallet on another network is flagged on connect and cannot sign", async () => {
  const h = harness();
  h.wallet.passphrase = MAINNET.passphrase;
  await h.connect();
  assert.match(h.state().networkError, /mismatch/);
  await assert.rejects(h.walletKit.signTx("XDR"), /mismatch/);
  assert.equal(h.calls.sign.length, 0);
});

test("window focus re-checks the network and clears the block after a switch", async () => {
  const h = harness();
  await h.connect();
  h.wallet.passphrase = MAINNET.passphrase;
  h.listeners.focus();
  await h.flush();
  assert.match(h.state().networkError, /mismatch/);
  h.wallet.passphrase = TESTNET.passphrase;
  h.listeners.focus();
  await h.flush();
  assert.equal(h.state().networkError, null);
});

test("a rejected signature maps to a friendly message", async () => {
  const h = harness();
  await h.connect();
  h.wallet.signError = { code: -4, message: "The user rejected this request." };
  await assert.rejects(h.walletKit.signTx("XDR"), /rejected in the wallet\. Nothing was submitted/);
});

test("xBull cannot report its network but still signs with the testnet passphrase", async () => {
  const h = harness();
  await h.connect("xbull");
  assert.equal(h.state().networkError, null);
  assert.equal(await h.walletKit.signTx("XDR"), "signed:XDR");
  assert.equal(h.calls.sign[0].opts.networkPassphrase, TESTNET.passphrase);
});

test("disconnect clears the wallet and any network block", async () => {
  const h = harness();
  h.wallet.passphrase = MAINNET.passphrase;
  await h.connect();
  await h.walletKit.disconnectWallet();
  const s = h.state();
  assert.deepEqual([s.address, s.connected, s.walletId, s.networkError], [null, false, null, null]);
  await assert.rejects(h.walletKit.signTx("XDR"), /Connect a wallet/);
});

test("the mainnet Builder connect path does not query the wallet network", async () => {
  const h = harness(MAINNET);
  h.wallet.passphrase = TESTNET.passphrase;
  await h.connect();
  assert.equal(h.calls.getNetwork, 0);
  assert.equal(h.state().networkError, null);
});

test("a restored session for a wallet this network does not offer is cleared on load", async () => {
  const h = harness(TESTNET, { id: "albedo", address: "GRESTORED" });
  await h.walletKit.initWalletKit(TESTNET);
  const s = h.state();
  assert.deepEqual([s.address, s.connected, s.walletId], [null, false, null]);
  assert.equal(h.calls.disconnect, 1);
  assert.equal(h.calls.getNetwork, 0);
});

test("a restored Varial session on the wrong network shows the block on load", async () => {
  const h = harness(TESTNET, { id: "varial", address: "GRESTORED" });
  h.wallet.passphrase = MAINNET.passphrase;
  await h.walletKit.initWalletKit(TESTNET);
  assert.deepEqual([h.state().address, h.state().connected], ["GRESTORED", true]);
  assert.equal(h.calls.getNetwork, 1);
  assert.match(h.state().networkError, /mismatch/);
  const m = harness(MAINNET, { id: "albedo", address: "GRESTORED" });
  await m.walletKit.initWalletKit(MAINNET);
  assert.deepEqual([m.state().connected, m.calls.disconnect, m.calls.getNetwork], [true, 0, 0]);
});
