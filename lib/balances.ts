// Live wallet balances (Horizon, mainnet) — Step 4.
//
// doc-checked: developers.stellar.org Horizon "Retrieve an Account"
//   (GET /accounts/{account_id}) + live response verified against
//   horizon.stellar.org 2026-06-12: balances[] entries carry
//   { balance: string, asset_type: "native" | "credit_alphanum4" |
//     "credit_alphanum12" | "liquidity_pool_shares", asset_code?, asset_issuer? }.
//   CORS is enabled (Access-Control-Allow-Origin echoed), so a plain browser
//   fetch works — no server proxy and no SDK import needed for one GET.
//   Unknown/unfunded account -> 404 (account does not exist on the ledger).
//
// Holdings are matched to the catalog instrument identities by BOTH code AND issuer
// (a code alone can be a different/scam asset); XLM is the native balance.
// Assets in the wallet but outside the universe are ignored. Unheld -> 0.

import { ASSET_CONTRACTS } from "@/lib/assets";

const HORIZON = "https://horizon.stellar.org";

type HorizonBalance = {
  balance: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
};

// "CODE:ISSUER" -> universe ticker, for classic (non-native) assets.
const TK_BY_CODE_ISSUER: Record<string, string> = Object.fromEntries(
  Object.entries(ASSET_CONTRACTS)
    .filter(([, ref]) => ref.issuer !== "native")
    .map(([tk, ref]) => [`${tk}:${ref.issuer}`, tk])
);

const zeroHoldings = (): Record<string, number> =>
  Object.fromEntries(Object.keys(ASSET_CONTRACTS).map((tk) => [tk, 0]));

/** Fetch the account's real balances and map them onto the asset universe. */
export async function fetchHoldings(address: string): Promise<Record<string, number>> {
  const res = await fetch(`${HORIZON}/accounts/${encodeURIComponent(address)}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  // 404 = the account is not (yet) funded on the ledger — genuinely zero.
  if (res.status === 404) return zeroHoldings();
  if (!res.ok) throw new Error(`Horizon ${res.status}`);
  const { balances } = (await res.json()) as { balances: HorizonBalance[] };

  const out = zeroHoldings();
  for (const b of balances ?? []) {
    const amt = parseFloat(b.balance);
    if (!isFinite(amt)) continue;
    if (b.asset_type === "native") {
      out.XLM = amt;
    } else if (b.asset_code && b.asset_issuer) {
      const tk = TK_BY_CODE_ISSUER[`${b.asset_code}:${b.asset_issuer}`];
      if (tk) out[tk] = amt;
    }
  }
  return out;
}
