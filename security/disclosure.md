# Responsible Disclosure

Email **security@fact.market** with:

- A clear description of the vulnerability.
- Affected contract and function.
- A reproducer — a sandbox test is ideal; a message sequence is the minimum.
- Your preferred contact.
- Whether you want public credit post-fix.

## Don't

- Open a public GitHub issue for security reports. This is a public repo; issues are indexed before we can respond.
- Test exploits against mainnet contracts holding real user funds. Use [testnet contracts](../deployments/testnet.json) or the sandbox test suite.
- Exfiltrate funds as proof of concept. A sandbox reproducer is sufficient.

## Expect

- **Acknowledgement** within 48 hours.
- **Triage response** within 5 business days with in-scope classification and rough fix timeline.
- **Coordinated disclosure** after the fix lands and affected users are migrated.
- **Credit** on request. We won't publish your identity without consent.

## Scope

In scope: `contracts/*.tact`, `contracts/imports/messages.tact`, and the deployed bytecode at the addresses in [`../deployments/mainnet.json`](../deployments/mainnet.json) / [`../deployments/testnet.json`](../deployments/testnet.json).

Out of scope: frontend / backend / infra (report via the same email; routed separately); DoS via gas exhaustion where attacker cost exceeds ours; third-party dependency issues (report upstream); social engineering and key-compromise scenarios.

## Bug bounty

No formal program yet — planned alongside the v2 jetton-custody audit. Good-faith reports before then will be acknowledged and credible reporters will be made whole; contact us.
