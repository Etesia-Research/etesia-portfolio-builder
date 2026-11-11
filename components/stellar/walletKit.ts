"use client";

// Stellar Wallets Kit v2 integration (browser-only).
//
// doc-checked: bundled type defs in @creit-tech/stellar-wallets-kit@2.8.0
//   (_dist/sdk/kit.d.ts, _dist/types/mod.d.ts, _dist/sdk/modules/*.d.ts) +
//   README + https://stellarwalletskit.dev. The kit is a static singleton:
//   init({modules}) per network, setNetwork(passphrase), authModal() to
//   connect, getNetwork() / signTransaction() on the selected wallet,
//   on(KitEventType.*) for state changes, disconnect(). 2.8.0 deprecates
//   FreighterModule in favour of VarialModule (Freighter is now Varial); both
//   use the module id 'varial'.
//
// The network comes from lib/network.ts. The mainnet Builder never signs.
// A vault page signs on its own network: the wallet's network is checked with getNetwork()
// on connect, before every signature and on window focus, and signing is
// blocked on a passphrase mismatch. xBull cannot report its network, so it
// relies on the passphrase that signTx always passes.
//
// All kit imports are dynamic so nothing touches `window` until called in the
// browser (the builder is already rendered ssr:false, this is belt-and-braces).

import useStellarWalletStore from "@/stores/useStellarWalletStore";
import { MAINNET, type NetworkConfig } from "@/lib/network";

// Display name on Etesia's connect cards -> resolved at load time to kit ids.
export const WALLET_KINDS = ["Freighter", "Albedo", "xBull", "Lobstr Vault", "HOT Wallet"] as const;
export type WalletKind = (typeof WALLET_KINDS)[number];

type Kit = { kit: any; modules: Record<string, any> };
let kitPromise: Promise<Kit> | null = null;
let idByKind: Record<string, string> = {};
let subscribed = false;
let network: NetworkConfig = MAINNET;
let kitNetwork: NetworkConfig | null = null;

async function loadKit(): Promise<Kit> {
  const [sdk, fre, alb, xb, lob, hot] = await Promise.all([
    import("@creit-tech/stellar-wallets-kit/sdk"),
    import("@creit-tech/stellar-wallets-kit/modules/varial"),
    import("@creit-tech/stellar-wallets-kit/modules/albedo"),
    import("@creit-tech/stellar-wallets-kit/modules/xbull"),
    import("@creit-tech/stellar-wallets-kit/modules/lobstr"),
    import("@creit-tech/stellar-wallets-kit/modules/hotwallet"),
  ]);
  const { StellarWalletsKit } = sdk as any;

  idByKind = {
    Freighter: fre.VARIAL_ID,
    Albedo: (alb as any).ALBEDO_ID,
    xBull: (xb as any).XBULL_ID,
    "Lobstr Vault": (lob as any).LOBSTR_ID,
    "HOT Wallet": hot.HOTWALLET_ID,
  };

  // Exactly the wallets Etesia offers — all config-free, so the connect
  // screen only lists wallets the kit can actually connect.
  return {
    kit: StellarWalletsKit,
    modules: {
      Freighter: new fre.VarialModule(),
      Albedo: new (alb as any).AlbedoModule(),
      xBull: new (xb as any).xBullModule(),
      "Lobstr Vault": new (lob as any).LobstrModule(),
      "HOT Wallet": new hot.HotWalletModule(),
    },
  };
}

// (Re)initialise the kit with the current network's wallets and passphrase.
async function getKit(): Promise<Kit> {
  if (!kitPromise) kitPromise = loadKit();
  const loaded = await kitPromise;
  if (kitNetwork !== network) {
    loaded.kit.init({ modules: network.wallets.map((kind) => loaded.modules[kind]) });
    loaded.kit.setNetwork(network.passphrase);
    kitNetwork = network;
  }
  return loaded;
}

// Subscribe the zustand store to kit state changes (account switch, disconnect
// triggered from inside the wallet, etc.). Idempotent across re-mounts.
export async function initWalletKit(config: NetworkConfig = MAINNET): Promise<void> {
  network = config;
  if (subscribed) {
    await getKit();
    return checkRestoredSession();
  }
  subscribed = true;
  const { kit } = await getKit();
  const { KitEventType } = (await import(
    "@creit-tech/stellar-wallets-kit/types"
  )) as any;
  const setStore = useStellarWalletStore.getState().set;
  kit.on(KitEventType.STATE_UPDATED, (e: any) => {
    const addr = e?.payload?.address ?? null;
    setStore((s) => {
      s.address = addr;
      s.connected = !!addr;
    });
  });
  kit.on(KitEventType.DISCONNECT, () => {
    setStore((s) => {
      s.address = null;
      s.connected = false;
      s.walletId = null;
      s.walletKind = null;
      s.networkError = null;
    });
  });
  // Track which wallet the user picked in the modal, for the masthead label.
  const idToKind: Record<string, string> = Object.fromEntries(
    Object.entries(idByKind).map(([k, v]) => [v, k])
  );
  kit.on(KitEventType.WALLET_SELECTED, (e: any) => {
    const id = e?.payload?.id ?? null;
    setStore((s) => {
      s.walletId = id;
      if (id && idToKind[id]) s.walletKind = idToKind[id];
    });
  });
  window.addEventListener("focus", () => {
    if (network !== MAINNET && useStellarWalletStore.getState().connected)
      assertNetwork().catch(() => {});
  });
  await checkRestoredSession();
}

