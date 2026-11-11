// Vault registry: one entry per vault, with its deployment on each network
// built from that network's manifest (lib/network.ts vaultNetwork), or null
// while the vault is not deployed there. Vault pages live at
// /<slug>/<network> (app/[vault]/[network]); adding a vault is one entry.
//
// Deploying Etesia-TF on mainnet is configuration only: copy its manifest to
// data/mainnet-manifest.json and set
//   mainnet: vaultNetwork(mainnetManifest, { ...MAINNET, wallets, rpcUrl, explorerUrl, faucetUrl: null, indexer })
// vaultNetwork() rejects a manifest whose passphrase is not mainnet's.

import { TESTNET, type VaultNetworkConfig } from "@/lib/network";

export const NETWORKS = ["mainnet", "testnet"] as const;
export type Network = (typeof NETWORKS)[number];

export type Vault = {
  slug: string;
  name: string;
  coin: string; // quant universe id of the vault's catalog card
  factsheet: string;
  strategy: string;
  networks: Record<Network, VaultNetworkConfig | null>;
};

export const VAULTS: Vault[] = [
  {
    slug: "stellar_tf_vault", name: "Etesia-TF", coin: "etesia-tf", factsheet: "/stellar_tf_vault",
    strategy: "A systematic, long-only trend-following strategy with risk-parity allocation across XLM, AQUA, ETH and BTC. Capital outside the trend positions is held in USTRY reserves and USDC and XLM buffers.",
    networks: { mainnet: null, testnet: TESTNET },
  },
];

export const findVault = (slug: string) => VAULTS.find((vault) => vault.slug === slug);
export const isNetwork = (value: string): value is Network => (NETWORKS as readonly string[]).includes(value);
export const vaultHref = (vault: Vault, network: Network) => `/${vault.slug}/${network}`;
// The Builder's mode from its query string: mainnet unless ?network=testnet.
export const builderNetwork = (search: string): Network => new URLSearchParams(search).get("network") === "testnet" ? "testnet" : "mainnet";
export const builderHref = (network: Network) => network === "mainnet" ? "/" : `/?network=${network}`;
