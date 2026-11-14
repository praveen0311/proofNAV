# ProofNAV — Verifiable Institutional DeFi Vaults

**Hackathon track: 01 / DFI — Unstoppable DeFi**  
**Demo scope: end-to-end vault workflow, with verifiable NAV as the differentiator.**

ProofNAV is a prototype vault control plane for tokenized portfolios. It calculates NAV per share from portfolio positions, reconciles accounting quantities against custody records and share supply, freezes a deterministic snapshot, and provides a NEAR smart-contract design for approval and publication of the committed NAV. The demo uses synthetic assets and balances.

## Product thesis

A vault share token is not enough for institutional adoption. Investors and operators also need a repeatable valuation process, asset/custody reconciliation, explicit approval controls, and a tamper-evident record of each published NAV. ProofNAV makes those controls visible and independently verifiable.

## Architecture

- **Backend:** Node.js, TypeScript, Express, SQLite in-memory, decimal.js.
- **Valuation:** quantity × approved price + separately supplied accrued income − liabilities.
- **Integrity:** canonical JSON, SHA-256 snapshot hash, Merkle root over position/liability leaves.
- **Controls:** share-supply and custody checks; approval blocked unless all checks are `MATCHED`.
- **NEAR contract:** Rust / near-sdk, NEP-141 fund-share token, separate approver and publisher, append-only NAV history, hash approval and publication checks.
- **Frontend:** React, Vite, Recharts; the dashboard reads published NAV, token supply, roles, and token metadata directly from the configured NEAR contract. It does not display the backend's synthetic portfolio data.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
cd frontend
npm install
npm run dev
```

Dashboard: `http://localhost:5173`.

The backend API is not required to run the dashboard.

The dashboard defaults to `blockmintlabs.testnet` on NEAR testnet. To point it at another deployed contract, create `frontend/.env.local`:

```env
VITE_NEAR_CONTRACT_ID=your-contract.testnet
VITE_NEAR_NETWORK=testnet
```

The dashboard uses public FastNEAR RPC view calls and is read-only. The contract does not expose underlying portfolio positions, prices, liabilities, or custody balances; those are not shown. Valuation creation and approval/publication transactions are not wired to the dashboard.

## Demo workflow

The backend API still supports a separate synthetic-data workflow for local development. It is not used by the dashboard and does not publish to NEAR. The dashboard displays only data returned by the configured contract's read methods.

## Important integrity design

The snapshot hash is finalized **after** reconciliation, because reconciliation status is part of the committed payload. Approval recomputes the hash and refuses to proceed if the stored payload no longer matches the commitment. This avoids committing `INCOMPLETE` and then mutating the committed status to `MATCHED` without changing the hash.

## NEAR contract

Source: `contracts/proofnav/`.

```bash
cd contracts/proofnav
cargo test
cargo build --target wasm32-unknown-unknown --release
```

The contract source provides a NEP-141 share token, role-separated snapshot approval and NAV publication, supply matching, and append-only NAV history. The token uses exactly 8 decimals: 1,000,000 whole shares are represented as `100000000000000` base units. NAV minor units are USD cents; NAV/share uses USD × 1e8. The contract checks that the submitted NAV/share is mathematically consistent with NAV and total share supply.

Run the following from `contracts/proofnav` with Rust 1.95+ installed:

```bash
cargo test
cargo install cargo-near --locked
rustup target add wasm32-unknown-unknown
cargo near build non-reproducible-wasm --no-abi
```

A GitHub Actions workflow at `.github/workflows/ci.yml` runs the contract tests, WASM build, backend typecheck and frontend production build on pushes and pull requests.

**Build status in the authoring environment:** not executed because Rust/Cargo are not installed and outbound package downloads are unavailable. Do not deploy until CI passes and the generated WASM is reviewed. The dashboard reads the deployed testnet contract but does not submit transactions; the backend share-supply control remains synthetic and is not an on-chain read.

## Explicit prototype limitations

- All portfolio balances, prices, custody quantities and investor share supply are synthetic demo inputs.
- No live price oracle, custodian API, real tokenized bond contract or external portfolio data is connected.
- No deposit/withdrawal flow against underlying assets is implemented yet. Contract mint/burn are owner-controlled prototype operations, not a production subscription/redemption policy.
- No NEAR wallet connection or live transaction submission is wired into the dashboard; it currently reads contract views only.
- No NEAR Intents cross-chain settlement integration is wired yet.
- No authentication, role-based API authorization, independent key custody, audit, or production deployment is included.
- Hashes prove integrity of committed data, not the truth of source data, legal ownership, solvency, or regulatory compliance.

## Hackathon next steps

1. Install Rust and run contract tests; fix any SDK/API compilation issues.
2. Record the deployed testnet contract/account IDs and deployment transactions.
3. Add NEAR wallet connection and authorized contract transaction submission.
4. Wire NAV approval/publication to the approver and publisher roles in the contract.
5. Add a testnet deposit/redemption demonstration using clearly labelled mock assets or test tokens.
6. Investigate NEAR Intents integration for cross-chain funding/settlement; do not represent it as complete until transactions are demonstrated.
7. Add screenshots, demo video, LICENSE, and reproducible run instructions before submission.

## License

MIT (see `LICENSE`).
