export type PriceInfo = {
  price: number | null;
  ts: string | null;
  stale: boolean;
  reason: string | null;
};

export function referenceValue(prices: Record<string, PriceInfo>, symbol: string, quantity: number): number | null {
  const price = prices[symbol]?.price;
  return price != null && Number.isFinite(quantity) ? price * quantity : null;
}

export function fundingValue(prices: Record<string, PriceInfo>, symbol: string, quantity: number): number | null {
  const source = prices[symbol];
  const usdc = prices.USDC;
  if (!source || !usdc || source.stale || usdc.stale || !source.ts || source.ts !== usdc.ts ||
      source.price == null || source.price <= 0 || usdc.price == null || usdc.price <= 0 || !Number.isFinite(quantity) || quantity <= 0) return null;
  return quantity * source.price / usdc.price;
}
