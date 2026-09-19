# Etesia Portfolio Builder

Next.js frontend for the Etesia quant API. Use pnpm and the committed lockfile.

## Configuration

Set these **server-only** variables in the ignored `.env.local`:

```dotenv
ETESIA_API_URL=https://your-quant-api.example
ETESIA_API_KEY=your-private-server-key
```

A hostname without a scheme is interpreted as HTTPS. The browser calls the
allowlisted `/api/quant/` proxy; the bearer key never enters browser requests.
No Soroswap credential is needed in the frontend. The quant service owns quotes.

```sh
pnpm install --frozen-lockfile
pnpm dev
pnpm exec node --test tests/*.test.cjs
pnpm build
pnpm exec tsc --noEmit
```

## Data and allocation

- Product cards come from the quant catalog: XLM, AQUA, ETH, BTC, SHX and the
  Etesia TF vault. USDC/USTRY are reserve assets, absent from the product grid.
- Prices are dated daily USD closes, not live swap marks. The price band shows
  the completed candle day: a September 19 midnight UTC boundary is labeled
  September 18. Analytics say **Data through close** with that same candle date;
  raw timestamps and freshness checks remain unchanged. Market caps, one-year
  Sharpe and basket correlations come from the API. Missing values remain
  unavailable; no static numerical fallback or browser allocation solver exists.
- Working basket shows average signed pairwise correlation (distinct pairs only)
  and one-year basket Sharpe from `POST /v1/basket/analytics`. The basket starts
  with equal capital per selected product and holds quantities fixed for one
  year, in USD with a 0% risk-free rate. Funding, reserves and allocator weights
  do not affect these selection metrics. Single-product correlation and missing
  data show an em dash with a reason; simulated vault returns remain labeled.
- The vault shows **Under construction**. Its Sharpe and correlations use the
  API's simulated return series and report metadata. It has no invented share
  price and cannot receive a Builder allocation.
- Route checks run and appear only in the final allocation step, for the funding
  asset and nonzero target positions, excluding USDC. Product/reserve selection
  and allocation construction do not depend on routes. **Refresh missing routes**
  retries only failed or unchecked assets and preserves successful checks for
  the current allocation. Revising/building a new allocation starts new checks.
  Checks quote both directions through the Soroswap API using exact Stellar
  contracts. A one-USDC route probe is availability evidence, not a liquidity or
  execution guarantee. ETH/BTC analytics use underlying histories, while the
  quoted Stellar instruments are the identified Ultra Capital wrappers.
- Funding uses actual Horizon balances. The hypothetical USDC capital is
  `quantity × source USD close / USDC USD close`, with fresh matching timestamps.
  The displayed catalog value is a daily-reference estimate, not full-wallet NAV.
- Funding includes a **Risk cap** slider, default **25%**, sent as the annual
  allocated-sleeve volatility budget. It does not change the reserve/buffer fractions
  or promise realized whole-portfolio volatility.
- **Cash reserve** appears after Funding. USTRY is selected by default; select
  USDC, EURC and/or USTRY to split residual cash equally by USDC notional. EURC
  uses aligned EURC/USD and USDC/USD closes and remains reserve-only. The 2.5% USDC and 2.5% XLM buffers are
  separate from this selection.
- The API returns target quantities, USDC notionals, reserve positions, annual
  allocated-sleeve volatility and binding constraints. Blocked calculations retain
  diagnostics. Execution remains a preview; no transaction is signed or submitted.

The expanded backend advertises `allocation_supported` for each token and
`cash_reserve_assets` in the catalog. The prepared backend update was deployed on September 19, 2026 as
`3fada63c-9489-40c5-84a8-832c5a237dbf`, enabling SHX allocation, USDC/EURC/USTRY reserves, EURC daily collection and token APIs. Against the older API, the frontend exposes
its four supported allocation products and default USTRY reserve, labeling the
additional capabilities unavailable. The five-product Builder does not change
vault strategy or historical replay universes.

## Manual verification

Load the universe without connecting a wallet, select the vault, and verify that
correlation labels identify simulated returns. Connect a wallet, select a source
balance and products, choose cash reserves, and
calculate. Check that positions sum to the supplied USDC capital and show each
buffer separately. Empty reserve selections, stale/missing reference prices,
failed balance refreshes must prevent construction. Unavailable routes must not
block allocation. Confirm there are no quote requests before allocation and that
retrying a missing route does not repeat successful probes.
Changing inputs or wallets must invalidate a pending result. EURC requires published
history and API reserve support before selection.
Missing or invalid EURC closes block a selected EURC reserve without affecting
other reserve choices or vault targets.

EURC uses [Circle’s published Stellar issuer](https://developers.circle.com/stablecoins/eurc-contract-addresses), with its mainnet asset contract derived using the Stellar SDK. Its API proxy routes and reserve selection passed frontend regression tests, TypeScript checks and the production build on September 19, 2026.
