# Ed25519 Receipts

Trades are recorded off-chain and carried by Ed25519-signed receipts that the escrow verifies on claim. The backend holds the signing key; the public verifying key is stored in the escrow at deploy time.

## Receipt hash

```tact
fun computeBetHash(contractAddress, userAddress, nonce, outcome, amount, marketId): Int {
    let data = beginCell()
        .storeAddress(userAddress)
        .storeAddress(contractAddress)
        .storeUint(nonce, 64)
        .storeUint(outcome, 8)
        .storeCoins(amount)
        .storeSlice(marketId.asSlice())
        .endCell();
    return data.hash();
}
```

Backend signs the cell hash. User submits `ClaimWinnings` with `{nonce, userAddress, outcome, amount, marketId, signature}`. Escrow recomputes the hash using `myAddress()` and `msg.userAddress`, then calls `checkSignature(hash, signature, self.backendPubKey)`.

Refund receipts use `computeRefundHash` — identical except the `outcome` byte is always `0`. Distinct hash space prevents cross-replay between claim and refund for the same nonce.

## Security properties

- **Contract-scoped:** `myAddress()` is part of the signed data. A receipt for escrow A cannot be replayed on escrow B. Tested in [`../tests/security.spec.ts`](../tests/security.spec.ts).
- **Defense-in-depth against key compromise:** claim amount is also checked against `deposits[userAddress]`. A compromised backend key cannot forge receipts for users who never deposited, or over-claim from users who did. Each claim decrements the per-user deposit.
- **Nonce replay protection:** `claimedNonces[nonce] = true` is set **before** sending the payout. Default send mode means a failed send reverts the entire transaction including the nonce write.
- **Shared nonce space for claims and refunds:** backend allocates disjoint ranges (recommended: `0x1` prefix for claims, `0x2` for refunds).
- **Rotated-key invalidation:** after `UpdateBackendKey`, receipts signed with the old key no longer verify. Unclaimed receipts must be re-signed. See finding 003 in [`../security/README.md`](../security/README.md).

## Test coverage

Valid signature accepted; wrong signature / wrong user / wrong escrow rejected (hash mismatch); already-claimed nonce rejected; rotated-key receipt rejected; claim exceeding user deposit rejected; trade receipt replayed as refund rejected.
