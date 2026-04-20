# Architecture

Hybrid on-chain / off-chain: funds custodied on-chain in `MarketEscrow`, individual trades recorded off-chain and carried by Ed25519-signed receipts the escrow verifies on claim.

## Why hybrid

- **Trust:** users can always reach their funds via the escrow. The backend cannot prevent a valid claim — only refuse to issue a receipt, which is a UX failure, not theft.
- **Cost:** one deposit per user covers many trades. No per-trade on-chain write.
- **Resolution:** fully on-chain. Oracle (public) or creator (private) submits a single message; payout logic is in-contract.

## Trust properties

| Property                  | Mechanism                                                 |
| ------------------------- | --------------------------------------------------------- |
| Funds custodied on-chain  | Held in `MarketEscrow`                                    |
| Trades provable           | Backend signs Ed25519 receipts                            |
| Claims trustless          | Contract verifies signature, computes payout in-contract  |
| No double-spend           | `claimedNonces` map, set before payout send               |
| Backend cannot steal      | No control over resolution or payout amounts              |
| Oracle cannot steal       | Only sets outcome; payout formula is fixed                |
| No fund lock on zero-side | Auto-cancels if winning side has zero recorded trades     |
| No-resolve failsafe       | `EmergencyCancel` — anyone cancels 30 days past `endTime` |

## Contracts

**`MarketEscrow`** — per-market escrow. Holds the pool, records per-outcome totals, stores the backend's Ed25519 verifying key, verifies receipts on claim, handles refunds and drain.

State: immutable config (`question`, `endTime`, `bettingClosesAt`, `minBet`, `feePercentage`); roles (`admin`, `oracle`, `creator`, `backendPubKey`); resolution (`resolved`, `winningOutcome` — 0 unresolved, 1 YES, 2 NO, 3 CANCEL); pool (`totalPool`, `totalYes`, `totalNo`); tracking (`claimedNonces`, `deposits`, `feesWithdrawn`, `totalPaidOut`).

**`MarketFactory`** — admin-only deploys. Forwards admin operations (key rotation, fee withdrawal, drain) to specific escrows as the escrow admin.

**`PrivateMarketFactory`** — permissionless. Anyone deploys by paying a creation fee. Same `MarketEscrow` but with `creator = msg.sender`, which enables `CreatorResolve`.

## Flow

1. Factory deploys `MarketEscrow`.
2. User deposits TON into the escrow; backend indexes the deposit.
3. User opens a trade; backend signs a receipt and calls `RecordBet` on the factory, which forwards `RecordBetOnEscrow` to the escrow to update per-outcome totals.
4. After `endTime`, oracle sends `ResolveMarket` (public) or creator sends `CreatorResolve` (private). Auto-cancel kicks in if the chosen winning side has zero trades.
5. Winner submits their receipt to `ClaimWinnings`. Escrow verifies signature, computes pro-rata share, sends payout to the address encoded in the receipt.
6. If cancelled, depositors submit receipts to `RefundDeposit` instead.

## Outcomes

- **YES (1)** — YES trades split pool minus fee, pro-rata.
- **NO (2)** — mirror.
- **CANCEL (3)** — all depositors refund their full deposit; no fee.

CANCEL can be set explicitly, forced by auto-cancel (zero winning side), or triggered by `EmergencyCancel` 30 days past `endTime`.

## Claim window and drain

Users have 90 days post-resolution to claim. After that, admin can `DrainBalance` to recover leftover funds provided either:

- **(A)** all payouts settled (`totalPaidOut >= expectedPayout`), or
- **(B)** claim window expired (`now() >= endTime + 90 days`).

Path B prevents permanent lock if a user loses their key.

## Message opcodes

Every message has an explicit opcode — see [`../contracts/imports/messages.tact`](../contracts/imports/messages.tact) for the full set. Key ones:

| Message                         | Opcode                      | Purpose                                        |
| ------------------------------- | --------------------------- | ---------------------------------------------- |
| `Deposit`                       | `0x4a25ce37`                | User deposit                                   |
| `ResolveMarket`                 | `0x0eb9c738`                | Oracle sets outcome                            |
| `CreatorResolve`                | `0xc3d4e5f6`                | Private-market creator sets outcome            |
| `EmergencyCancel`               | `0x56bd3ff8`                | Permissionless cancel after grace period       |
| `ClaimWinnings`                 | `0x7f8549fb`                | Claim with signed receipt                      |
| `RefundDeposit`                 | `0x6d763313`                | Refund with signed receipt (cancelled markets) |
| `DeployMarketEscrow`            | `0x918ff1ef`                | Factory admin deploy                           |
| `DeployPrivateMarketEscrow`     | `0xa1b2c3d4`                | Permissionless private deploy                  |
| `RecordBet`                     | `0x410bbfb6`                | Factory → escrow trade-totals forwarding       |
| `UpdateBackendKey`              | `0xfaa2b336`                | Rotate backend verifying key                   |
| `WithdrawFees`                  | `0x0350a2f4`                | Admin withdraws accumulated fees               |
| `DrainBalance`                  | `0xe4f5a6b7`                | Admin drains post-settlement                   |
| `TransferAdmin` / `AcceptAdmin` | `0x0dc797c9` / `0x5fd2daef` | Two-step admin transfer                        |

## See also

- [Ed25519 receipts](./ed25519-receipts.md) — signing, hash format, verification.
- [Gas budget](./gas-budget.md) — per-operation costs.
- [Security](../security/README.md) — findings, remediations, v2 plan.
