// The Builder's Soroswap API route (app/api/soroswap/[step]/route.ts): the key
// stays server-side, inputs are allowlisted, venue and slippage are forced on
// /quote and checked on /build, and the API's status codes pass through.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const sdk = require("@stellar/stellar-sdk");
const root = path.join(__dirname, "..");

function load(file, imports = {}, globals = {}) {
  const code = ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  new Function("require", "module", "exports", ...Object.keys(globals), code)(name => imports[name] ?? require(name), module, module.exports, ...Object.values(globals));
  return module.exports;
}
const network = load("lib/network.ts", { "@/data/testnet-manifest.json": require("../data/testnet-manifest.json") });
const { TESTNET } = network;
const [USDC, XLM] = [TESTNET.usdc.contract, TESTNET.assets.XLM.address];
const OWNER = sdk.Keypair.random().publicKey();
const KEY = "sk_private-test-key";

function route({ replies = [], key = KEY } = {}) {
  const calls = [];
  const mod = load("app/api/soroswap/[step]/route.ts", { "@/lib/network": network }, {
    process: { env: key ? { SOROSWAP_API_KEY: key } : {} },
    fetch: async (url, options) => {
      calls.push({ url: String(url), options, body: JSON.parse(options.body) });
      const reply = replies.shift();
      if (typeof reply === "function") return reply();
      return new Response(JSON.stringify(reply.body), { status: reply.status, headers: reply.headers });
    },
  });
  const post = async (step, body) => {
    const response = await mod.POST(new Request(`http://localhost/api/soroswap/${step}`, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }),
      { params: Promise.resolve({ step }) });
    return { status: response.status, headers: response.headers, text: await response.text() };
  };
  return { post, calls };
}
const QUOTE = { assetIn: USDC, assetOut: XLM, tradeType: "EXACT_IN", amountIn: "100000000", amountOut: "654087498", otherAmountThreshold: "650817060", platform: "router",
  routePlan: [{ swapInfo: { protocol: "soroswap", path: [USDC, XLM] }, percent: "100.00" }],
  rawTrade: { amountIn: "100000000", amountOutMin: "650817060", distribution: [{ protocol_id: "soroswap", path: [USDC, XLM], parts: 10, is_exact_in: true }] } };

