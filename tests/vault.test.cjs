const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const sdk = require("@stellar/stellar-sdk");
const root = path.join(__dirname, "..");

function load(file, imports = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, resolveJsonModule: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", code)(name => imports[name] ?? require(name), module, module.exports);
  return module.exports;
}
const manifestPath = path.join(root, "data/testnet-manifest.json");
const network = load("lib/network.ts", { "@/data/testnet-manifest.json": require(manifestPath) });
const { TESTNET } = network;
const OWNER = sdk.Keypair.random().publicKey();
const i128 = (value) => sdk.nativeToScVal(BigInt(value), { type: "i128" });
const resourceFailure = { result: { type: "txFailed", results: [{ type: "opInner", tr: { type: "invokeHostFunction", invokeHostFunctionResult: { type: "invokeHostFunctionResourceLimitExceeded" } } }] } };
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
// sendTransaction and getTransaction outcomes (a function is thrown), and
// `horizon` stubs Horizon.Server.
function harness({ views = {}, sends = [], polls = [{ status: "SUCCESS", ledger: 77, returnValue: i128(5) }], horizon = {} } = {}) {
  const calls = { contract: [], signed: 0, sent: 0, polled: [], hashes: [] };
  const next = (queue, fallback) => {
    const outcome = queue.length ? queue.shift() : fallback;
    if (typeof outcome === "function") throw outcome();
    return outcome;
  };
  class Contract extends sdk.Contract {
    call(fn, ...args) {
      calls.contract.push({ fn, args: args.map(sdk.scValToNative) });
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
    async prepareTransaction(tx) { return tx; }
    async sendTransaction(tx) {
      calls.sent++;
      calls.hashes.push(Buffer.from(tx.hash()).toString("hex"));
      return { hash: calls.hashes.at(-1), ...next(sends, { status: "PENDING" }) };
    }
    async pollTransaction(hash, opts) { calls.polled.push(opts.attempts); return next(polls); }
  }
  class HorizonServer {
    async loadAccount(address) { return horizon.loadAccount(address); }
    async submitTransaction(tx) { return horizon.submitTransaction(tx); }
  }
  const vault = load("lib/vault.ts", {
    "@stellar/stellar-sdk": { ...sdk, Contract, rpc: { ...sdk.rpc, Server }, Horizon: { ...sdk.Horizon, Server: HorizonServer } },
    "@/lib/network": network,
    "@/components/stellar/walletKit": { signTx: async (xdr) => { calls.signed++; return xdr; } },
    "@/lib/quant": { quantRequest: async () => { throw new Error("not used"); } },
  });
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
  assert.deepEqual(await missing.vault.readUsdcLine(OWNER), { funded: false, trustline: false, balance: null, xlm: null });
  const balances = [{ asset_type: "native", balance: "10.0000000" }, { asset_code: "USDC", asset_issuer: TESTNET.usdc.issuer, balance: "5.0000000" }];
  const funded = harness({ horizon: { loadAccount: async () => ({ balances }) } });
  assert.deepEqual(await funded.vault.readUsdcLine(OWNER), { funded: true, trustline: true, balance: "5.0000000", xlm: "10.0000000" });
  const down = harness({ horizon: { loadAccount: async () => { throw new Error("Network Error"); } } });
  await assert.rejects(down.vault.readUsdcLine(OWNER), /Network Error/);
});

test("trustline submission maps Horizon result codes and treats a timeout as unknown", async () => {
  const failed = (status, extras) => async () => { throw Object.assign(new Error(`Transaction submission failed. Server responded: ${status}`), { response: { status, data: { extras } } }); };
  const loadAccount = async (address) => new sdk.Account(address, "1");
  const low = harness({ horizon: { loadAccount, submitTransaction: failed(400, { result_codes: { transaction: "tx_failed", operations: ["op_low_reserve"] } }) } });
  await assert.rejects(low.vault.addUsdcTrustline(OWNER), /more testnet XLM/);
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
