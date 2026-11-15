# ProofNAV — Verifiable Institutional DeFi Vaults

**Hackathon track: 01 / DFI — Unstoppable DeFi**  
**Demo scope: end-to-end vault workflow, with verifiable NAV as the differentiator.**

ProofNAV is a prototype vault control plane for tokenized portfolios. It calculates NAV per share from portfolio positions, reconciles accounting quantities against custody records and live share supply, freezes a deterministic snapshot, and provides a NEAR smart-contract flow for approval and publication of the committed NAV. NAV inputs are entered manually and are not independently verified; the screenshot mode uses separate illustrative sample data.

## Product thesis

A vault share token is not enough for institutional adoption. Investors and operators also need a repeatable valuation process, asset/custody reconciliation, explicit approval controls, and a tamper-evident record of each published NAV. ProofNAV makes those controls visible and independently verifiable.

## Architecture

- **Backend:** Node.js, TypeScript, Express, SQLite in-memory, decimal.js.
- **Valuation:** quantity × approved price + separately supplied accrued income − liabilities.
- **Integrity:** canonical JSON, SHA-256 snapshot hash, Merkle root over position/liability leaves.
- **Controls:** live on-chain share-supply check and operator-entered custody reconciliation; approval blocked unless reconciliation is `MATCHED`.
- **NEAR contract:** Rust / near-sdk, NEP-141 fund-share token, separate approver and publisher, append-only NAV history, hash approval and publication checks.
- **Frontend:** React, Vite, Recharts; the dashboard reads published NAV, token supply, roles, and token metadata directly from the configured NEAR contract. It does not display the backend's synthetic portfolio data.

## Run from a fresh GitHub checkout

### Requirements

- Git
- Node.js 20 or newer and npm
- A modern browser
- For wallet actions: a NEAR-compatible wallet configured for **testnet** and testnet tokens for transaction fees

The browser app and backend are separate processes. The backend is required for NAV preparation, redemption quotes, and the investor workflow. The contract is already deployed to the configured testnet account for the default demo; building or deploying Rust is not needed to run the app.

### 1. Download the project

Clone the repository:

```bash
git clone https://github.com/praveen0311/ProofNAV.git
cd ProofNAV
```

Or download and extract the ZIP from GitHub, then open a terminal in the extracted `ProofNAV` folder.

### 2. Install dependencies

From the repository root:

```bash
npm install
```

Then install the frontend dependencies:

```bash
cd frontend
npm install
cd ..
```

### 3. Configure the frontend

Create `frontend/.env.local` (this file is local and should not be committed) with the deployed NEAR testnet contract and API settings:

```env
VITE_NEAR_CONTRACT_ID=proofnav.blockmintlabs.testnet
VITE_NEAR_RPC_URL=https://test.rpc.fastnear.com
VITE_NEAR_EXPLORER_URL=https://testnet.nearblocks.io
VITE_PROOFNAV_USDC_TOKEN_ID=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
VITE_PROOFNAV_TREASURY_ID=treasury.blockmintlabs.testnet
VITE_PROOFNAV_API_URL=http://127.0.0.1:3001
```

Vite reads `.env.local` when it starts. If you use another deployed contract or treasury, update these values to match your deployment. `VITE_NEAR_NETWORK` is not required; this app is configured for testnet.

### 4. Start the backend

Open a terminal at the repository root and run:

```bash
npm run dev
```

The API listens on `http://127.0.0.1:3001`. Verify it is running by opening `http://127.0.0.1:3001/health`; it should return a JSON status response.

The backend defaults to the ProofNAV testnet contract, treasury, and USDC token. To use different accounts, set `PROOFNAV_CONTRACT_ID`, `PROOFNAV_TREASURY_ID`, `PROOFNAV_USDC_TOKEN_ID`, and optionally `NEAR_RPC_URL` / `NEAR_NETWORK` in the shell before starting the server. For example, in PowerShell:

```powershell
$env:PROOFNAV_CONTRACT_ID = "your-contract.testnet"
$env:PROOFNAV_TREASURY_ID = "your-treasury.testnet"
npm run dev
```

Or in macOS/Linux:

```bash
export PROOFNAV_CONTRACT_ID=your-contract.testnet
export PROOFNAV_TREASURY_ID=your-treasury.testnet
npm run dev
```

