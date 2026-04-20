# Security Policy

## Reporting a vulnerability

Please **do not open a public GitHub issue** for security reports. This repo is public and the report would be indexed before we can respond.

Email **security@fact.market** with a description, affected contract and function, and a reproducer (a sandbox test from [`tests/`](./tests/) is preferred).

We acknowledge within 48 hours.

## Full policy and scope

See [`security/disclosure.md`](./security/disclosure.md) for the complete responsible-disclosure policy, in-scope and out-of-scope items, and expectations around coordinated disclosure.

## Security posture

The v1 contract set is live on TON mainnet with internal-review + automated-tooling coverage only — **no independent third-party audit has been performed on v1**. An external audit is scheduled before the v2 (jetton-custody) deployment.

See [`security/README.md`](./security/README.md) for the full posture, the February 2026 internal review, and the Misti static-analysis output.
