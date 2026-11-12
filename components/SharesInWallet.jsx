// Vault shares are a SEP-41 token implemented by the vault contract, not a
// classic asset, so a wallet lists them only once the contract is added as a token.
export default function SharesInWallet({ net }) {
  return <div role="note" className="execution-quote" data-note="shares-in-wallet">
    <strong>Your vault shares in your wallet</strong>
    <span>The vault shares are a Soroban token issued by the vault contract, not a classic Stellar asset, so your wallet may not list them on its own. To see them, add a token in your wallet (in Varial: + Add token) with the vault's contract address:</span>
    <span className="data-note">{net.vault}</span>
  </div>;
}
