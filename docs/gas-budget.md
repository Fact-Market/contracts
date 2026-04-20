# Gas Budget

Observed on mainnet at Tact `^1.6.13`. Costs will drift slightly between Tact releases and with map growth.

## Per-operation gas

| Operation                          | Caller-attached         | Consumed   | Notes                                       |
| ---------------------------------- | ----------------------- | ---------- | ------------------------------------------- |
| `MarketFactory.DeployMarketEscrow` | ~0.15 TON               | ~0.08 TON  | 0.05 forwarded to new escrow, rest refunded |
| `MarketEscrow` deploy (initial)    | 0.05 TON from factory   | ~0.02 TON  | Escrow keeps remainder as storage reserve   |
| `MarketEscrow.Deposit`             | trade amount + 0.03 TON | ~0.01 TON  | Excess kept in pool                         |
| `MarketFactory.RecordBet`          | 0.03 TON                | ~0.02 TON  | 0.01 forwarded to escrow                    |
| `MarketEscrow.ResolveMarket`       | 0.05 TON                | ~0.015 TON | Cashback to oracle                          |
| `MarketEscrow.ClaimWinnings`       | 0.1 TON                 | ~0.03 TON  | Cashback to claim sender                    |
| `MarketEscrow.RefundDeposit`       | 0.1 TON                 | ~0.025 TON | Cashback to refund sender                   |
| `MarketEscrow.WithdrawFees`        | 0.05 TON                | ~0.015 TON | Forwarded through factory                   |
| `MarketEscrow.DrainBalance`        | 0.05 TON                | ~0.02 TON  | Post-settlement recovery                    |

Operations touching `deposits` or `claimedNonces` grow in cost as those maps grow.

## Storage and minimum balance

Three maps grow with usage:

- `MarketEscrow.deposits` — one entry per unique depositor; decremented on claim/refund, deleted at zero.
- `MarketEscrow.claimedNonces` — one entry per claim or refund, never pruned (deletion would enable double-spend).
- `MarketFactory.markets` + `escrowAddresses` — two entries per deployed market, never pruned.

All critical handlers keep `myBalance() >= ton("0.01")` so storage rent cannot deactivate the account after a drain.

## Known behaviors

- **`Deposit` uses `context().value`** — includes forwarded gas, inflating `totalPool` by a few nanotons per deposit. Consistent across all users; winners receive fractionally more than theoretical share. Finding 007-INFO.
- **257-bit integer math** — no overflow risk at realistic pool sizes.

## v2

Jetton-custody v2 will add multi-hop sends for fee and payout flows. Gas budget will be re-profiled as part of the v2 external audit.
