# Fact Market — Contracts

Open-source Tact smart contracts powering [Fact Market](https://fact.market), a non-custodial binary prediction market on TON delivered as a Telegram Mini App. Deployed on TON mainnet in April 2026.

- Production: https://fact.market · Demo (testnet): https://demo.fact.market · X: [@FactMarketX](https://x.com/FactMarketX)
- Deployed addresses + bytecode hash: [`deployments/mainnet.json`](./deployments/mainnet.json), [`deployments/testnet.json`](./deployments/testnet.json)

Frontend, backend, and operational infrastructure live in a separate private repo.

## Contracts

| Contract               | Purpose                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MarketFactory`        | Deploys `MarketEscrow` instances for public (admin-curated) markets. Tracks oracle, backend key, fee config, market registry.                                                                                    |
| `MarketEscrow`         | One per market. Custodies user deposits. Verifies Ed25519 trade receipts on claim, pays claims and refunds, handles resolution (YES / NO / CANCEL). Auto-cancels when the winning side has zero recorded trades. |
| `PrivateMarketFactory` | Permissionless user-created markets with a creation fee. Same `MarketEscrow` but with `creator = msg.sender` so the creator can resolve their own market.                                                        |

## Architecture

Binary prediction markets with pool-based parimutuel settlement. The escrow custodies funds on-chain; individual trades are recorded off-chain and carried by Ed25519-signed receipts the escrow verifies on claim. Users always retain non-custodial access — anyone holding a valid receipt can claim independently of the backend (see [self-claim toolkit](./scripts/self-claim.md)).

1. Factory deploys a `MarketEscrow`.
2. Users deposit TON into the escrow.
3. Backend signs trade receipts bound to the escrow address, outcome, amount, market id, and nonce.
4. At resolution, the oracle (public) or creator (private) submits the outcome on-chain.
5. Users submit their receipt to `ClaimWinnings`; the escrow verifies signature, computes pro-rata share, pays out.
6. Safety nets: auto-cancel on zero-winning-side, permissionless `EmergencyCancel` 30 days after `endTime` if the oracle never resolves.

See [`docs/architecture.md`](./docs/architecture.md) for message shapes, opcodes, and operational flow. Receipt specifics in [`docs/ed25519-receipts.md`](./docs/ed25519-receipts.md). Gas reference in [`docs/gas-budget.md`](./docs/gas-budget.md).

## Security

v1 is live on mainnet **without a third-party audit** — pre-mainnet review was internal (Misti static analysis + AI-assisted code review + 155 sandbox tests). Two HIGH findings were remediated before deployment; three MEDIUM findings (two fixed, one accepted). An independent audit is scheduled before the v2 (jetton-custody) deployment.

Full posture, findings, and bytecode verification in [`security/README.md`](./security/README.md). Disclosure: **security@fact.market** — see [`SECURITY.md`](./SECURITY.md).

## Build & test

Requires Node 18+ and pnpm 9+. Tact compiler `^1.6.13`.

```bash
pnpm install
pnpm build          # compiles contracts → build/
pnpm test           # 155 tests, TON sandbox, no network
pnpm audit:static   # Misti
```

Tests cover: deposit + trade recording, claim with Ed25519 receipt, refund on cancellation, nonce replay protection, auto-cancel, oracle + creator resolution, emergency cancel, admin operations, attack surface (wrong-sender, rotated-key replay, pool insolvency, double-claim).

## Self-claim toolkit

Users can claim payouts directly from the contract without the frontend:

```bash
pnpm claim:verify path/to/receipts.json   # read-only, no mnemonic
pnpm claim:run    path/to/receipts.json   # signs and submits claims
```

Full guide: [`scripts/self-claim.md`](./scripts/self-claim.md).

## Exit codes

We use `throwUnless(code, condition)` instead of `require(condition, "message")` for gas efficiency. Off-chain tooling depends on the numeric codes being stable. To add a new error: add `require(condition, "msg")`, run `pnpm build`, read the compiler-assigned code from the generated report in `build/`, then replace with `throwUnless(code, condition)`. Codes 256–65535 are free for developer use (0–255 reserved by TON/Tact).

## License

MIT. See [LICENSE](./LICENSE). Fact Market encourages ecosystem builders to study, fork, and adapt this work.
