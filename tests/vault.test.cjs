const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const sdk = require("@stellar/stellar-sdk");
const root = path.join(__dirname, "..");

function load(file, imports = {}, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), code)(name => imports[name] ?? require(name), module, module.exports, ...Object.values(globals));
  return module.exports;
}
const manifestPath = path.join(root, "data/testnet-manifest.json");
const network = load("lib/network.ts", { "@/data/testnet-manifest.json": require(manifestPath) });
const { TESTNET } = network;
const OWNER = sdk.Keypair.random().publicKey();
const i128 = (value) => sdk.nativeToScVal(BigInt(value), { type: "i128" });
const hostFailure = (type) => ({ result: { type: "txFailed", results: [{ type: "opInner", tr: { type: "invokeHostFunction", invokeHostFunctionResult: { type } } }] } });
const resourceFailure = hostFailure("invokeHostFunctionResourceLimitExceeded");
// An API-built swap's resourceFee was a few stroops below a fresh simulation's on testnet (21512 vs 21516).
const refundableFeeFailure = hostFailure("invokeHostFunctionInsufficientRefundableFee");
const trapped = { result: { type: "txFailed", results: [{ type: "opInner", tr: { type: "invokeHostFunction", invokeHostFunctionResult: { type: "invokeHostFunctionTrapped" } } }] } };
// Diagnostic event 30 of failed testnet tx 4c55ed60…37bf: contract CBE32GUT…V5TH,
// topics [error, Error(Contract, #7)], data ["failing with contract error", 7].
const FAILING_EVENT = "AAAAAAAAAAAAAAABSb0ak4H9375mppC3CxzkBOxNSqsLbs7FfMOcSQyea0oAAAACAAAAAAAAAAIAAAAPAAAABWVycm9yAAAAAAAAAgAAAAAAAAAHAAAAEAAAAAEAAAACAAAADgAAABtmYWlsaW5nIHdpdGggY29udHJhY3QgZXJyb3IAAAAAAwAAAAc=";
// The same event re-addressed to the vault with another code.
function failingEvent(contract, code) {
  const wire = sdk.xdr.DiagnosticEvent.fromXDR(FAILING_EVENT, "base64").toXdrObject();
  if (contract) wire.event.contractId = sdk.StrKey.decodeContract(contract);
  if (code) { wire.event.body.v0.topics[1].error.contractCode = code; wire.event.body.v0.data.vec[1].u32 = code; }
  return sdk.xdr.DiagnosticEvent.fromXdrObject(wire);
}

// lib/vault.ts with a scripted RPC server: `views` answers simulations by
// function name (numbers become i128), `sends` and `polls` are the sequences of
// sendTransaction and getTransaction outcomes (a function is thrown),
// `horizon` stubs Horizon.Server, and `api` is the sequence of the Builder
// Soroswap route's answers ({ status, body, headers }, or a function of the request).
function harness({ views = {}, sends = [], polls = [{ status: "SUCCESS", ledger: 77, returnValue: i128(5) }], horizon = {}, gets = [], api = [] } = {}, config = TESTNET) {
  const calls = { contract: [], signed: 0, sent: 0, prepared: 0, polled: [], hashes: [], passphrases: [], networks: [], api: [], waits: [], signedXdr: [] };
  const next = (queue, fallback) => {
    const outcome = queue.length ? queue.shift() : fallback;
    if (typeof outcome === "function") throw outcome();
    return outcome;
  };
  class Contract extends sdk.Contract {
    call(fn, ...args) {
      calls.contract.push({ fn, args: args.map(sdk.scValToNative), contract: this.contractId() });
      return super.call(fn, ...args);
    }
  }
  class Server {
    async simulateTransaction() {
      const { fn, args } = calls.contract.at(-1);
      const value = views[fn](...args);
      return { latestLedger: 70, result: { retval: typeof value === "number" ? i128(value) : value } };
    }
    async getAccount(address) { return new sdk.Account(address, "1"); }
    async prepareTransaction(tx) { calls.prepared++; return tx; }
    async sendTransaction(tx) {
      calls.sent++;
      calls.networks.push(tx.networkPassphrase);
      calls.hashes.push(Buffer.from(tx.hash()).toString("hex"));
      return { hash: calls.hashes.at(-1), ...next(sends, { status: "PENDING" }) };
    }
    async pollTransaction(hash, opts) { calls.polled.push(opts.attempts); return next(polls); }
    async getTransaction(hash) { calls.checked = [...(calls.checked ?? []), hash]; return next(gets); }
  }
  class HorizonServer {
    async loadAccount(address) { return horizon.loadAccount(address); }
    async submitTransaction(tx) { return horizon.submitTransaction(tx); }
  }
  const lib = load("lib/vault.ts", {
    "@stellar/stellar-sdk": { ...sdk, Contract, rpc: { ...sdk.rpc, Server }, Horizon: { ...sdk.Horizon, Server: HorizonServer } },
    "@/lib/network": network,
    "@/components/stellar/walletKit": { signTx: async (xdr, passphrase) => { calls.signed++; calls.passphrases.push(passphrase); calls.signedXdr.push(xdr); return xdr; } },
    "@/lib/quant": { quantRequest: async () => { throw new Error("not used"); } },
  }, {
    fetch: async (url, options) => {
      const request = { url, body: JSON.parse(options.body) };
      calls.api.push(request);
      let reply = api.shift();
      if (typeof reply === "function") reply = reply(request);
      if (!reply) throw new Error(`unexpected Soroswap call ${url}`);
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 201, headers: reply.headers });
    },
    setTimeout: (fn, ms) => { calls.waits.push(ms); fn(); },
  });
  const vault = { ...lib, ...lib.vaultClient(config) };
  return { vault, calls, flows: () => calls.contract.filter(c => c.fn.endsWith("_bounded")) };
}