The root `.env.example` lists available backend settings for reference. The server does not automatically load `.env` files; set custom backend values in the shell as shown above.

### 5. Start the frontend

Open a second terminal in the `frontend` directory:

```bash
cd frontend
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173`. Keep both terminal processes running while using the app.

### 6. Use the dashboard

- **Overview** shows the latest published NAV, share supply, chart, and NAV history read from NEAR testnet.
- **Portfolio** explains which holdings are and are not available on-chain.
- **On-chain proof** contains manual NAV preparation, reconciliation, approval, publication, and the published commitment. Enter the valuation data, select **Calculate & reconcile**, and review it before approving. The approver and publisher accounts must match the roles on the contract. Wallets prompt you to confirm each transaction.
- **Subscribe & redeem** contains the investor actions. Redemption quotes require a published NAV and backend access. Subscriptions transfer testnet USDC to the configured treasury; token minting requires the separate payment verification and settlement process.

Refresh contract data and prepare a new snapshot if on-chain share supply, sequence, roles, or publication status changes. Never confirm a wallet transaction unless its account, network, method, and amount are what you intend.

**Testnet only:** this repository is configured for NEAR testnet, but wallet actions still submit real transactions on that test network. Do not put mainnet credentials or funds into the demo.

**NAV data warning:** portfolio positions, prices, liabilities, and custody balances entered into the preparation form are operator-supplied and not independently verified. `MATCHED` only means the entered accounting quantities match the entered custody quantities and that share supply was read from the contract. The API prepares the data and proofs; it does not sign or submit approval/publication transactions.

For a screenshot-only sample, open `http://localhost:5173/?demo=1`. This uses hard-coded illustrative NAV records and disables wallet actions. Remove `?demo=1` to return to live testnet data.

### Optional: validate builds

From the repository root:

```bash
npm run typecheck
```

From `frontend`:

```bash
npm run build
```

### Optional: build and test the NEAR contract

Rust is only needed if you want to test or rebuild the contract. With Rust installed, run:

```bash
rustup target add wasm32-unknown-unknown
cargo install cargo-near --locked
cd contracts/proofnav
cargo test
cargo near build non-reproducible-wasm --no-abi
```

## Important integrity design

The snapshot hash is finalized **after** reconciliation, because reconciliation status and entered evidence are part of the committed payload. The contract binds approver authorization to that exact hash and requires the publisher to submit the same hash with the NAV record. The contract does not independently reconstruct or validate the off-chain valuation payload.

## NEAR contract

Source: `contracts/proofnav/`. The NEP-141 share token uses 8 decimals: 1,000,000 whole shares are represented as `100000000000000` base units. NAV minor units are USD cents; NAV/share uses USD × 1e8. The contract checks that the submitted NAV/share is mathematically consistent with NAV and total share supply.

A GitHub Actions workflow at `.github/workflows/ci.yml` runs the contract tests, WASM build, backend typecheck and frontend production build on pushes and pull requests.

The testnet UI does not require Rust. Review the build and contract configuration before deploying any new WASM.

## Explicit prototype limitations

- Portfolio balances, prices, liabilities, and custody quantities are entered by the operator and are not independently verified. Share supply is read live from the configured contract.
- No live price oracle, custodian API, real tokenized bond contract or external portfolio data is connected.
- Subscribe transfers testnet USDC to the treasury, but requires a separate payment-verification and settlement step before shares are minted. Redemption quoting/requesting is available, but treasury payout and finalization remain separate steps. These are not production subscription/redemption policies.
- NAV approval and publication are wired to the wallet, but still depend on manually entered and unverified valuation data.
- No NEAR Intents cross-chain settlement integration is wired yet.
- No authentication, role-based API authorization, independent key custody, audit, or production deployment is included.
- Hashes prove integrity of committed data, not the truth of source data, legal ownership, solvency, or regulatory compliance.

## Hackathon next steps

1. Connect authenticated independent price and custody data sources and define an auditable valuation policy.
2. Record the deployed testnet contract/account IDs and deployment transactions.
3. Complete and demonstrate the testnet payment-verification, settlement, redemption-payout and finalization processes.
4. Investigate NEAR Intents integration for cross-chain funding/settlement; do not represent it as complete until transactions are demonstrated.
5. Add screenshots and a demo video before submission.

## License

MIT (see `LICENSE`).
