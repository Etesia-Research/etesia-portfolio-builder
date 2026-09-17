import { create } from "zustand";
import { produce } from "immer";

// Live wallet holdings (Horizon mainnet), refreshed by polling in
// PortfolioBuilder while a wallet is connected. byTk maps every universe
// ticker to the connected account's real balance (0 when unheld).
export interface BalanceState {
  address: string | null;
  byTk: Record<string, number>;
  loading: boolean;
  error: string | null;
  lastUpdated: number | null; // epoch ms of last successful refresh
  set: (fn: (s: BalanceState) => void) => void;
}

const useBalanceStore = create<BalanceState>((set) => ({
  address: null,
  byTk: {},
  loading: false,
  error: null,
  lastUpdated: null,
  set: (fn) => set(produce(fn)),
}));

export default useBalanceStore;