test("network config comes from the copied pre-reset manifest", () => {
  const bytes = fs.readFileSync(manifestPath);
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), "cfa30d48adb6c5559dfbed446a4a0763c67ed0672305b18910e493b1920c2220");
  for (const source of [path.join(root, "../etesia-vault"), path.join(root, "../../etesia-vault")].map(dir => path.join(dir, "deploy/testnet/pre-2026-12-16-reset.json"))) {
    if (fs.existsSync(source)) assert.deepEqual(bytes, fs.readFileSync(source));
  }
  assert.equal(TESTNET.passphrase, sdk.Networks.TESTNET);
  assert.equal(TESTNET.vault, "CD73M44EYNZOX7YWPSBMITVPERWNA6ZHDLAZ2XSM4RQM6V4XT7GYXFQH");
  assert.deepEqual(TESTNET.usdc, { contract: "CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU", code: "USDC", issuer: "GATALTGTWIOT6BUDBCZM3Q4OQ4BO2COLOAZ7IYSKPLC2PMSOPPGF5V56", decimals: 7 });
  assert.deepEqual(Object.keys(TESTNET.assets).sort(), JSON.parse(bytes).assets.map(a => a.symbol).sort());
});

test("amounts convert without floating point and bounds round against the user", () => {
  const { vault } = harness();
  assert.equal(vault.toUnits("10.5", 7), BigInt(105000000));
  assert.equal(vault.toUnits(".0000001", 7), BigInt(1));
  assert.throws(() => vault.toUnits("1.00000001", 7), /decimal places/);
  assert.throws(() => vault.toUnits("1e3", 7), /valid amount/);
  assert.equal(vault.fromUnits(BigInt(105000000), 7), "10.5");
  assert.equal(vault.fromUnits(BigInt(1), 12), "0.000000000001");
  assert.equal(vault.minBound(BigInt(10001)), BigInt(9950)); // floor of 9950.995
  assert.equal(vault.maxBound(BigInt(10001)), BigInt(10052)); // ceil of 10051.005
});

test("deposit bounds min_shares by the preview and signs a deposit_bounded call", async () => {
  const h = harness({ views: { preview_deposit: () => 1000000 } });
  const before = Math.floor(Date.now() / 1000);
  const receipt = await h.vault.deposit(OWNER, "10");
  const [call] = h.flows();
  assert.equal(call.fn, "deposit_bounded");
  assert.deepEqual(call.args.slice(0, 5), [BigInt(100000000), OWNER, OWNER, OWNER, BigInt(995000)]);
  assert.ok(call.args[5] >= BigInt(before + 300) && call.args[5] <= BigInt(before + 301));
  assert.equal(h.calls.signed, 1);
  assert.deepEqual(h.calls.polled, [330]);
  assert.deepEqual(receipt, { action: "Deposit 10 USDC", hash: h.calls.hashes[0], ledger: 77, returned: "0.000000000005 shares" });
});

test("partial withdraw caps max_shares and full exit redeems the whole balance", async () => {
  const h = harness({
    views: { preview_withdraw: () => 2000, balance: () => 123456, preview_redeem: () => 40000 },
    polls: [{ status: "SUCCESS", ledger: 1, returnValue: i128(1) }, { status: "SUCCESS", ledger: 2, returnValue: i128(40000) }],
  });
  await h.vault.withdraw(OWNER, "0.5");
  const exit = await h.vault.exitAll(OWNER);
  const [withdraw, redeem] = h.flows();
  assert.equal(withdraw.fn, "withdraw_bounded");
  assert.deepEqual(withdraw.args.slice(0, 5), [BigInt(5000000), OWNER, OWNER, OWNER, BigInt(2010)]);
  assert.equal(redeem.fn, "redeem_bounded");
  assert.deepEqual(redeem.args.slice(0, 5), [BigInt(123456), OWNER, OWNER, OWNER, BigInt(39800)]);
  assert.equal(exit.returned, "0.004 USDC");
});

test("polling outlasts the transaction's time bound before reporting an unknown outcome", async () => {
  const h = harness({ views: { preview_deposit: () => 1 }, polls: [{ status: "NOT_FOUND" }] });
  await assert.rejects(h.vault.deposit(OWNER, "1"), (err) => err.message.includes(`${h.calls.hashes[0]} was not found within 330 seconds, past its time bound. Its outcome is unknown`));
  assert.ok(h.vault.POLL_ATTEMPTS > h.vault.DEADLINE_SECONDS);
});

