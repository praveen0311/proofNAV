import Decimal from "decimal.js";
import { db } from "./db";
import { FUND_ID } from "./config";
import { canonicalJson, merkleRoot, sha256 } from "./crypto";
import type { SnapshotPayload, SnapshotPosition, ReconciliationStatus } from "./types";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SNAPSHOT_DIR } from "./config";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const D = (v: string | number) => new Decimal(v);
const money = (v: Decimal) => v.toFixed(2);
const quantity = (v: Decimal) => v.toFixed(18);

export function calculateNav(fundId = FUND_ID) {
  const fund = db.prepare("SELECT * FROM funds WHERE id = ?").get(fundId) as any;
  if (!fund) throw new Error(`Fund not found: ${fundId}`);

  const rows = db.prepare(`
    SELECT p.*, a.symbol, a.asset_type,
      pr.price, pr.source AS price_source, pr.observed_at AS price_observed_at,
      a.max_price_age_seconds
    FROM positions p
    JOIN assets a ON a.id = p.asset_id
    LEFT JOIN price_observations pr ON pr.id = (
      SELECT id FROM price_observations
      WHERE asset_id = a.id AND approved = 1
      ORDER BY observed_at DESC LIMIT 1
    )
    WHERE p.fund_id = ?
    ORDER BY p.id
  `).all(fundId) as any[];

  const now = new Date();
  const positions: SnapshotPosition[] = [];
  let grossAssets = D(0);
  for (const row of rows) {
    if (!row.price) throw new Error(`No approved price for ${row.symbol}`);
    const observed = new Date(row.price_observed_at);
    const ageSeconds = (now.getTime() - observed.getTime()) / 1000;
    if (ageSeconds > Number(row.max_price_age_seconds)) {
      throw new Error(`Stale approved price for ${row.symbol}; age=${Math.floor(ageSeconds)} seconds`);
    }
    const qty = D(row.quantity);
    const unitPrice = D(row.price);
    const accrued = D(row.accrued_income ?? "0");
    // MVP convention: accrued_income is separately supplied and must not already be in the price.
    const marketValue = qty.mul(unitPrice).plus(accrued);
    grossAssets = grossAssets.plus(marketValue);
    positions.push({
      positionId: row.id, assetId: row.asset_id, symbol: row.symbol,
      assetType: row.asset_type, quantity: quantity(qty), unitPrice: unitPrice.toFixed(8),
      accruedIncome: money(accrued), marketValue: money(marketValue),
      priceSource: row.price_source, priceObservedAt: row.price_observed_at
    });
  }

  const liabilityRows = db.prepare("SELECT * FROM liabilities WHERE fund_id = ? ORDER BY id").all(fundId) as any[];
  const liabilities = liabilityRows.map(r => ({
    id: r.id, description: r.description, amount: money(D(r.amount))
  }));
  const totalLiabilities = liabilities.reduce((sum, r) => sum.plus(r.amount), D(0));
  const nav = grossAssets.minus(totalLiabilities);
  const controls = db.prepare("SELECT * FROM fund_controls WHERE fund_id = ?").get(fundId) as any;
  if (!controls) throw new Error("Fund share controls are missing");
  const shares = D(controls.eligible_shares);
  if (shares.lte(0)) throw new Error("Eligible share supply must be greater than zero");
  const navPerShare = nav.div(shares);

  const latest = db.prepare("SELECT MAX(sequence) AS seq FROM nav_snapshots WHERE fund_id = ?").get(fundId) as any;
  const sequence = Number(latest?.seq ?? 0) + 1;
  const payload: SnapshotPayload = {
    fundId, sequence, valuationTimestamp: now.toISOString(), currency: fund.currency,
    positions, liabilities, grossAssets: money(grossAssets), totalLiabilities: money(totalLiabilities),
    nav: money(nav), eligibleShares: quantity(shares), navPerShare: navPerShare.toFixed(8),
    reconciliationStatus: "INCOMPLETE", calculationVersion: "proofnav-nav-v0.1"
  };
  const merkle = merkleRoot([...positions, ...liabilities]);
  const snapshotHash = sha256(canonicalJson({ ...payload, merkleRoot: merkle }));
  const id = randomUUID();

  db.prepare(`INSERT INTO nav_snapshots
    (id,fund_id,sequence,valuation_timestamp,gross_assets,liabilities,nav,eligible_shares,nav_per_share,
     reconciliation_status,snapshot_hash,merkle_root,calculation_version,snapshot_payload,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, fundId, sequence, payload.valuationTimestamp, payload.grossAssets, payload.totalLiabilities,
      payload.nav, payload.eligibleShares, payload.navPerShare, payload.reconciliationStatus,
      snapshotHash, merkle, payload.calculationVersion, JSON.stringify(payload), now.toISOString()
    );
  return { id, payload, snapshotHash, merkleRoot: merkle };
}

export function reconcile(snapshotId: string) {
  const snapshot = db.prepare("SELECT * FROM nav_snapshots WHERE id = ?").get(snapshotId) as any;
  if (!snapshot) throw new Error("Snapshot not found");
  if (snapshot.approved || snapshot.published) throw new Error("Approved or published snapshots are immutable");
  db.prepare("DELETE FROM reconciliation_results WHERE snapshot_id = ?").run(snapshotId);

  const checks: Array<{ name: string; status: string; expected: string; actual: string; variance: string; message: string }> = [];
  const control = db.prepare("SELECT * FROM fund_controls WHERE fund_id = ?").get(snapshot.fund_id) as any;
  const shareVariance = D(control.eligible_shares).minus(control.onchain_total_supply);
  checks.push({
    name: "SHARE_SUPPLY", status: shareVariance.isZero() ? "MATCHED" : "FAILED",
    expected: control.eligible_shares, actual: control.onchain_total_supply,
    variance: shareVariance.toString(),
    message: shareVariance.isZero() ? "Eligible shares match the recorded on-chain supply" : "Eligible shares do not match on-chain token supply"
  });

  const positionRows = db.prepare(`
    SELECT p.id, p.quantity AS accounting_qty, c.quantity AS custody_qty, a.symbol
    FROM positions p JOIN assets a ON a.id=p.asset_id
    LEFT JOIN custody_balances c ON c.asset_id=p.asset_id AND c.fund_id=p.fund_id
    WHERE p.fund_id=?
  `).all(snapshot.fund_id) as any[];
  for (const p of positionRows) {
    if (p.custody_qty == null) {
      checks.push({ name: `CUSTODY_${p.symbol}`, status: "INCOMPLETE", expected: p.accounting_qty, actual: "MISSING", variance: "N/A", message: `No custody balance supplied for ${p.symbol}` });
    } else {
      const variance = D(p.accounting_qty).minus(p.custody_qty);
      checks.push({ name: `CUSTODY_${p.symbol}`, status: variance.isZero() ? "MATCHED" : "FAILED",
        expected: p.accounting_qty, actual: p.custody_qty, variance: variance.toString(),
        message: variance.isZero() ? `${p.symbol} quantity matches custody` : `${p.symbol} accounting quantity differs from custody` });
    }
  }

  const hasFailed = checks.some(c => c.status === "FAILED");
  const hasIncomplete = checks.some(c => c.status === "INCOMPLETE");
  const status: ReconciliationStatus = hasFailed ? "FAILED" : hasIncomplete ? "INCOMPLETE" : "MATCHED";
  const insert = db.prepare(`INSERT INTO reconciliation_results
    (id,snapshot_id,check_name,status,expected,actual,variance,message) VALUES (?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => checks.forEach(c => insert.run(randomUUID(), snapshotId, c.name, c.status, c.expected, c.actual, c.variance, c.message)));
  tx();
  // Finalize the committed payload only after reconciliation. The previous MVP
  // hashed INCOMPLETE and then mutated the status to MATCHED, which meant the
  // published state was not the state represented by the hash.
  const payload = buildSnapshotPayload(snapshotId) as SnapshotPayload;
  payload.reconciliationStatus = status;
  const merkle = snapshot.merkle_root as string;
  const finalizedHash = sha256(canonicalJson({ ...payload, merkleRoot: merkle }));
  db.prepare(`UPDATE nav_snapshots
    SET reconciliation_status=?, snapshot_hash=?, snapshot_payload=?
    WHERE id=?`).run(status, finalizedHash, JSON.stringify(payload), snapshotId);
  return { snapshotId, status, checks, snapshotHash: finalizedHash, merkleRoot: merkle };
}

export function approveSnapshot(snapshotId: string) {
  const s = db.prepare("SELECT * FROM nav_snapshots WHERE id=?").get(snapshotId) as any;
  if (!s) throw new Error("Snapshot not found");
  if (s.reconciliation_status !== "MATCHED") throw new Error(`Cannot approve snapshot with status ${s.reconciliation_status}`);
  const payload = buildSnapshotPayload(snapshotId) as SnapshotPayload;
  const recomputedHash = sha256(canonicalJson({ ...payload, merkleRoot: s.merkle_root }));
  if (recomputedHash !== s.snapshot_hash) throw new Error("Snapshot integrity check failed; refusing approval");
  const artifact = { ...payload, snapshotHash: s.snapshot_hash, merkleRoot: s.merkle_root, approvedAt: new Date().toISOString() };
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const target = path.resolve(SNAPSHOT_DIR, `${snapshotId}.json`);
  if (fs.existsSync(target)) throw new Error("Snapshot artifact already exists; snapshots are append-only");
  fs.writeFileSync(target, JSON.stringify(artifact, null, 2), { flag: "wx" });
  db.prepare("UPDATE nav_snapshots SET approved=1 WHERE id=?").run(snapshotId);
  return { snapshotId, approved: true, artifactPath: target };
}

function buildSnapshotPayload(snapshotId: string) {
  const s = db.prepare("SELECT snapshot_payload FROM nav_snapshots WHERE id=?").get(snapshotId) as any;
  if (!s) throw new Error("Snapshot not found");
  return JSON.parse(s.snapshot_payload);
}

export function publishSnapshot(snapshotId: string) {
  const s = db.prepare("SELECT * FROM nav_snapshots WHERE id=?").get(snapshotId) as any;
  if (!s) throw new Error("Snapshot not found");
  if (!s.approved) throw new Error("Snapshot must be approved before publication");
  db.prepare("UPDATE nav_snapshots SET published=1 WHERE id=?").run(snapshotId);
  return { snapshotId, published: true, network: "LOCAL_SIMULATION", snapshotHash: s.snapshot_hash, merkleRoot: s.merkle_root };
}

export function getProof(snapshotId: string) {
  const s = db.prepare("SELECT * FROM nav_snapshots WHERE id=?").get(snapshotId) as any;
  if (!s) throw new Error("Snapshot not found");
  const checks = db.prepare("SELECT * FROM reconciliation_results WHERE snapshot_id=?").all(snapshotId);
  return { snapshotId, sequence: s.sequence, nav: s.nav, navPerShare: s.nav_per_share,
    status: s.reconciliation_status, snapshotHash: s.snapshot_hash, merkleRoot: s.merkle_root,
    approved: Boolean(s.approved), published: Boolean(s.published), checks,
    payload: buildSnapshotPayload(snapshotId) };
}
