"use client";

// Stellar Wallets Kit v2 integration (browser-only).
//
// doc-checked: bundled type defs in @creit-tech/stellar-wallets-kit@2.2.0
//   (_dist/sdk/kit.d.ts, _dist/types/mod.d.ts, _dist/sdk/modules/*.d.ts) +
//   README + https://stellarwalletskit.dev. The kit is a static singleton:
//   init({modules}) once, setWallet(id) to pick a wallet, fetchAddress() to
//   prompt it, on(KitEventType.*) for state changes, disconnect().
//
// Per-wallet connect (Etesia's 4 cards map to specific wallets) =
//   setWallet(ID) -> fetchAddress(). Network is mainnet (Networks.PUBLIC); it
//   only matters for signing (we don't sign — execution stays simulated), but
//   we set it for correctness.
//
// All kit imports are dynamic so nothing touches `window` until called in the
// browser (the builder is already rendered ssr:false, this is belt-and-braces).

import useStellarWalletStore from "@/stores/useStellarWalletStore";

// Display name on Etesia's connect cards -> resolved at load time to kit ids.
export const WALLET_KINDS = ["Freighter", "Albedo", "xBull", "Lobstr Vault"] as const;
export type WalletKind = (typeof WALLET_KINDS)[number];

let kitPromise: Promise<{ kit: any }> | null = null;
let idByKind: Record<string, string> = {};
let subscribed = false;

async function loadKit(): Promise<{ kit: any }> {
  const [sdk, types, fre, alb, xb, lob] = await Promise.all([
    import("@creit-tech/stellar-wallets-kit/sdk"),
    import("@creit-tech/stellar-wallets-kit/types"),
    import("@creit-tech/stellar-wallets-kit/modules/freighter"),
    import("@creit-tech/stellar-wallets-kit/modules/albedo"),
    import("@creit-tech/stellar-wallets-kit/modules/xbull"),
    import("@creit-tech/stellar-wallets-kit/modules/lobstr"),
  ]);
  const { StellarWalletsKit } = sdk as any;
  const { Networks } = types as any;

  idByKind = {
    Freighter: (fre as any).FREIGHTER_ID,
    Albedo: (alb as any).ALBEDO_ID,
    xBull: (xb as any).XBULL_ID,
    "Lobstr Vault": (lob as any).LOBSTR_ID,
  };

  // Exactly the four wallets Etesia offers — all config-free, so the connect
  // screen only lists wallets the kit can actually connect.
  StellarWalletsKit.init({
    modules: [
      new (fre as any).FreighterModule(),
      new (alb as any).AlbedoModule(),
      new (xb as any).xBullModule(),
      new (lob as any).LobstrModule(),
    ],
  });
  StellarWalletsKit.setNetwork(Networks.PUBLIC);
  return { kit: StellarWalletsKit };
}

function getKit() {
  if (!kitPromise) kitPromise = loadKit();
  return kitPromise;
}

// Subscribe the zustand store to kit state changes (account switch, disconnect
// triggered from inside the wallet, etc.). Idempotent across re-mounts.
export async function initWalletKit(): Promise<void> {
  if (subscribed) return;
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