test("a send or poll that throws after signing reports the hash as an unknown outcome", async () => {
  const h = harness({ views: { preview_deposit: () => 1 }, polls: [() => new Error("Request failed with status code 503")] });
  await assert.rejects(h.vault.deposit(OWNER, "1"), (err) => err.message.startsWith(`Transaction ${h.calls.hashes[0]} was submitted but its status could not be read (Request failed with status code 503). Its outcome is unknown`));
  const s = harness({ views: { preview_deposit: () => 1 }, sends: [() => new Error("socket hang up")] });
  await assert.rejects(s.vault.deposit(OWNER, "1"), (err) => err.message.includes(`${s.calls.hashes[0]} could not be confirmed as submitted (socket hang up)`));
  assert.deepEqual(s.calls.polled, []);
});

test("send-time errors: an invalid Soroban tx is re-signed once, other rejections are not polled", async () => {
  const r = harness({ views: { preview_deposit: () => 1 }, sends: [{ status: "ERROR", errorResult: { result: { type: "txSorobanInvalid" } } }] });
  assert.equal((await r.vault.deposit(OWNER, "1")).hash, r.calls.hashes[1]);
  assert.deepEqual([r.calls.signed, r.calls.sent, r.calls.polled.length], [2, 2, 1]);
  const b = harness({ views: { preview_deposit: () => 1 }, sends: [{ status: "ERROR", errorResult: { result: { type: "txBadSeq" } } }] });
  await assert.rejects(b.vault.deposit(OWNER, "1"), /rejected before inclusion \(txBadSeq\)/);
  assert.deepEqual([b.calls.signed, b.calls.polled.length], [1, 0]);
  const l = harness({ views: { preview_deposit: () => 1 }, sends: [{ status: "ERROR", errorResult: { result: { type: "txTooLate" } } }] });
  await assert.rejects(l.vault.deposit(OWNER, "1"), /signature took longer than the transaction's 300-second window/);
  const t = harness({ views: { preview_deposit: () => 1 }, sends: [{ status: "TRY_AGAIN_LATER" }] });
  await assert.rejects(t.vault.deposit(OWNER, "1"), /did not queue the transaction/);
  assert.deepEqual(t.calls.polled, []);
});

test("an onchain failure maps the vault's own error code, not an inner contract's", async () => {
  const h = harness({ views: { preview_deposit: () => 1 }, polls: [{ status: "FAILED", resultXdr: trapped, diagnosticEventsXdr: [failingEvent(TESTNET.vault, 14)] }] });
  await assert.rejects(h.vault.deposit(OWNER, "1"), (err) => /0\.5% bound.*\(vault error 14\) Transaction [0-9a-f]{64} failed onchain/.test(h.vault.vaultError(err)));
  const inner = harness({ views: { preview_deposit: () => 1 }, polls: [{ status: "FAILED", resultXdr: trapped, diagnosticEventsXdr: [failingEvent(null, null)] }] });
  await assert.rejects(inner.vault.deposit(OWNER, "1"), /failed onchain \(txFailed\)/);
  assert.equal(h.vault.onchainVaultCode([failingEvent(null, null)]), undefined);
  assert.equal(h.vault.onchainVaultCode([failingEvent(TESTNET.vault, 5)]), 5);
});

test("position reads shares from balance and their value from convert_to_assets", async () => {
  const state = sdk.nativeToScVal({ paused: true });
  const h = harness({ views: { balance: () => 2000000000000, max_withdraw: () => 30, liquid_assets: () => 40, state: () => state, convert_to_assets: (shares) => Number(shares / BigInt(1000)) } });
  const position = await h.vault.readPosition(OWNER);
  assert.deepEqual(position, { ledger: 70, shares: BigInt(2000000000000), value: BigInt(2000000000), maxWithdraw: BigInt(30), liquid: BigInt(40), paused: true });
  const convert = h.calls.contract.find(c => c.fn === "convert_to_assets");
  assert.deepEqual(convert.args, [BigInt(2000000000000)]);
  const empty = harness({ views: { balance: () => 0, max_withdraw: () => 0, liquid_assets: () => 40, state: () => state, convert_to_assets: () => { throw new Error("not called"); } } });
  assert.equal((await empty.vault.readPosition(OWNER)).value, BigInt(0));
});

test("USDC line: an unknown account is unfunded; a funded one reports its trustline", async () => {
  const missing = harness({ horizon: { loadAccount: async () => { throw new sdk.NotFoundError("Not Found", { status: 404 }); } } });
  assert.deepEqual(await missing.vault.readUsdcLine(OWNER), { funded: false, trustline: false, balance: null, xlm: null, subentries: 0, lines: {} });
  const [reserveCode, reserveIssuer] = TESTNET.assets.tRESERVE.classic.split(":");
  const balances = [{ asset_type: "native", balance: "10.0000000" }, { asset_code: "USDC", asset_issuer: TESTNET.usdc.issuer, balance: "5.0000000" },
    { asset_code: reserveCode, asset_issuer: reserveIssuer, balance: "1.0000000" }, { asset_code: reserveCode, asset_issuer: sdk.Keypair.random().publicKey(), balance: "9.0000000" }];
  const funded = harness({ horizon: { loadAccount: async () => ({ balances, subentry_count: 3 }) } });
  assert.deepEqual(await funded.vault.readUsdcLine(OWNER), { funded: true, trustline: true, balance: "5.0000000", xlm: "10.0000000", subentries: 3, lines: { USDC: "5.0000000", tRESERVE: "1.0000000" } });
  const down = harness({ horizon: { loadAccount: async () => { throw new Error("Network Error"); } } });
  await assert.rejects(down.vault.readUsdcLine(OWNER), /Network Error/);
});

test("trustline submission maps Horizon result codes and treats a timeout as unknown", async () => {
  const failed = (status, extras) => async () => { throw Object.assign(new Error(`Transaction submission failed. Server responded: ${status}`), { response: { status, data: { extras } } }); };
  const loadAccount = async (address) => new sdk.Account(address, "1");
  const low = harness({ horizon: { loadAccount, submitTransaction: failed(400, { result_codes: { transaction: "tx_failed", operations: ["op_low_reserve"] } }) } });
  await assert.rejects(low.vault.addUsdcTrustline(OWNER), /more Stellar testnet XLM/);
  const seq = harness({ horizon: { loadAccount, submitTransaction: failed(400, { result_codes: { transaction: "tx_bad_seq" } }) } });
  await assert.rejects(seq.vault.addUsdcTrustline(OWNER), /[0-9a-f]{64} was rejected \(tx_bad_seq\)/);
  const timeout = harness({ horizon: { loadAccount, submitTransaction: failed(504) } });
  await assert.rejects(timeout.vault.addUsdcTrustline(OWNER), /[0-9a-f]{64} could not be confirmed \(Transaction submission failed\. Server responded: 504\)\. Its outcome is unknown/);
  const ok = harness({ horizon: { loadAccount, submitTransaction: async (tx) => ({ hash: Buffer.from(tx.hash()).toString("hex"), ledger: 12 }) } });
  const receipt = await ok.vault.addUsdcTrustline(OWNER);
  assert.equal(receipt.ledger, 12);
  assert.equal(ok.calls.signed, 1);
});

test("a resource failure is re-simulated and re-signed once; other failures are reported", async () => {
  const h = harness({ views: { preview_deposit: () => 1 }, polls: [{ status: "FAILED", resultXdr: resourceFailure }, { status: "SUCCESS", ledger: 9, returnValue: i128(1) }] });
  assert.equal((await h.vault.deposit(OWNER, "1")).hash, h.calls.hashes[1]);
  assert.equal(h.calls.signed, 2);
  const g = harness({ views: { preview_deposit: () => 1 }, polls: [{ status: "FAILED", resultXdr: resourceFailure }, { status: "FAILED", resultXdr: resourceFailure }] });
  await assert.rejects(g.vault.deposit(OWNER, "1"), (err) => err.message === `Transaction ${g.calls.hashes[1]} failed onchain (txFailed).`);
  assert.equal(g.calls.signed, 2);
  const f = harness({ views: { preview_deposit: () => 1 }, polls: [{ status: "FAILED", resultXdr: trapped }] });
  await assert.rejects(f.vault.deposit(OWNER, "1"), /failed onchain/);
  assert.equal(f.calls.signed, 1);
});

test("errors map to vault codes only when the vault itself failed", () => {
  const { vault } = harness();
  const vaultFailure = (code) => new Error(`HostError: Error(Contract, #${code})\n\nEvent log (newest first):\n   0: [Diagnostic Event] contract:${TESTNET.vault}, topics:[error, Error(Contract, #${code})], data:["failing with contract error", ${code}]`);
  assert.match(vault.vaultError(vaultFailure(9)), /enough liquid USDC.*\(vault error 9\)/);
  assert.match(vault.vaultError(vaultFailure(6)), /paused/);
  assert.match(vault.vaultError(vaultFailure(14)), /0\.5% bound/);
  // Simulated against testnet: a deposit without the USDC line fails in the SAC with #13.
  assert.equal(vault.vaultError(new Error('HostError: Error(Contract, #13)\n 2: [Failed Diagnostic Event (not emitted)] contract:CAQC, topics:[error, Error(Contract, #13)], data:["trustline entry is missing for account", GABC]')), "Add the USDC trustline before depositing.");
  // Simulated against testnet: a deposit above the USDC balance fails in the SAC with #10, not vault error 10.
  assert.match(vault.vaultError(new Error('HostError: Error(Contract, #10)\n 2: [Failed Diagnostic Event (not emitted)] contract:CAQC, topics:[error, Error(Contract, #10)], data:["resulting balance is not within the allowed range", 0, -10000000, 9223372036854775807]')), /not enough USDC for this deposit, or the trustline limit reached for this withdrawal/);
  // An inner contract's failure, re-reported by the vault as "contract call failed", is not a vault code.
  const inner = `HostError: Error(Contract, #7)\n   0: [Diagnostic Event] contract:${TESTNET.vault}, topics:[error, Error(Contract, #7)], data:["contract call failed", lastprice, []]\n   1: [Failed Diagnostic Event (not emitted)] contract:CBE32GUTQH657PTGU2ILOCY44QCOYTKKVMFW5TWFPTBZYSIMTZVUV5TH, topics:[error, Error(Contract, #7)], data:["failing with contract error", 7]`;
  assert.equal(vault.vaultError(new Error(inner)), "HostError: Error(Contract, #7)");
  assert.equal(vault.vaultError(new Error("HostError: Error(Contract, #10)\n\nEvent log")), "HostError: Error(Contract, #10)");
  assert.equal(vault.vaultError(new Error("Signature request was rejected in the wallet. Nothing was submitted.")), "Signature request was rejected in the wallet. Nothing was submitted.");
  for (const code of Array.from({ length: 20 }, (_, i) => i + 1)) assert.ok(vault.VAULT_ERRORS[code]);
});

test("a vault client builds and signs only on its own deployment's network", async () => {
  const t = harness({ views: { preview_deposit: () => 1 } });
  await t.vault.deposit(OWNER, "1");
  assert.deepEqual(t.calls.passphrases, [TESTNET.passphrase]);
  // A mainnet deployment of the same shape: its transactions carry the mainnet passphrase only.
  const manifest = { ...JSON.parse(fs.readFileSync(manifestPath, "utf8")), passphrase: network.MAINNET.passphrase };
  const mainnet = network.vaultNetwork(manifest, { ...network.MAINNET, rpcUrl: "https://rpc.mainnet.example", explorerUrl: "https://stellar.expert/explorer/public", faucetUrl: null, indexer: "vaults/flagship" });
  const m = harness({ views: { preview_deposit: () => 1 } }, mainnet);
  await m.vault.deposit(OWNER, "1");
  assert.deepEqual(m.calls.passphrases, [sdk.Networks.PUBLIC]);
  assert.deepEqual(m.calls.networks, [sdk.Networks.PUBLIC]);
  assert.deepEqual(t.calls.networks, [sdk.Networks.TESTNET]);
});

// D5 allocation: testnet swaps quoted and built by the Soroswap Aggregator API
// (through the Builder's /api/soroswap route), signed and submitted through RPC.
const [USDC, XLM, RESERVE] = [TESTNET.usdc.contract, TESTNET.assets.XLM.address, TESTNET.assets.tRESERVE.address];
const amounts = (...values) => sdk.nativeToScVal(values.map(i128));
// The router's own failure as observed in a testnet simulation (min out above the quote, 2026-11-11).
const routerFailure = (code) => `HostError: Error(Contract, #${code})\n   0: [Diagnostic Event] contract:${TESTNET.router}, topics:[error, Error(Contract, #${code})], data:"escalating Ok(ScErrorType::Contract) frame-exit to Err"`;
function escalatedEvent(contract, code) {
  const wire = sdk.xdr.DiagnosticEvent.fromXDR(FAILING_EVENT, "base64").toXdrObject();
  wire.event.contractId = sdk.StrKey.decodeContract(contract);
  wire.event.body.v0.topics[1].error.contractCode = code;
  wire.event.body.v0.data = sdk.xdr.ScVal.scvString("escalating Ok(ScErrorType::Contract) frame-exit to Err").toXdrObject();
  return sdk.xdr.DiagnosticEvent.fromXdrObject(wire);
}
// A /quote answer in the shape observed on testnet on 2026-11-11 (10 USDC → XLM, platform router).
const quoteOf = (assetIn, assetOut, amountIn, amountOut, min = amountOut * 9950n / 10000n) => ({ status: 201, body: {
  assetIn, assetOut, tradeType: "EXACT_IN", amountIn: String(amountIn), amountOut: String(amountOut), otherAmountThreshold: String(min),
  priceImpactPct: "0.00", platform: "router", routePlan: [{ swapInfo: { protocol: "soroswap", path: [assetIn, assetOut] }, percent: "100.00" }],
  rawTrade: { amountIn: String(amountIn), amountOutMin: String(min), distribution: [{ protocol_id: "soroswap", path: [assetIn, assetOut], parts: 10, is_exact_in: true }] } } });
// A /quote/build answer as decoded on testnet: the owner's router swap_exact_tokens_for_tokens, 180-second time bound.
function builtOf({ amountIn, minOut, path, to = OWNER, source = OWNER, contract = TESTNET.router, fn = "swap_exact_tokens_for_tokens", fee = "90268", timeout = 180, extra = [] }) {
  const builder = new sdk.TransactionBuilder(new sdk.Account(source, "1"), { fee, networkPassphrase: TESTNET.passphrase })
    .addOperation(new sdk.Contract(contract).call(fn, i128(amountIn), i128(minOut), sdk.nativeToScVal(path.map(c => sdk.Address.fromString(c))),
      sdk.Address.fromString(to).toScVal(), sdk.nativeToScVal(BigInt(Math.floor(Date.now() / 1000) + 3600), { type: "u64" }), ...extra));
  const tx = (Array.isArray(timeout) ? builder.setTimebounds(...timeout) : builder.setTimeout(timeout)).build();
  return { status: 201, body: { xdr: tx.toXDR(), action: "SIGN_TRANSACTION" } };
}
const swapApi = (amountIn, amountOut, path = [USDC, XLM], build = {}) => {
  const quote = quoteOf(path[0], path.at(-1), amountIn, amountOut);
  return [quote, builtOf({ amountIn, minOut: BigInt(quote.body.otherAmountThreshold), path, ...build })];
};

test("quoteSwap asks the Builder route for an exact-in testnet quote and returns its expected and minimum output", async () => {
  const h = harness({ api: [quoteOf(USDC, XLM, 100000000n, 654087498n, 650817060n)] });
  const quote = await h.vault.quoteSwap(BigInt(100000000), [USDC, XLM]);
  assert.deepEqual([quote.amountOut, quote.minOut], [BigInt(654087498), BigInt(650817060)]);
  assert.deepEqual(h.calls.api, [{ url: "/api/soroswap/quote", body: { network: "testnet", assetIn: USDC, assetOut: XLM, amount: "100000000" } }]);
  assert.equal(h.calls.signed, 0);
  // A quote for another trade, or with a zero minimum, is not a quote for this swap.
  for (const reply of [quoteOf(USDC, RESERVE, 100000000n, 5n), quoteOf(USDC, XLM, 99999999n, 5n), quoteOf(USDC, XLM, 100000000n, 5n, 0n)])
    await assert.rejects(harness({ api: [reply] }).vault.quoteSwap(BigInt(100000000), [USDC, XLM]), /No Soroswap testnet quote for USDC → XLM: the quote does not match/);
  await assert.rejects(harness({ api: [{ status: 400, body: { message: "No path found" } }] }).vault.quoteSwap(BigInt(1), [USDC, XLM]),
    /No Soroswap testnet quote for USDC → XLM: Soroswap API 400: No path found/);
});

test("swapExactIn quotes, builds with the quote unchanged and from = owner, then signs the built XDR as is and submits it through RPC", async () => {
  const api = swapApi(100000000n, 654087498n);
  const h = harness({ api: [...api], polls: [{ status: "SUCCESS", ledger: 81, returnValue: amounts(100000000, 654087498) }] });
  const signed = [];
  const receipt = await h.vault.swapExactIn(OWNER, BigInt(100000000), [USDC, XLM], (s) => signed.push(s));
  assert.deepEqual(h.calls.api.map(c => c.url), ["/api/soroswap/quote", "/api/soroswap/build"]);
  assert.deepEqual(h.calls.api[1].body, { network: "testnet", quote: api[0].body, from: OWNER });
  // Never re-simulated: the API already sized the transaction.
  assert.equal(h.calls.prepared, 0);
  assert.deepEqual(h.calls.signedXdr, [api[1].body.xdr]);
  assert.deepEqual(h.calls.passphrases, [TESTNET.passphrase]);
  assert.deepEqual(signed.map(s => s.hash), h.calls.hashes);
  const built = sdk.TransactionBuilder.fromXDR(api[1].body.xdr, TESTNET.passphrase);
  assert.equal(signed[0].maxTime, Number(built.timeBounds.maxTime));
  assert.deepEqual(h.calls.polled, [330]);
  // The receipt is the confirmed transaction's own return: the router's last amount, in the output asset.
  assert.deepEqual(receipt, { action: "Swap 10 USDC → XLM", hash: h.calls.hashes[0], ledger: 81, returned: "65.4087498 XLM" });
});

test("a built transaction that is not the quoted swap on the manifest router is never signed", async () => {
  const other = sdk.Keypair.random().publicKey();
  const now = Math.floor(Date.now() / 1000);
  // Also refused: no time bound (it would stay pending forever), one past or beyond the
  // API's 180 s (plus 30 s slack), an extra argument, and a fee above the 1 XLM kept back per transaction.
  for (const build of [{ to: other }, { source: other }, { contract: TESTNET.vault }, { fn: "swap_tokens_for_exact_tokens" }, { minOut: 1n }, { amountIn: 1n }, { path: [USDC, RESERVE] },
    { timeout: 0 }, { timeout: 600 }, { timeout: [0, now - 1] }, { extra: [i128(1)] }, { fee: "10000001" }]) {
    const [quote] = swapApi(100000000n, 654087498n);
    const h = harness({ api: [quote, builtOf({ amountIn: 100000000n, minOut: BigInt(quote.body.otherAmountThreshold), path: [USDC, XLM], ...build })] });
    await assert.rejects(h.vault.swapExactIn(OWNER, BigInt(100000000), [USDC, XLM]), /not the quoted swap on the manifest router\. Nothing was signed/, JSON.stringify(build, (k, v) => typeof v === "bigint" ? String(v) : v));
    assert.equal(h.calls.signed, 0);
  }
  // At the limits: the full 210 s window and a 1 XLM fee are signed.
  for (const build of [{ timeout: 210 }, { fee: "10000000" }]) {
    const [quote] = swapApi(100000000n, 654087498n);
    const h = harness({ api: [quote, builtOf({ amountIn: 100000000n, minOut: BigInt(quote.body.otherAmountThreshold), path: [USDC, XLM], ...build })], polls: [{ status: "SUCCESS", ledger: 81, returnValue: amounts(100000000, 654087498) }] });
    await h.vault.swapExactIn(OWNER, BigInt(100000000), [USDC, XLM]);
    assert.equal(h.calls.signed, 1);
  }
});

test("a 428 CREATE_TRUSTLINE from the build names the manifest asset and signs nothing", async () => {
  const [quote] = swapApi(100000000n, 97749663n, [USDC, RESERVE]);
  const [code, issuer] = TESTNET.assets.tRESERVE.classic.split(":");
  // Observed on testnet for an account without the tRESERVE line (2026-11-11).
  const missing = { status: 428, body: { message: `Missing trustline in ${OWNER} for asset: tRESERVE`, action: "CREATE_TRUSTLINE", errorCode: 13,
    actionData: { xdr: "AAAA", signer: OWNER, assetCode: code, assetIssuer: issuer, description: "Create a trustline" } } };
  const h = harness({ api: [quote, missing] });
  await assert.rejects(h.vault.swapExactIn(OWNER, BigInt(100000000), [USDC, RESERVE]),
    (err) => err.message === "Add the tRESERVE trustline before this swap (Soroswap API 428 CREATE_TRUSTLINE)." && !err.unquoted);
  assert.equal(h.calls.signed, 0);
});

test("a 429 waits Retry-After before asking again, and gives up after the retries", async () => {
  const limited = { status: 429, body: { message: "Rate limit exceeded", retryAfter: 1 }, headers: { "Retry-After": "2" } };
  const h = harness({ api: [limited, quoteOf(USDC, XLM, 10n, 20n)] });
  assert.equal((await h.vault.quoteSwap(BigInt(10), [USDC, XLM])).amountOut, BigInt(20));
  assert.deepEqual(h.calls.waits, [2000]);
  const g = harness({ api: Array(h.vault.SOROSWAP_RETRIES + 1).fill(limited) });
  await assert.rejects(g.vault.quoteSwap(BigInt(10), [USDC, XLM]), /rate limit was reached\. Try again in 2 seconds/);
  assert.deepEqual(g.calls.waits, Array(h.vault.SOROSWAP_RETRIES).fill(2000));
});

test("only a No path found quote is marked unquoted; a minimum below the funding floor is refused before the build", async () => {
  const none = harness({ api: [{ status: 400, body: { message: "No path found" } }] });
  await assert.rejects(none.vault.swapExactIn(OWNER, BigInt(10), [USDC, XLM]), (err) => err.unquoted === true && /No Soroswap testnet quote/.test(err.message));
  // A rate limit, an outage or a missing key is not a missing route: the run stops instead.
  const limited = { status: 429, body: { message: "Rate limit exceeded" }, headers: { "Retry-After": "1" } };
  for (const api of [Array(4).fill(limited), [{ status: 503, body: { error: "Soroswap API is not configured" } }], [{ status: 504, body: { error: "Soroswap request timed out" } }],
    [{ status: 400, body: { error: "Unsupported network" } }]]) {
    const h = harness({ api });
    await assert.rejects(h.vault.swapExactIn(OWNER, BigInt(10), [USDC, XLM]), (err) => err.unquoted === false && err.noPath === false && /No Soroswap testnet quote/.test(err.message));
  }
  const low = harness({ api: [quoteOf(XLM, USDC, 500000000n, 75842198n, 75462987n)] });
  await assert.rejects(low.vault.swapExactIn(OWNER, BigInt(500000000), [XLM, USDC], undefined, BigInt(75462988)),
    (err) => err.message === "The XLM → USDC quote's minimum (7.5462987 USDC) is now below the 7.5462988 USDC the allocation was budgeted from. Rebuild the allocation." && !err.unquoted);
  assert.deepEqual([low.calls.api.length, low.calls.signed], [1, 0]);
});

test("a router failure is reported with the router's code, not as a vault error", async () => {
  const { vault } = harness();
  assert.equal(vault.vaultError(new Error(routerFailure(507))), `The pool price moved beyond the 0.5% minimum between the quote and execution. Quote again and retry. (router ${TESTNET.router} error 507)`);
  assert.match(vault.vaultError(new Error(routerFailure(503))), /deadline passed.*error 503\)/);
  // A vault error code number from the router is still the router's.
  assert.doesNotMatch(vault.vaultError(new Error(routerFailure(14))), /vault error/);
  const h = harness({ api: swapApi(10n, 20n), polls: [{ status: "FAILED", resultXdr: trapped, diagnosticEventsXdr: [escalatedEvent(TESTNET.router, 507)] }] });
  await assert.rejects(h.vault.swapExactIn(OWNER, BigInt(10), [USDC, XLM]),
    (err) => err.message === `${h.vault.ROUTER_ERRORS[507]} (router ${TESTNET.router} error 507) Transaction ${h.calls.hashes[0]} failed onchain; only the fee was charged.`);
  // Observed in a testnet simulation: a swap to tRESERVE without its trustline names tRESERVE, not USDC.
  assert.equal(vault.vaultError(new Error(`HostError: Error(Contract, #13)\n 5: [Failed Diagnostic Event (not emitted)] contract:${RESERVE}, topics:[error, Error(Contract, #13)], data:["trustline entry is missing for account", ${OWNER}]`)), "Add the tRESERVE trustline before this swap.");
});

