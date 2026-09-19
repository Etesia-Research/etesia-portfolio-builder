import { create } from "zustand";
import { produce } from "immer";
import type { PriceInfo } from "@/lib/prices";

// Timestamped daily reference closes from the quant API.
export interface PriceState {
  bySymbol: Record<string, PriceInfo>;
  loading: boolean;
  error: string | null;
  lastUpdated: number | null; // epoch ms of last successful refresh
  set: (fn: (s: PriceState) => void) => void;
}

const usePriceStore = create<PriceState>((set) => ({
  bySymbol: {},
  loading: false,
  error: null,
  lastUpdated: null,
  set: (fn) => set(produce(fn)),
}));

export default usePriceStore;
