// Network configuration for the Builder routes.
//
// doc-checked: developers.stellar.org "Networks" (passphrases, public RPC and
//   Horizon endpoints for testnet). The testnet values come from the copied
//   pre-reset deployment manifest (data/testnet-manifest.json, sha256
//   cfa30d48adb6c5559dfbed446a4a0763c67ed0672305b18910e493b1920c2220, copied
//   from etesia-vault/deploy/testnet/pre-2026-12-16-reset.json), so the vault
//   and USDC ids cannot drift from the deployed contracts, and the manifest's
//   passphrase must match the network it is used on.

import manifest from "@/data/testnet-manifest.json";

export type ManifestAsset = {
  address: string;
  symbol: string;
  kind: string;
  decimals: number;
  classic?: string;
  stand_in?: string;
};

export type NetworkConfig = {
  label: string;
  passphrase: string;
  horizonUrl: string;
  // Wallet display kinds offered on this network (see walletKit.ts).
  wallets: readonly string[];
};

// A deployed vault on one network: its manifest's contracts plus that
// network's endpoints. Only vaultNetwork() builds one, from a manifest.
export type VaultNetworkConfig = NetworkConfig & {
  epoch: string;
  rpcUrl: string;
  explorerUrl: string;
  faucetUrl: string | null;
  // Quant API path of the vault's indexed views.
  indexer: string;
  vault: string;
  usdc: { contract: string; code: string; issuer: string; decimals: number };
  assets: Record<string, ManifestAsset>;
  // The manifest's Soroswap router, called directly for swap quotes and swaps.
  router: string;
  // Universe id -> manifest symbol of the asset bought for it on this network.
  // Only these products have a market here; the vault and USDC need none.
  markets: Record<string, string>;
};

// Every network's deployment manifest has the shape of the testnet one.
export type Manifest = typeof manifest;
export type Endpoints = NetworkConfig & Pick<VaultNetworkConfig, "rpcUrl" | "explorerUrl" | "faucetUrl" | "indexer">;

export const MAINNET: NetworkConfig = {
  label: "Stellar mainnet",
  passphrase: "Public Global Stellar Network ; September 2015",
  horizonUrl: "https://horizon.stellar.org",
  wallets: ["Freighter", "Albedo", "xBull", "Lobstr Vault", "HOT Wallet"],
};

// The flagship vault of a manifest on the given network. A manifest for
// another network is rejected, so one network's contracts never get another's passphrase.
// Each market must name an asset of the manifest.
export function vaultNetwork(source: Manifest, network: Endpoints, markets: Record<string, string> = {}): VaultNetworkConfig {
  if (source.passphrase !== network.passphrase)
    throw new Error(`Manifest passphrase "${source.passphrase}" is not ${network.label}`);
  // Asset registry keyed by symbol, generated from the manifest at build time.
  const assets: Record<string, ManifestAsset> = Object.fromEntries(
    (source.assets as ManifestAsset[]).map((asset) => [asset.symbol, asset])
  );
  const [usdcCode, usdcIssuer] = (assets.USDC.classic ?? "").split(":");
  if (assets.USDC.address !== source.vaults.flagship.usdc || !usdcIssuer)
    throw new Error("Manifest USDC does not match the flagship vault");
  for (const symbol of Object.values(markets))
    if (!assets[symbol]) throw new Error(`Market asset ${symbol} is not in the manifest`);
  return {
    ...network,
    epoch: source.network_epoch,
    vault: source.vaults.flagship.id,
    usdc: { contract: assets.USDC.address, code: usdcCode, issuer: usdcIssuer, decimals: assets.USDC.decimals },
    assets,
    router: source.aggregator_config.soroswap_router,
    markets,
  };
}

export const TESTNET = vaultNetwork(manifest, {
  label: "Stellar testnet",
  passphrase: "Test SDF Network ; September 2015",
  horizonUrl: "https://horizon-testnet.stellar.org",
  // Only wallets that report their network or accept a pinned passphrase.
  wallets: ["Freighter", "xBull"],
  rpcUrl: "https://soroban-testnet.stellar.org",
  explorerUrl: "https://stellar.expert/explorer/testnet",
  faucetUrl: "https://testnet.blend.capital",
  indexer: "vaults/flagship",
}, { xlm: "XLM", ustry: "tRESERVE" });
