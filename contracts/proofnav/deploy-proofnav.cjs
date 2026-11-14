const { spawnSync } = require("node:child_process");
const path = require("node:path");

const cli = path.join(
  process.env.APPDATA,
  "npm",
  "node_modules",
  "near-cli",
  "bin",
  "near-cli.js"
);

const initArgs = {
  owner_id: "blockmintlabs.testnet",
  publisher_id: "blockmintlabs.testnet",
  approver_id: "blockmintlabs.testnet",
  fund_id: "PROOFNAV-DEMO-001",
  treasury_account: "treasury.blockmintlabs.testnet",
  usdc_token_account: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  settlement_operator: "settler.blockmintlabs.testnet",
  initial_holder: "blockmintlabs.testnet",
  initial_supply: "100000000000000",
  metadata: {
    spec: "ft-1.0.0",
    name: "ProofNAV Share",
    symbol: "PNAV",
    decimals: 8
  }
};

const result = spawnSync(process.execPath, [
  cli,
  "deploy",
  "proofnav.blockmintlabs.testnet",
  ".\\target\\near\\proofnav_contract.wasm",
  "--initFunction", "new",
  "--initArgs", JSON.stringify(initArgs),
  "--initGas", "100000000000000",
  "--initDeposit", "0",
  "--networkId", "testnet",
  "--force"
], { stdio: "inherit" });

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);