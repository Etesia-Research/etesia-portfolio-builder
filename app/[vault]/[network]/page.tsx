import type { Metadata } from "next";
import { notFound } from "next/navigation";
import NetworkSwitch from "@/components/NetworkSwitch";
import VaultDeskLoader from "@/components/VaultDeskLoader";
import { NETWORKS, VAULTS, builderHref, findVault, isNetwork, vaultHref, type Network, type Vault } from "@/lib/vaults";

// Vault pages at /<vault slug>/<network>, from the registry in lib/vaults.ts.
// A network with a deployment gets the deposit desk on that network; one
// without gets the strategy and a disabled deposit. Anything else is a 404.
type Props = { params: Promise<{ vault: string; network: string }> };

export const dynamicParams = false;
export function generateStaticParams() {
  return VAULTS.flatMap((vault) => NETWORKS.map((network) => ({ vault: vault.slug, network })));
}

const LABELS: Record<Network, string> = { mainnet: "Mainnet", testnet: "Testnet" };

async function resolve(params: Props["params"]): Promise<{ vault: Vault; network: Network }> {
  const { vault: slug, network } = await params;
  const vault = findVault(slug);
  if (!vault || !isNetwork(network)) notFound();
  return { vault, network };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { vault, network } = await resolve(params);
  return { title: `${vault.name} · ${LABELS[network]} vault | Portfolio Atelier` };
}

export default async function VaultPage({ params }: Props) {
  const { vault, network } = await resolve(params);
  return vault.networks[network] ? <VaultDeskLoader slug={vault.slug} network={network} /> : <NotDeployed vault={vault} network={network} />;
}

// No manifest on this network: no contract to read and nothing to sign.
function NotDeployed({ vault, network }: { vault: Vault; network: Network }) {
  const state = `${LABELS[network]} vault not deployed yet`;
  return <div id="root">
    <div className="data-banner">{LABELS[network]} · {state} · no deposits · strategy returns are simulated</div>
    <header className="masthead">
      <div className="left">
        <div className="row"><a href={builderHref(network)}>← Portfolio Atelier</a></div>
        <div className="row" style={{ marginTop: 6 }}><NetworkSwitch active={network} href={(next: Network) => vaultHref(vault, next)} /></div>
        <div className="row" style={{ marginTop: 6 }}><span>Stellar {network} · no vault contract</span></div>
      </div>
      <div className="center">
        <div className="eyebrow">— Etesia Research Bulletin —</div>
        <h1>Portfolio Atelier</h1>
        <div className="sub">{vault.name} vault on Stellar {network}.</div>
      </div>
      <div className="right"><div className="vol">NOT DEPLOYED</div><div style={{ marginTop: 4 }}>—</div></div>
    </header>

    <div className="section-bar"><span className="num-mark">01</span><h2>Vault — {network} status</h2><span className="meta">No {network} manifest</span></div>
    <section className="execution-routes">
      <p role="status" className="vault-state">{state}</p>
      <p className="data-note">There is no {vault.name} vault contract on Stellar {network}: no address, share price, TVL or position to show, and nothing to sign.</p>
    </section>

    <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">02</span><h2>Strategy — simulated research</h2><span className="meta">Backtest, not vault results</span></div>
    <section className="execution-routes">
      <p className="vault-strategy">{vault.strategy}</p>
      <p><a className="factsheet-text-link" href={vault.factsheet}>Strategy factsheet and simulated backtest <span aria-hidden="true">↗</span></a></p>
    </section>

    <div className="section-bar" style={{ marginTop: 36 }}><span className="num-mark">03</span><h2>Deposit</h2><span className="meta">Disabled · {state.toLowerCase()}</span></div>
    <section className="funding-panel">
      <div className="col">
        <h5>① Deposit USDC</h5>
        <div className="amount-block">
          <div className="amount-input-wrap"><span className="pre">AMT</span><input type="text" placeholder="0.00" disabled aria-label="Deposit amount (disabled)" /><span className="unit">USDC</span></div>
          <button className="btn" disabled>Deposit unavailable</button>
        </div>
      </div>
      <div className="col"><p className="data-note">Deposits open on this page once the {vault.name} vault is deployed on Stellar {network}. Until then the Builder's allocation of the vault is simulated at $1 per share.</p></div>
    </section>
    <footer className="data-footer"><span>ETESIA RESEARCH</span><span>{vault.name} · Stellar {network} · {state.toLowerCase()} · simulated strategy research only</span></footer>
  </div>;
}
