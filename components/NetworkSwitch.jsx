import { NETWORKS } from "@/lib/vaults";

const LABELS = { mainnet: 'Mainnet', testnet: 'Testnet' };

// Mainnet | Testnet mode switch. Each mode is a real link, so every view has a
// shareable URL; onSelect (Builder only) switches without reloading.
export default function NetworkSwitch({ active, href, onSelect = null }) {
  return <nav className="network-switch" aria-label="Network mode">
    {NETWORKS.map(network => <a key={network} href={href(network)} aria-current={network === active ? 'page' : undefined}
      onClick={onSelect ? (event) => { event.preventDefault(); onSelect(network); } : undefined}>{LABELS[network]}</a>)}
  </nav>;
}
