// Network configuration for the Builder routes.
//
// doc-checked: developers.stellar.org "Networks" (passphrases, public RPC and
//   Horizon endpoints for testnet). The testnet values come from the copied
//   pre-reset deployment manifest (data/testnet-manifest.json, sha256
//   cfa30d48adb6c5559dfbed446a4a0763c67ed0672305b18910e493b1920c2220, copied
//   from etesia-vault/deploy/testnet/pre-2026-12-16-reset.json), so the
//   passphrase, vault and USDC ids cannot drift from the deployed contracts.

import manifest from "@/data/testnet-manifest.json";

export type ManifestAsset = {
  address: string;
  symbol: string;
  kind: string;
  decimals: number;
  classic?: string;
};

export type NetworkConfig = {
  label: string;
  passphrase: string;
  horizonUrl: string;
  // Wallet display kinds offered on this network (see walletKit.ts).
  wallets: readonly string[];
};

export type TestnetConfig = NetworkConfig & {
  epoch: string;
  rpcUrl: string;
  explorerUrl: string;
  faucetUrl: string;
  vault: string;
  usdc: { contract: string; code: string; issuer: string; decimals: number };
  assets: Record<string, ManifestAsset>;
};

export const MAINNET: NetworkConfig = {
  label: "Stellar mainnet",
  passphrase: "Public Global Stellar Network ; September 2015",
  horizonUrl: "https://horizon.stellar.org",
  wallets: ["Freighter", "Albedo", "xBull", "Lobstr Vault", "HOT Wallet"],
};

// Asset registry keyed by symbol, generated from the manifest at build time.
const assets: Record<string, ManifestAsset> = Object.fromEntries(
  (manifest.assets as ManifestAsset[]).map((asset) => [asset.symbol, asset])
);
const [usdcCode, usdcIssuer] = (assets.USDC.classic ?? "").split(":");
if (assets.USDC.address !== manifest.vaults.flagship.usdc || !usdcIssuer)
  throw new Error("Testnet manifest USDC does not match the flagship vault");

export const TESTNET: TestnetConfig = {
  label: "Stellar testnet",
  passphrase: manifest.passphrase,
  horizonUrl: "https://horizon-testnet.stellar.org",
  // Only wallets that report their network or accept a pinned passphrase.
  wallets: ["Freighter", "xBull"],
  epoch: manifest.network_epoch,
  rpcUrl: "https://soroban-testnet.stellar.org",
  explorerUrl: "https://stellar.expert/explorer/testnet",
  faucetUrl: "https://testnet.blend.capital",
  vault: manifest.vaults.flagship.id,
  usdc: { contract: assets.USDC.address, code: usdcCode, issuer: usdcIssuer, decimals: assets.USDC.decimals },
  assets,
};
