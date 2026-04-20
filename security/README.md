# Security

## Posture

Fact Market v1 contracts are **live on TON mainnet without an independent third-party audit.** The pre-mainnet review was internal:

- **Misti** static analysis (v0.9.x) — currently **clean** (no findings). Three Soufflé-backed detectors (`DivideBeforeMultiply`, `ReadOnlyVariables`, `UnboundLoop`) are skipped because Soufflé is not installed in the standard dev environment; these will be run as part of the v2 external audit. Earlier gas-optimization hints (`SuboptimalSend`, `PreferredStdlibApi`, `PreferBinaryReceiver`) were addressed during pre-mainnet cleanup and no longer trigger.
- **AI-assisted code review** — covered access control, send modes, signature/crypto, nonce/replay, arithmetic, state machines, storage, admin surface.
- **155-test sandbox suite** including adversarial cases: cross-contract signature replay, rotated-key replay, double-claim, pool insolvency, deploy-registration atomicity, emergency cancel, fund-lock edges.

An **independent third-party audit is scheduled** before the v2 (jetton-custody) deployment. Scope will include a full v1 re-review, the new jetton-custody code paths, multi-hop gas budgets, and wrong-jetton / bounce-recovery edges.

## What this is not

The internal review is not a substitute for a human specialist auditor. Static analyzers catch known anti-patterns, not novel logic bugs. AI-assisted review is pattern-thorough but cannot reason about economic incentives the way a specialist can. Adversarial tests cover the attacks we thought of.

If you are making a custody decision larger than a comfortable loss, factor in the absence of an external audit.

## Findings

| ID  | Severity | Status       | Title                                            |
| --- | -------- | ------------ | ------------------------------------------------ |
| 001 | HIGH     | Fixed        | Fund lock on zero-winning-side trades            |
| 002 | HIGH     | Fixed        | Phantom markets via `SendIgnoreErrors` on deploy |
| 003 | MEDIUM   | Accepted     | Instant backend key rotation                     |
| 004 | MEDIUM   | Fixed        | Factory `WithdrawFees` used `SendIgnoreErrors`   |
| 005 | MEDIUM   | Fixed        | `updateMinBet` used `context().value`            |
| 006 | LOW      | Accepted     | No timelocks or multisig on admin operations     |
| 007 | INFO     | Acknowledged | Deposit `context().value` includes forwarded gas |

**001 — Fund lock on zero-winning-side trades.** If a market resolved YES with `totalYes == 0` (or NO with `totalNo == 0`), pool funds would have been permanently stranded — the claim path was blocked by the `winningTotal > 0` guard and the refund path was blocked because the market was resolved, not cancelled. Fixed by auto-cancelling the resolution when the winning side has zero recorded trades, which unlocks the refund path.

**002 — Phantom markets on deploy failure.** `MarketFactory.DeployMarketEscrow` used `mode: SendIgnoreErrors`. A failed deploy would leave the escrow address registered in the factory maps, creating broken entries. Fixed by switching to the default send mode so the whole transaction reverts on failure.

Fixes 004 and 005 followed the same pattern — removed `SendIgnoreErrors` from admin paths, and replaced the text-comment `"updateMinBet"` receiver with a typed `UpdateMinBet` message carrying an explicit `newMinBet` field.

## Bytecode verification

Contracts compiled with `@tact-lang/compiler ^1.6.13`. To verify the deployed bytecode:

```bash
git checkout <tag>         # tag from deployments/mainnet.json
pnpm install && pnpm build
sha256sum build/MarketFactory_MarketFactory.code.boc   # compare to bytecodeHash
```

## Responsible disclosure

Email **security@fact.market**. Do not open public GitHub issues for security reports, and do not test exploits against mainnet — use the testnet contracts in [`../deployments/testnet.json`](../deployments/testnet.json) or the sandbox test suite. We acknowledge within 48 hours. Full policy in [`disclosure.md`](./disclosure.md).
