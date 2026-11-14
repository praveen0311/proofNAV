# ProofNAV NEAR contract

Rust contract module for the ProofNAV hackathon prototype.

## What it implements
- NEP-141 fungible token core, NEP-145 storage management and NEP-148 metadata via `near-contract-standards`.
- Append-only NAV records with sequence, timestamp, NAV, NAV/share, share supply, Merkle root and snapshot hash.
- Separate approver and publisher roles. The approver signs off on an exact hash; publisher can publish only that hash.
- Publication requires `MATCHED` reconciliation and exact match with the contract's current NEP-141 total supply.
- NEP-297 `proofnav` events.
- Owner pause, role rotation, and prototype mint/burn methods.

## Build and test
Install Rust 1.93+ and the wasm target:
```bash
rustup target add wasm32-unknown-unknown
cargo test
cargo build --target wasm32-unknown-unknown --release
```
The exact SDK versions are pinned by the Cargo semver constraints; commit `Cargo.lock` after the first successful build.

## Important design boundary
The contract commits to a snapshot; it does not independently verify the off-chain valuation, custody statement or Merkle leaf truth. A matching Merkle root proves membership in a committed dataset, not asset ownership or fair value.

## MVP constraints
- History is capped at 500 records to bound state growth. Add pagination backed by a persistent map before production.
- `nav_minor_units` is cents for USD in the demo; `nav_per_share` uses a fixed 1e8 scale. Document the scale in the UI and API.
- Initial supply is minted to one initial holder at initialization. Owner mint/burn are demo controls and must be replaced by a subscription/redemption policy and transfer eligibility controls for a permissioned fund.
- The current implementation is not audited and is not production-ready.