test("quote forwards only the leg's fields, with the testnet venue and slippage forced and the key server-side", async () => {
  const r = route({ replies: [{ status: 201, body: QUOTE }] });
  const answer = await r.post("quote", { network: "testnet", assetIn: USDC, assetOut: XLM, amount: "100000000",
    protocols: ["sdex"], slippageBps: 5000, tradeType: "EXACT_OUT", to: OWNER });
  assert.equal(answer.status, 201);
  assert.deepEqual(JSON.parse(answer.text), QUOTE);
  assert.equal(r.calls[0].url, "https://api.soroswap.finance/quote?network=testnet");
  assert.equal(r.calls[0].options.headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(r.calls[0].body, { assetIn: USDC, assetOut: XLM, amount: "100000000", tradeType: "EXACT_IN", protocols: ["soroswap"], slippageBps: 50 });
  assert.ok(!answer.text.includes(KEY) && !JSON.stringify([...answer.headers]).includes(KEY));
});

test("build sends the quote unchanged with from, and no to", async () => {
  const r = route({ replies: [{ status: 201, body: { xdr: "AAAA", action: "SIGN_TRANSACTION" } }] });
  const answer = await r.post("build", { network: "testnet", quote: QUOTE, from: OWNER, to: sdk.Keypair.random().publicKey() });
  assert.equal(answer.status, 201);
  assert.equal(r.calls[0].url, "https://api.soroswap.finance/quote/build?network=testnet");
  assert.deepEqual(r.calls[0].body, { quote: QUOTE, from: OWNER });
});

test("inputs outside the testnet allowlist are refused before any Soroswap call", async () => {
  const r = route();
  const quote = { network: "testnet", assetIn: USDC, assetOut: XLM, amount: "1" };
  const refused = [
    ["quote", { ...quote, network: "mainnet" }, /Unsupported network/],
    ["quote", { ...quote, assetIn: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA" }, /manifest assets/],
    ["quote", { ...quote, assetOut: USDC }, /must differ/],
    ...["0", "-1", "10.5", "1e3", 10, "9".repeat(39)].map((amount) => ["quote", { ...quote, amount }, /positive integer/]),
    ["build", { network: "testnet", quote: QUOTE, from: USDC }, /G\.\.\. account/],
    ["build", { network: "testnet", quote: QUOTE, from: OWNER.slice(0, -1) + (OWNER.endsWith("A") ? "B" : "A") }, /G\.\.\. account/],
    ["build", { network: "testnet", quote: { ...QUOTE, tradeType: "EXACT_OUT" }, from: OWNER }, /EXACT_IN quote/],
    ["build", { network: "testnet", quote: { ...QUOTE, assetOut: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA" }, from: OWNER }, /manifest assets/],
    ["build", { network: "testnet", quote: [QUOTE], from: OWNER }, /\/quote response/],
    ...["__proto__", "constructor", "toString", null, []].map((network) => ["quote", { ...quote, network }, /Unsupported network/]),
    ["build", { network: "__proto__", quote: QUOTE, from: OWNER }, /Unsupported network/],
  ];
  for (const [step, body, message] of refused) {
    const answer = await r.post(step, body);
    assert.equal(answer.status, 400, JSON.stringify(body));
    assert.match(JSON.parse(answer.text).error, message);
  }
  assert.equal((await r.post("quote", "{")).status, 400);
  assert.equal((await r.post("quote", JSON.stringify({ ...quote, pad: "x".repeat(20000) }))).status, 413);
  assert.equal((await r.post("send", { xdr: "AAAA" })).status, 404);
  assert.equal(r.calls.length, 0);
  const unconfigured = route({ key: null });
  assert.equal((await unconfigured.post("quote", quote)).status, 503);
  assert.equal(unconfigured.calls.length, 0);
});

test("build refuses a quote that is not the API's own router quote at the forced venue and slippage", async () => {
  const r = route();
  const raw = QUOTE.rawTrade, [part] = raw.distribution;
  const tampered = [
    // Reproduced against the live API before this check: a lowered minimum was built as amount_out_min 1.
    { ...QUOTE, otherAmountThreshold: "1", rawTrade: { ...raw, amountOutMin: "1" } },
    { ...QUOTE, otherAmountThreshold: "650817059", rawTrade: { ...raw, amountOutMin: "650817059" } },
    { ...QUOTE, rawTrade: { ...raw, amountOutMin: "1" } },
    { ...QUOTE, rawTrade: { ...raw, amountIn: "1" } },
    { ...QUOTE, amountOut: "1.5" },
    { ...QUOTE, platform: "aggregator" },
    { ...QUOTE, platform: "sdex" },
    { ...QUOTE, gaslessTrustline: "create" },
    { ...QUOTE, routePlan: [{ swapInfo: { protocol: "sdex", path: [USDC, XLM] }, percent: "100.00" }] },
    { ...QUOTE, routePlan: [] },
    { ...QUOTE, rawTrade: { ...raw, distribution: [{ ...part, protocol_id: "aqua" }] } },
    { ...QUOTE, rawTrade: { ...raw, distribution: [{ ...part, path: [USDC, TESTNET.assets.tRESERVE.address] }] } },
    { ...QUOTE, rawTrade: { ...raw, distribution: [] } },
    { ...QUOTE, rawTrade: undefined },
  ];
  for (const quote of tampered) {
    const answer = await r.post("build", { network: "testnet", quote, from: OWNER });
    assert.equal(answer.status, 400, JSON.stringify(quote));
    assert.match(JSON.parse(answer.text).error, /router quote|route only through soroswap|minimum must be the API's at 0\.5% slippage/);
  }
  assert.equal(r.calls.length, 0);
});

test("the API's status codes pass through: 428 with actionData, 429 with Retry-After, 400 with its message", async () => {
  const trustline = { message: "Missing trustline", action: "CREATE_TRUSTLINE", actionData: { xdr: "AAAA", assetCode: "tRESERVE" }, errorCode: 13 };
  const r = route({ replies: [{ status: 428, body: trustline }, { status: 429, body: { message: "Rate limit exceeded", retryAfter: 1 }, headers: { "Retry-After": "1" } },
    { status: 400, body: { message: "No path found" } }, () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }, () => { throw new Error("ECONNRESET"); }] });
  const missing = await r.post("build", { network: "testnet", quote: QUOTE, from: OWNER });
  assert.deepEqual([missing.status, JSON.parse(missing.text)], [428, trustline]);
  const limited = await r.post("quote", { network: "testnet", assetIn: USDC, assetOut: XLM, amount: "1" });
  assert.deepEqual([limited.status, limited.headers.get("Retry-After")], [429, "1"]);
  const none = await r.post("quote", { network: "testnet", assetIn: USDC, assetOut: XLM, amount: "1" });
  assert.deepEqual([none.status, JSON.parse(none.text).message], [400, "No path found"]);
  assert.equal((await r.post("quote", { network: "testnet", assetIn: USDC, assetOut: XLM, amount: "1" })).status, 504);
  assert.equal((await r.post("quote", { network: "testnet", assetIn: USDC, assetOut: XLM, amount: "1" })).status, 502);
});
