# Etesia Portfolio Builder

Next.js frontend for the Etesia quant API. Use pnpm and the committed lockfile.

## License

Copyright (c) 2026 Etesia Research Inc. All rights reserved.
Etesia-owned materials are available for inspection of the implementation and
demonstrations under the [Proprietary Source Inspection License](LICENSE).
Running, building, testing, copying, modifying, distributing or deploying them
requires prior written authorization and a separate agreement signed by both
parties, subject to the license's platform, third-party and legal exceptions.
The setup and verification instructions below are for authorized users.
Dependencies, fonts and third-party logos retain their own licenses and ownership;
see also [logo sources](public/logos/README.md). GitHub's public-repository viewing
and forking rights remain unaffected.

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

Development uses `.next-dev`; production builds and `pnpm start` use `.next`.
This keeps `pnpm build` from overwriting chunks loaded by an active dev server.
Both generated directories are ignored by Git.

## Wallets

The connection screen and Stellar Wallets Kit picker support Freighter, Albedo,
xBull, Lobstr Vault and HOT Wallet on Stellar mainnet. Select HOT Wallet in the
picker, then approve in its extension or Telegram/mobile widget. The existing
kit 2.2.0 includes `HotWalletModule`; no extra dependency or API key is required.
See the [HOT SDK Stellar integration](https://github.com/hot-dao/hot-sdk-js#stellar-connect).
Connecting reads balances; execution remains simulated and requests no signatures.

Local validation on 2026-09-19: production build, TypeScript and all 27 existing
tests passed. Browser checks used a controlled HOT extension provider and stubbed
widget transport to verify the address request, connected label, balance lookup,
rejection, disconnect and reconnect, plus desktop/mobile layouts. No browser
runtime errors occurred. Real HOT extension/Telegram/mobile approval remains
unverified. To check it manually, open the picker, choose HOT Wallet, approve,
confirm the account/balances, disconnect, then reconnect or reject the request.

Known upstream picker limitation: on reopening, an immediate wallet response can
arrive before the kit finishes availability checks and installs its modal event
listeners, leaving the connection pending. Controlled checks wait for those
checks before selecting the wallet. Reloading restores the connection screen.

## Data and allocation

- Product cards come from the quant catalog: XLM, AQUA, ETH, BTC, SHX and the
  Etesia TF vault. USDC/EURC/USTRY are reserve assets, absent from the product grid.
- Prices are dated daily USD closes, not live swap marks. The price band shows
  the completed candle day: a September 19 midnight UTC boundary is labeled
  September 18. Analytics show their actual start/end candle dates;
  raw timestamps and freshness checks remain unchanged. Market caps, annualized
  Sharpe over up to three years and basket correlations come from the API. Missing values remain
  unavailable; no static numerical fallback or browser allocation solver exists.
- Working basket shows average signed pairwise correlation (distinct pairs only)
  and annualized return, Sharpe, maximum drawdown and Calmar together from one
  `POST /v1/basket/analytics` response. The basket starts
  with equal capital per selected product and holds quantities fixed for up to three
  years (available common history, minimum one year), in USD with a 0% risk-free rate. Funding, reserves and allocator weights
  do not affect these selection metrics. Single-product correlation and missing
  data show an em dash with a reason; simulated vault returns remain labeled.
- Product icons use locally served official project assets and the supplied
  Etesia mark; see [logo sources](public/logos/README.md).
- After allocation, one `POST /v1/builder/simulation` request returns return,
  Sharpe, annualized volatility, max drawdown, Calmar and both portfolio/XLM equity curves. All calculated
  weights, including buffers and reserves, span the full trailing three years. Each
  allocation stays in USD cash at 0% until its first available close, then buys and
  holds the asset without rebalancing. Later start dates are shown; all metrics use
  the full curve. Both USD curves start at 100;
  pointer and keyboard controls expose daily values. Today's weights applied to
  the past are a retrospective illustration, excluding trading costs. Internal gaps,
  stale tails, entirely missing history or a changed market snapshot show an explicit unavailable state.
- **Simulate execution** uses actual-size quotes for the funding conversion into
  USDC and each nonzero swap position. Quoted USDC proceeds are divided by the
  model fractions; atomic rounding dust stays in the USDC buffer. Cash is retained
  without a swap. The vault needs no swap quote: shares assume $1 USD, using the
  reference USDC/USD conversion. Each row shows quoted output, minimum output,
  and quote time; failed or 60-second-old quotes block simulation. Refresh obtains
  a new complete quote set and clears any prior completion. No wallet signature,
  transaction, invented receipt hash or balance mutation occurs. Network/vault
  fees are excluded; fills are assumed at quoted outputs.
- The vault remains **Under construction**, but a selected vault participates in
  covariance allocation through its simulated equity history. Allocation and
  historical simulation retain `vault_run_id`; a report change requires rebuilding.
  Its $1 share price is an explicit sizing assumption, not a published live mark.
- Quotes appear only after allocation. Product/reserve selection and allocation
  construction do not depend on quotes. ETH/BTC analytics use underlying histories,
  while quoted Stellar instruments are the identified Ultra Capital wrappers.
- Funding uses actual Horizon balances. The hypothetical USDC capital is
  `quantity × source USD close / USDC USD close`, with fresh matching timestamps.
  The displayed catalog value is a daily-reference estimate, not full-wallet NAV.
- Funding includes a **Risk cap** slider, default **25%**, sent as the annual
  allocated-sleeve volatility budget. It does not change the reserve/buffer fractions
  or promise realized whole-portfolio volatility.
- Builder preserves equal-risk proportions by scaling all selected products down
  to the 40% portfolio-capital cap for non-vault products. Etesia vault alone is
  exempt; common volatility/gross limits and buffers remain. The product sleeve may be smaller
  than the available capital. Residual cash goes to the selected reserves.
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
additional capabilities unavailable. The expanded Builder does not change
vault strategy or historical replay universes.

## Manual verification

Load the universe without connecting a wallet, select the vault, and verify that
correlation labels identify simulated returns. Connect a wallet, select a source
balance and products, choose cash reserves, and
calculate. Check that positions sum to the supplied USDC capital and show each
buffer separately. Empty reserve selections, stale/missing reference prices,
failed balance refreshes must prevent construction. Unavailable routes must not
block allocation. Confirm there are no quote requests before allocation and that
refreshing quotes uses current actual amounts and clears the previous receipt.
Check quote failures, expiry, vault $1 share sizing, all three reserve logos,
and three-year/shorter available-history metrics and date labels.
Changing inputs or wallets must invalidate a pending result. EURC requires published
history and API reserve support before selection.
Missing or invalid EURC closes block a selected EURC reserve without affecting
other reserve choices or vault targets.

EURC uses [Circle’s published Stellar issuer](https://developers.circle.com/stablecoins/eurc-contract-addresses), with its mainnet asset contract derived using the Stellar SDK. Its API proxy routes and reserve selection passed frontend regression tests, TypeScript checks and the production build on September 19, 2026.


Allocation totals include the vault. The preview separately labels selected-product
allocation and estimated annual product volatility (one-year risk model, excluding
reserves/buffers). The performance table shows historical annualized volatility
for the entire portfolio and XLM over the same three-year curve used for Sharpe.
ERC balances modeled risk contributions; it does not maximize historical Sharpe.

Return labels explicitly identify CAGR. Sharpe uses annualized arithmetic daily
mean divided by annualized sample volatility at a 0% risk-free rate; CAGR divided
by volatility is not the displayed Sharpe. The one-year covariance model estimate
and full three-year historical portfolio volatility use different windows, weights
and scopes and are labeled separately.


## Etesia-TF factsheet

The Etesia-TF product's info link opens `/stellar_tf_vault`, a public, responsive
strategy factsheet requiring no wallet. It shows the fixed XLM/AQUA/ETH/BTC
universe, monthly risk-parity weights, daily target capital allocations including
reserves/buffers, and the latest published backtest metrics. Trend signals are
omitted by user request. Investor copy describes the approach without formulas
or calibration parameters; allocations and performance are explicitly simulated.

The server reads authenticated `vault/weights` and `vault/backtests/latest` using
the existing configuration, without exposing their full research payloads.
Missing/blocked allocations remain unavailable; report availability is independent
and stale reports retain their dates and warning. PDF and XLSX downloads use
`/api/quant/vault/backtests/{run_id}/files/{pdf|xlsx}`. This GET-only proxy validates
the 20-character hexadecimal run ID and format, streams the original binary,
and keeps the bearer key server-side. Both links are bound to the displayed run.

Local verification on 2026-09-19: production build, TypeScript and 30 tests passed.
Desktop (1440px) and mobile (390px) browser checks passed selection/info navigation,
layout without horizontal overflow, binary PDF/XLSX downloads, unknown-run and
invalid-path rejection, with no browser runtime errors. Tests cover blocked and
unavailable allocations, zero holdings, null metrics, stale reports, independent
report failures and private-payload exclusion. Real report `70c32c0f372438da9738`
was read through the existing backend; no backend change or frontend deployment
was performed.
