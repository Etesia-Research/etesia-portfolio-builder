import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { TESTNET, type VaultNetworkConfig } from "@/lib/network";

// Server-side proxy for the Soroswap Aggregator API's /quote and /quote/build.
// It keeps SOROSWAP_API_KEY off the client, accepts only the fields a testnet
// allocation leg needs, forces tradeType, protocols and slippageBps from the
// network config on /quote, builds on /build only a quote of that shape (router
// platform, those protocols, the minimum at that slippage), and passes the
// API's status and body through (201 on success, 428 with actionData, 429 with
// Retry-After). /send is not proxied: the browser submits the signed
// transaction through its own RPC.
//
// doc-checked: soroswap-docs api/quickstart, api-reference/quote/quote,
//   api-reference/quote/build, api/errors, api/plans, api/stellar-gotchas.

export const dynamic = "force-dynamic";

const SOROSWAP_API = "https://api.soroswap.finance";
// Only networks whose swaps execute; mainnet stays simulated and has no route here.
const NETWORKS: Record<string, VaultNetworkConfig> = { [TESTNET.soroswap.network]: TESTNET };
const AMOUNT = /^[1-9]\d{0,37}$/; // positive integer units, within i128
const MAX_BODY = 16384;

type Checked = { net: VaultNetworkConfig; body: object } | { error: string };

function checkAssets(net: VaultNetworkConfig, assetIn: unknown, assetOut: unknown): string | null {
  const allowed = Object.values(net.assets).map((asset) => asset.address);
  if (!allowed.includes(assetIn as string) || !allowed.includes(assetOut as string)) return `Assets must be ${net.label} manifest assets`;
  return assetIn === assetOut ? "assetIn and assetOut must differ" : null;
}

// A /quote answer as this route asks for it (soroswap-docs api-reference/quote/quote):
// the Soroswap router platform, only the network's protocols, no gasless
// trustline, every path from assetIn to assetOut, rawTrade's amounts equal to
// the quote's, and a minimum no lower than amountOut at the network's slippage.
function checkQuote(net: VaultNetworkConfig, quote: any): string | null {
  const { protocols, slippageBps } = net.soroswap;
  const { assetIn, assetOut, amountIn, amountOut, otherAmountThreshold, rawTrade, routePlan } = quote;
  const ends = (path: unknown) => Array.isArray(path) && path[0] === assetIn && path.at(-1) === assetOut;
  const distribution = rawTrade?.distribution;
  if (quote.platform !== "router" || quote.gaslessTrustline != null) return "quote must be a Soroswap router quote";
  if (!Array.isArray(routePlan) || !routePlan.length || !routePlan.every((route) => protocols.includes(route?.swapInfo?.protocol) && ends(route.swapInfo.path))
    || !Array.isArray(distribution) || !distribution.length || !distribution.every((part) => protocols.includes(part?.protocol_id) && ends(part.path)))
    return `quote must route only through ${protocols.join(", ")} from assetIn to assetOut`;
  const min = String(otherAmountThreshold);
  if (rawTrade.amountIn !== amountIn || typeof amountOut !== "string" || !AMOUNT.test(amountOut) || !AMOUNT.test(min) || String(rawTrade.amountOutMin) !== min
    || BigInt(min) < BigInt(amountOut) * BigInt(10000 - slippageBps) / BigInt(10000))
    return `quote's minimum must be the API's at ${slippageBps / 100}% slippage`;
  return null;
}

function check(step: string, input: any): Checked {
  const net = Object.hasOwn(NETWORKS, input?.network) ? NETWORKS[input.network] : undefined;
  if (!net) return { error: "Unsupported network" };
  if (step === "quote") {
    const { assetIn, assetOut, amount } = input;
    const error = checkAssets(net, assetIn, assetOut) ?? (typeof amount === "string" && AMOUNT.test(amount) ? null : "amount must be a positive integer string");
    if (error) return { error };
    return { net, body: { assetIn, assetOut, amount, tradeType: "EXACT_IN", protocols: net.soroswap.protocols, slippageBps: net.soroswap.slippageBps } };
  }
  const { quote, from } = input;
  if (typeof from !== "string" || !StrKey.isValidEd25519PublicKey(from)) return { error: "from must be a G... account" };
  if (!quote || typeof quote !== "object" || Array.isArray(quote)) return { error: "quote must be the /quote response" };
  const error = checkAssets(net, quote.assetIn, quote.assetOut)
    ?? (quote.tradeType === "EXACT_IN" && typeof quote.amountIn === "string" && AMOUNT.test(quote.amountIn) ? null : "quote must be an EXACT_IN quote with an integer amountIn")
    ?? checkQuote(net, quote);
  if (error) return { error };
  // The checked quote goes back unchanged; Soroban routes deliver to from, so no to.
  return { net, body: { quote, from } };
}

export async function POST(request: NextRequest, context: { params: Promise<{ step: string }> }) {
  const { step } = await context.params;
  if (step !== "quote" && step !== "build") return NextResponse.json({ error: "Unknown Soroswap endpoint" }, { status: 404 });
  let input;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY) return NextResponse.json({ error: "Request too large" }, { status: 413 });
    input = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Invalid JSON request" }, { status: 400 });
  }
  const checked = check(step, input);
  if ("error" in checked) return NextResponse.json({ error: checked.error }, { status: 400 });
  const key = process.env.SOROSWAP_API_KEY;
  if (!key) return NextResponse.json({ error: "Soroswap API is not configured" }, { status: 503 });
  try {
    const response = await fetch(`${SOROSWAP_API}/${step === "quote" ? "quote" : "quote/build"}?network=${checked.net.soroswap.network}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(checked.body),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    const headers: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store" };
    const retryAfter = response.headers.get("Retry-After");
    if (retryAfter) headers["Retry-After"] = retryAfter;
    return new NextResponse(await response.text(), { status: response.status, headers });
  } catch (error) {
    const timeout = error instanceof Error && error.name === "TimeoutError";
    return NextResponse.json({ error: timeout ? "Soroswap request timed out" : "Could not reach the Soroswap API" }, { status: timeout ? 504 : 502 });
  }
}
