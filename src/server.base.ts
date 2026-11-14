import express from "express";
import cors from "cors";
import { db } from "./db";
import { PORT, FUND_ID } from "./config";
import { calculateNav, reconcile, approveSnapshot, publishSnapshot, getProof } from "./valuation";
import { seedDemoFund } from "./seed";
import { verifySubscriptionPayment } from "./subscription-settlement";

seedDemoFund();

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ status: "ok", service: "proofnav-api" }));

app.get("/api/v1/funds/:id", (req, res) => {
  const fund = db.prepare("SELECT * FROM funds WHERE id=?").get(req.params.id);
  if (!fund) return res.status(404).json({ error: "Fund not found" });
  res.json(fund);
});

app.get("/api/v1/funds/:id/portfolio", (req, res) => {
  const fundId = req.params.id;
  const fund = db.prepare("SELECT id,name,currency FROM funds WHERE id=?").get(fundId);
  if (!fund) return res.status(404).json({ error: "Fund not found" });
  const positions = db.prepare(`
    SELECT p.id AS position_id, a.symbol, a.asset_type,
      p.quantity, p.accrued_income, pr.price AS unit_price,
      pr.source AS price_source, pr.observed_at AS price_observed_at,
      c.quantity AS custody_quantity
    FROM positions p JOIN assets a ON a.id=p.asset_id
    LEFT JOIN price_observations pr ON pr.id=(
      SELECT id FROM price_observations WHERE asset_id=a.id AND approved=1
      ORDER BY observed_at DESC LIMIT 1
    )
    LEFT JOIN custody_balances c ON c.asset_id=a.id AND c.fund_id=p.fund_id
    WHERE p.fund_id=? ORDER BY p.id
  `).all(fundId);
  const liabilities = db.prepare("SELECT description,amount FROM liabilities WHERE fund_id=? ORDER BY id").all(fundId);
  const controls = db.prepare("SELECT eligible_shares,onchain_total_supply FROM fund_controls WHERE fund_id=?").get(fundId);
  res.json({ fund, positions, liabilities, controls, dataMode: "SYNTHETIC_DEMO" });
});

app.post("/api/v1/funds/:id/nav/calculate", (req, res) => {
  try {
    if (req.params.id !== FUND_ID) return res.status(404).json({ error: "Unknown MVP fund" });
    res.status(201).json(calculateNav(req.params.id));
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.post("/api/v1/nav/:snapshotId/reconcile", (req, res) => {
  try { res.json(reconcile(req.params.snapshotId)); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.post("/api/v1/nav/:snapshotId/approve", (req, res) => {
  try { res.json(approveSnapshot(req.params.snapshotId)); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.post("/api/v1/nav/:snapshotId/publish", (req, res) => {
  try { res.json(publishSnapshot(req.params.snapshotId)); }
  catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

app.get("/api/v1/nav/:snapshotId/proof", (req, res) => {
  try { res.json(getProof(req.params.snapshotId)); }
  catch (e) { res.status(404).json({ error: (e as Error).message }); }
});

app.get("/api/v1/funds/:id/nav/history", (req, res) => {
  const rows = db.prepare("SELECT * FROM nav_snapshots WHERE fund_id=? ORDER BY sequence DESC").all(req.params.id);
  res.json(rows);
});


// Verify a Circle USDC transfer to the configured treasury. This endpoint
// verifies payment evidence only; it does NOT mint PNAV. Settlement must be
// submitted by a protected server-side operator after durable idempotency checks.
app.post("/api/v1/subscriptions/verify-payment", async (req, res) => {
  try {
    const { txHash, investorId, usdcAmountAtomic } = req.body || {};
    const treasuryId = process.env.PROOFNAV_TREASURY_ID || "treasury.blockmintlabs.testnet";
    if (typeof txHash !== "string" || typeof investorId !== "string" || typeof usdcAmountAtomic !== "string") {
      return res.status(400).json({ error: "txHash, investorId and usdcAmountAtomic are required as strings" });
    }
    const verified = await verifySubscriptionPayment({ txHash, investorId, treasuryId, usdcAmountAtomic });
    return res.json({ status: "PAYMENT_VERIFIED_AWAITING_SETTLEMENT", verified });
  } catch (e) {
    return res.status(400).json({ error: (e as Error).message });
  }
});

app.listen(PORT, () => console.log(`ProofNAV API listening on http://localhost:${PORT}`));
