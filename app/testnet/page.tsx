"use client";

import dynamic from "next/dynamic";

// The testnet vault page talks to the wallet kit and RPC from the browser only.
const TestnetVault = dynamic(
  () => import("@/components/TestnetVault"),
  { ssr: false, loading: () => null }
);

export default function Page() {
  return <TestnetVault />;
}