// The kit restores the last session from localStorage (shared with the mainnet
// Builder on this origin), and its STATE_UPDATED / WALLET_SELECTED handlers fire
// on subscribe, so a restored session skips connectWallet's network check.
// Drop a wallet this network does not offer; otherwise check the network now.
async function checkRestoredSession(): Promise<void> {
  const { connected, walletId } = useStellarWalletStore.getState();
  if (network === MAINNET || !connected) return;
  if (!network.wallets.some((kind) => idByKind[kind] === walletId)) await disconnectWallet();
  else await assertNetwork().catch(() => {});
}

// Compare the wallet's reported passphrase with the page's network and record
// a mismatch in the store. Throws on mismatch so callers cannot sign.
export async function assertNetwork(): Promise<void> {
  const { kit } = await getKit();
  const setStore = useStellarWalletStore.getState().set;
  // xBull rejects getNetwork(); signTx still pins the passphrase for it.
  if (useStellarWalletStore.getState().walletId === idByKind.xBull) {
    setStore((s) => {
      s.networkError = null;
    });
    return;
  }
  let error: string | null = null;
  try {
    const { networkPassphrase } = await kit.getNetwork();
    if (networkPassphrase !== network.passphrase)
      error = `Wallet network mismatch: switch your wallet to ${network.label} ("${network.passphrase}") before signing.`;
  } catch (err: any) {
    error = `Could not read the wallet's network (${err?.message || String(err)}); signing is blocked.`;
  }
  setStore((s) => {
    s.networkError = error;
  });
  if (error) throw new Error(error);
}

// Sign a transaction XDR with the connected wallet, always on the page's
// network passphrase and only after the wallet's network has been checked.
// A transaction built for another network than the page's is refused.
export async function signTx(xdr: string, passphrase: string = network.passphrase): Promise<string> {
  if (passphrase !== network.passphrase)
    throw new Error(`This page signs on ${network.label} only; a transaction for "${passphrase}" was refused.`);
  const address = useStellarWalletStore.getState().address;
  if (!address) throw new Error("Connect a wallet before signing.");
  await assertNetwork();
  const { kit } = await getKit();
  try {
    const { signedTxXdr } = await kit.signTransaction(xdr, { networkPassphrase: network.passphrase, address });
    return signedTxXdr;
  } catch (err: any) {
    const msg = (err?.message || String(err) || "").toLowerCase();
    if (msg.includes("reject") || msg.includes("denied") || msg.includes("cancel") || msg.includes("declined"))
      throw new Error("Signature request was rejected in the wallet. Nothing was submitted.");
    throw new Error(err?.message || "The wallet could not sign the transaction.");
  }
}

export async function connectWallet(_kind?: string): Promise<string> {
  const setStore = useStellarWalletStore.getState().set;
  setStore((s) => {
    s.connecting = true;
    s.error = null;
  });
  try {
    const { kit } = await getKit();
    // Open the kit's auth modal. It lists the configured wallets and drives the
    // wallet's requestAccess from its OWN in-modal click gesture — the reliable
    // connect path. (A direct setWallet+fetchAddress loses the user gesture, so
    // Freighter rejects with "Getting the address ... is not allowed, please
    // request access first.") WALLET_SELECTED/STATE_UPDATED keep the store synced.
    const { address } = await kit.authModal();
    setStore((s) => {
      s.address = address;
      s.connected = true;
      s.connecting = false;
      s.error = null;
    });
    // The mismatch stays in the store as a banner; signTx re-checks.
    if (network !== MAINNET) await assertNetwork().catch(() => {});
    return address;
  } catch (err: any) {
    const msg = String((err && err.message) || err || "");
    setStore((s) => {
      s.connecting = false;
      // User dismissing the modal is not an error worth shouting about.
      s.error = /closed the modal/i.test(msg) ? null : friendlyError(err, "wallet");
    });
    throw err;
  }
}

export async function disconnectWallet(): Promise<void> {
  try {
    const { kit } = await getKit();
    await kit.disconnect();
  } catch {
    // ignore — we clear local state regardless
  }
  useStellarWalletStore.getState().set((s) => {
    s.address = null;
    s.connected = false;
    s.walletId = null;
    s.walletKind = null;
    s.connecting = false;
    s.error = null;
    s.networkError = null;
  });
}

function friendlyError(err: any, kind: string): string {
  const msg = (err?.message || String(err) || "").toLowerCase();
  if (msg.includes("reject") || msg.includes("denied") || msg.includes("cancel"))
    return `${kind} connection was rejected.`;
  if (msg.includes("not available") || msg.includes("not installed") || msg.includes("missing"))
    return `${kind} is not available — is the wallet installed?`;
  return err?.message || `Could not connect ${kind}.`;
}