test("an unknown outcome after signing carries the signed hash and time bound", async () => {
  const h = harness({ api: swapApi(10n, 20n), polls: [() => new Error("Request failed with status code 503")] });
  const signed = [];
  await assert.rejects(h.vault.swapExactIn(OWNER, BigInt(10), [USDC, XLM], (s) => signed.push(s)), (err) => {
    assert.deepEqual(err.unknown, signed[0]);
    assert.equal(err.unknown.hash, h.calls.hashes[0]);
    return /Its outcome is unknown/.test(err.message);
  });
  const t = harness({ horizon: { loadAccount: async (a) => new sdk.Account(a, "1"), submitTransaction: async () => { throw Object.assign(new Error("Server responded: 504"), { response: { status: 504, data: {} } }); } } });
  const trust = [];
  await assert.rejects(t.vault.addUsdcTrustline(OWNER, "tRESERVE", (s) => trust.push(s)), (err) => err.unknown?.hash === trust[0].hash);
  // A swap signed past its 180-second bound is reported with that window.
  const late = harness({ api: swapApi(10n, 20n), sends: [{ status: "ERROR", errorResult: { result: { type: "txTooLate" } } }] });
  await assert.rejects(late.vault.swapExactIn(OWNER, BigInt(10), [USDC, XLM]), /signature took longer than the transaction's 180-second window/);
});

test("addUsdcTrustline adds a changeTrust for the asked manifest asset", async () => {
  const submitted = [];
  const h = harness({ horizon: { loadAccount: async (a) => new sdk.Account(a, "1"), submitTransaction: async (tx) => { submitted.push(tx); return { hash: Buffer.from(tx.hash()).toString("hex"), ledger: 5 }; } } });
  const receipt = await h.vault.addUsdcTrustline(OWNER, "tRESERVE");
  const [op] = submitted[0].operations;
  assert.equal(op.type, "changeTrust");
  assert.equal(`${op.line.code}:${op.line.issuer}`, TESTNET.assets.tRESERVE.classic);
  assert.equal(receipt.action, "Add tRESERVE trustline");
  await assert.rejects(h.vault.addUsdcTrustline(OWNER, "XLM"), /not a classic asset/);
});

test("checkTransaction confirms SUCCESS and FAILED, and treats NOT_FOUND as expired only past the time bound within retained history", async () => {
  const signed = { hash: "ab".repeat(32), maxTime: 1000 };
  const returns = { decimals: 7, unit: "XLM" };
  const missing = (latest, oldest) => ({ status: "NOT_FOUND", latestLedgerCloseTime: latest, oldestLedgerCloseTime: oldest });
  const h = harness({ gets: [{ status: "SUCCESS", ledger: 9, returnValue: amounts(1, 20000000) }, { status: "FAILED" }, missing(1001, 100), missing(999, 100), missing(1001, 800)] });
  assert.deepEqual(await h.vault.checkTransaction(signed, "Swap", returns), { status: "SUCCESS", receipt: { action: "Swap", hash: signed.hash, ledger: 9, returned: "2 XLM" } });
  assert.deepEqual(await h.vault.checkTransaction(signed, "Swap", returns), { status: "FAILED" });
  assert.deepEqual(await h.vault.checkTransaction(signed, "Swap", returns), { status: "EXPIRED" });
  // Still inside its time bound by the network's clock.
  assert.deepEqual(await h.vault.checkTransaction(signed, "Swap", returns), { status: "PENDING" });
  // Past its time bound, but the RPC's history no longer reaches back to when it was signed:
  // it can no longer be included, and whether it was is unknown.
  assert.deepEqual(await h.vault.checkTransaction(signed, "Swap", returns), { status: "OUTSIDE_HISTORY" });
});


test("a resource failure quotes and builds the swap again once, and signs the new build", async () => {
  const first = swapApi(10n, 20n), second = swapApi(10n, 21n);
  const h = harness({ api: [...first, ...second], polls: [{ status: "FAILED", resultXdr: resourceFailure }, { status: "SUCCESS", ledger: 9, returnValue: amounts(10, 21) }] });
  const receipt = await h.vault.swapExactIn(OWNER, BigInt(10), [USDC, XLM]);
  assert.deepEqual(h.calls.api.map(c => c.url), ["/api/soroswap/quote", "/api/soroswap/build", "/api/soroswap/quote", "/api/soroswap/build"]);
  assert.deepEqual(h.calls.signedXdr, [first[1].body.xdr, second[1].body.xdr]);
  assert.equal(receipt.hash, h.calls.hashes[1]);
  const g = harness({ api: [...swapApi(10n, 20n), ...swapApi(10n, 20n)], polls: [{ status: "FAILED", resultXdr: resourceFailure }, { status: "FAILED", resultXdr: resourceFailure }] });
  await assert.rejects(g.vault.swapExactIn(OWNER, BigInt(10), [USDC, XLM]), (err) => err.message === `Transaction ${g.calls.hashes[1]} failed onchain (txFailed).`);
  assert.equal(g.calls.signed, 2);
  // An insufficient refundable fee (the API's resourceFee below a fresh simulation's) is rebuilt the same way.
  const f = harness({ api: [...swapApi(10n, 20n), ...swapApi(10n, 21n)], polls: [{ status: "FAILED", resultXdr: refundableFeeFailure }, { status: "SUCCESS", ledger: 9, returnValue: amounts(10, 21) }] });
  assert.equal((await f.vault.swapExactIn(OWNER, BigInt(10), [USDC, XLM])).hash, f.calls.hashes[1]);
  assert.deepEqual([f.calls.signed, f.calls.api.length], [2, 4]);
  assert.equal(f.vault.needsResimulation(refundableFeeFailure), true);
  assert.equal(f.vault.needsResimulation(trapped), false);
});

test("a re-simulated vault call rebuilds the arguments with a fresh deadline and keeps the signed-off minimum", async () => {
  const h = harness({ views: { preview_deposit: () => 1000000 }, polls: [{ status: "FAILED", resultXdr: resourceFailure }, { status: "SUCCESS", ledger: 9, returnValue: i128(1) }] });
  const now = Date.now;
  let clock = now();
  Date.now = () => (clock += 60000);
  try {
    await h.vault.deposit(OWNER, "10");
  } finally {
    Date.now = now;
  }
  const deposits = h.flows();
  assert.equal(deposits.length, 2);
  assert.ok(deposits[1].args[5] > deposits[0].args[5]);
  assert.deepEqual(deposits.map(c => c.args[4]), [BigInt(995000), BigInt(995000)]);
});
