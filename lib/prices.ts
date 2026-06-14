// Live price layer (Soroswap API).
//
// doc-checked: Soroswap API 1.0 OpenAPI (https://api.soroswap.finance/api-json)
//   GET /price?network=mainnet&asset=<contract>&referenceCurrency=USD
//   GET /asset-list?name=SOROSWAP|STELLAR_EXPERT|LOBSTR|AQUA|ALL
//
// Canonical contracts were resolved from Soroswap's own asset lists, selected by
// the asset's OFFICIAL home domain (NOT by code — many scam tokens share a code;
// e.g. an "XLM" entry under atmxrpxlm.org, 9 "USDC" entries). XLM = native SAC.
//
// Issuers validated 2026-06-12: every (code, issuer) pair derives (via
// Asset.contractId(Networks.PUBLIC)) to exactly the contract listed here, so
// code/issuer/contract are mutually consistent. AQUA + RIO issuers were
// corrupted strings (invalid strkey) and were re-resolved from the official
// home-domain SEP-1 stellar.toml; the corrected values derive to the same
// (already live-priced) contracts.
//
// Validated live against the API (2026-06-02): referenceCurrency is effectively
// ignored and /price returns each token's USD value from Soroswap pools, which is
// only reliable where Soroswap has liquidity. Confirmed unreliable/missing:
//   - USDC: returns ~$0.23 (broken pool; USDC/USDC != 1)  -> static fallback
//   - BTCLN: returns ~$0.0007 (token unit != 1 BTC)        -> static fallback
//   - MOBI, RIO: price null (no pool)                      -> static fallback
// Everything else (XLM, AQUA, yXLM, EURC, SHX, AFR, ARST, GYEN) prices live.

import COINS from "@/data/coin-data.json";

export type AssetRef = { contract: string; issuer: string; domain: string };

// tk -> { Soroban contract, classic issuer, official home domain }
export const ASSET_CONTRACTS: Record<string, AssetRef> = {
  XLM: { contract: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA", issuer: "native", domain: "stellar.org" },
  USDC: { contract: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", domain: "centre.io" },
  AQUA: { contract: "CAUIKL3IYGMERDRUN6YSCLWVAKIFG5Q4YJHUKM4S4NJZQIA3BAS6OJPK", issuer: "GBNZILSTVQZ4R7IKQDGHYGY2QXL5QOFJYQMXPKWRRM5PAV7Y4M67AQUA", domain: "aqua.network" },
  yXLM: { contract: "CBZVSNVB55ANF24QVJL2K5QCLOAB6XITGTGXYEAF6NPTXYKEJUYQOHFC", issuer: "GARDNV3Q7YGT4AKSDF25LT32YSCCW4EV22Y2TV3I2PU2MMXJTEDL5T55", domain: "ultracapital.xyz" },
  EURC: { contract: "CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV", issuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2", domain: "circle.com" },
  BTCLN: { contract: "CBHIQPUXLFLC5O44ZJVUTCL5LMZFLVGU5DEIGSYKBSAPFMOGTKOQEPFM", issuer: "GDPKQ2TSNJOFSEE7XSUXPWRP27H6GFGLWD7JCHNEYYWQVGFA543EVBVT", domain: "kbtrading.org" },
  SHX: { contract: "CCKCKCPHYVXQD4NECBFJTFSCU2AMSJGCNG4O6K4JVRE2BLPR7WNDBQIQ", issuer: "GDSTRSHXHGJ7ZIVRBXEYE5Q74XUVCUSEKEBR7UCHEUUEK72N7I7KJ6JH", domain: "stronghold.co" },
  MOBI: { contract: "CATHRLMZW3JUIYSXYE4YAI3SBBBQGXYAP674RINGUBQLNFTCZHMI5XZJ", issuer: "GA6HCMBLTZS5VYYBCATRBRZ3BZJMAFUDKYYF6AH6MVCMGWMRDNSWJPIH", domain: "mobius.network" },
  RIO: { contract: "CB2XLDU74PIXO5DENULX53IIC3DMKGN2UM5IBGMSSI634IAQJ7O3Z3UQ", issuer: "GBNLJIYH34UWO5YZFA3A3HD3N76R6DOI33N4JONUOHEEYZYCAYTEJ5AK", domain: "realio.fund" },
  AFR: { contract: "CCG27OZ5AV4WUXS6XTECWAXEY5UOMEFI2CWFA3LHZGBTLYZWTJF3MJYQ", issuer: "GBX6YI45VU7WNAAKA3RBFDR3I3UKNFHTJPQ5F6KOOKSGYIAM4TRQN54W", domain: "afreum.com" },
  ARST: { contract: "CCRPYMVKZLWGZHEDZ23FOE22E3T3HOCNP5Y2EFZFVRUVIXU5NJ7UNGV2", issuer: "GCSAZVWXZKWS4XS223M5F54H2B6XPIIXZZGP7KEAIU6YSL5HDRGCI3DG", domain: "anclap.com" },
  GYEN: { contract: "CA67EQNWGPGXHVT6E4HQ65WEV54KFDB6HJDHVCJM33VKZ7XKR5MN3KPJ", issuer: "GDF6VOEGRWLOZ64PQQGKD2IYWA22RLT37GJKS2EJXZHT2VLAGWLC5TOB", domain: "stablecoin.z.com" },
};

const STATIC_PRICE: Record<string, number> = Object.fromEntries(
  (COINS as Array<{ tk: string; price: number }>).map((c) => [c.tk, c.price])
);

// USD stablecoins — if Soroswap reports them far off the $1 peg it's bad pool data.
const USD_PEGGED = new Set(["USDC"]);

export type PriceInfo = {
  price: number;
  live: boolean;
  ts: string | null;
  source: "soroswap" | "static";
};

/**
 * Decide whether to trust Soroswap's value for an asset; otherwise fall back to
 * the static research price (clearly labeled). This is a documented reliability
 * guard, NOT value invention — the fallback is the app's existing static datum.
 */
export function classifyPrice(tk: string, soroswap: number | null, ts: string | null): PriceInfo {
  const stat = STATIC_PRICE[tk] ?? 0;
  const staticInfo: PriceInfo = { price: stat, live: false, ts: null, source: "static" };
  if (soroswap == null || !isFinite(soroswap) || soroswap <= 0) return staticInfo;
  if (USD_PEGGED.has(tk) && Math.abs(soroswap - 1) > 0.15) return staticInfo; // depeg => bad data
  const ratio = stat > 0 ? soroswap / stat : 1;
  if (ratio > 20 || ratio < 0.05) return staticInfo; // gross unit/identity mismatch (e.g. BTCLN)
  return { price: soroswap, live: true, ts, source: "soroswap" };
}

/** Client-side: fetch live prices via our server proxy and classify each. */
export async function fetchLivePrices(): Promise<Record<string, PriceInfo>> {
  const res = await fetch("/api/prices", { cache: "no-store" });
  if (!res.ok) throw new Error(`price proxy ${res.status}`);
  const { prices } = (await res.json()) as {
    prices: Record<string, { price: number | null; ts: string | null }>;
  };
  const out: Record<string, PriceInfo> = {};
  for (const tk of Object.keys(ASSET_CONTRACTS)) {
    const r = prices?.[tk] ?? { price: null, ts: null };
    out[tk] = classifyPrice(tk, r.price, r.ts);
  }
  return out;
}
