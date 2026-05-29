"use client";

import dynamic from "next/dynamic";

// The portfolio builder is fully client-side (wallet kit, window, Date()).
// Render it with ssr:false so no browser-only code runs during SSR.
const PortfolioBuilder = dynamic(
  () => import("@/components/PortfolioBuilder"),
  { ssr: false, loading: () => null }
);

export default function Page() {
  return <PortfolioBuilder />;
}
