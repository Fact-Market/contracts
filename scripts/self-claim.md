# Self-Claim Toolkit

Claim your trade payouts (or refunds) directly from the escrow contract — **without the Fact Market website or backend**. This is the user-facing safety net for the non-custodial architecture: if `fact.market` is unavailable, this script lets you recover your funds using your exported receipt file and your TON wallet mnemonic.

The escrow contract verifies the Ed25519 signature on your receipt and doesn't care who sends the transaction. Funds always go to the address encoded in the receipt, so even if a third party submits on your behalf, the payout is yours.

## You need

- Your exported receipt file (`factmarket-receipts-*.json`).
- Your TON wallet's 24-word mnemonic (for gas only).
- Node.js 18+ and pnpm 9+.

## Step 1 — Export receipts (while the site is still up)

1. Open [fact.market/claim/manual](https://fact.market/claim/manual).
2. Connect your wallet.
3. Click **Recover from Server**, then **Export All** to download a `factmarket-receipts-*.json` file. Save it somewhere safe.

You can also download per-trade receipts right after opening a position. Keep the file private — a third party who gets it could race you to submit and pay the gas, though the payout still goes to your address.

## Step 2 — Get the script

```bash
git clone https://github.com/Fact-Market/contracts.git
cd contracts
pnpm install
```

## Step 3 — Verify (read-only, no mnemonic)

```bash
pnpm claim:verify path/to/receipts.json
```

Shows which receipts are claimable, refundable, already claimed, or lost, plus expected payout amounts. Read-only — no transactions, no mnemonic.

## Step 4 — Claim

```bash
pnpm claim:run path/to/receipts.json
```

Prompts for your 24-word mnemonic (input is hidden, never stored, never transmitted). For each eligible receipt, sends a claim or refund transaction and waits for on-chain confirmation. Gas: ~0.1 TON per transaction.

### Flags

```bash
--receipt 42                  # only this nonce
--network testnet             # testnet contracts
--api-key YOUR_TONCENTER_KEY  # higher rate limits
```

## Security

- Mnemonic never leaves your computer — the script signs locally, same as a wallet app.
- The script is a single open-source file ([`self-claim.ts`](./self-claim.ts)) with no hidden network calls (TonCenter RPC only). Read it before running.
- Receipts prove a trade but cannot redirect funds — the `userAddress` in the signature is the only address that can receive payout.

## Verifying the contract

The escrow address is embedded in each receipt as `contractAddress`. Open it on [tonscan.org](https://tonscan.org/) or [tonviewer.com](https://tonviewer.com/) and compare the on-chain bytecode to a local build of [`../contracts/MarketEscrow.tact`](../contracts/MarketEscrow.tact) at the tag listed in [`../deployments/mainnet.json`](../deployments/mainnet.json).

## Receipt format

```json
{
  "version": 1,
  "userAddress": "UQ...",
  "receipts": [
    {
      "signature": "base64-ed25519-sig",
      "nonce": 1,
      "userAddress": "UQ...",
      "contractAddress": "EQ...",
      "marketId": "clx123abc",
      "outcome": 1,
      "amount": "1000000000",
      "question": "Will BTC reach $100k by June 2026?",
      "timestamp": 1710500000000,
      "backendPublicKey": "hex..."
    }
  ]
}
```

`outcome` is `1=YES` / `2=NO`. `amount` is in nanotons (1 TON = 10⁹ nanotons). See [`../docs/ed25519-receipts.md`](../docs/ed25519-receipts.md) for the signature spec.

## Troubleshooting

- **Error querying contract** — RPC is rate-limited or down. Retry, or pass `--api-key`.
- **Insufficient balance** — wallet needs ~0.1 TON per receipt for gas.
- **Invalid mnemonic** — must be exactly 24 words, same as your wallet app.
- **Already claimed** — this receipt was already processed on-chain.
- **Market not yet resolved** — oracle hasn't set the outcome. Check back later.
