import { produce } from "immer";
import { create } from "zustand";

// Wallet connection state, kept in sync with the Stellar Wallets Kit.
// Includes the wallet display kind, connection status, and errors.
export interface StellarWalletState {
  address: string | null;
  connected: boolean;
  walletId: string | null; // kit module id (e.g. VARIAL_ID)
  walletKind: string | null; // display name shown on the connect card
  connecting: boolean;
  error: string | null;
  networkError: string | null; // wallet on a different network than the page
  set: (fn: (s: StellarWalletState) => void) => void;
}

const useStellarWalletStore = create<StellarWalletState>((set) => ({
  address: null,
  connected: false,
  walletId: null,
  walletKind: null,
  connecting: false,
  error: null,
  networkError: null,
  set: (fn) => set(produce(fn)),
}));

export default useStellarWalletStore;
