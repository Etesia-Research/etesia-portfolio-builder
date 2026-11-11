"use client";

import dynamic from "next/dynamic";

// The vault desk talks to the wallet kit and RPC from the browser only.
const VaultDesk = dynamic(() => import("@/components/VaultDesk"), {
  ssr: false,
  loading: () => <div id="root"><p role="status" className="data-banner">Loading the vault…</p></div>,
});

export default function VaultDeskLoader({ slug, network }) {
  return <VaultDesk slug={slug} network={network} />;
}
