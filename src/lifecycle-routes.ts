import { Router } from 'express';
import { db } from './db.js';
import { getUsdcBalance, lifecycleConfig, newId, verifyNearTransfer, viewCall } from './lifecycle.js';

export const lifecycleRouter = Router();
const now = () => new Date().toISOString();
const requireOperator = (req: any, res: any, next: any) => {
  const key = process.env.PROOFNAV_OPERATOR_API_KEY;
  if (!key || req.header('x-proofnav-operator-key') !== key) return res.status(401).json({ error: 'Operator authentication required' });
  next();
};

lifecycleRouter.get('/config', (_req, res) => res.json(lifecycleConfig));

lifecycleRouter.post('/subscriptions/verify-payment', async (req, res) => {
  try {
    const { txHash, investorId, usdcAmountAtomic } = req.body || {};
    if (![txHash, investorId, usdcAmountAtomic].every((v: unknown) => typeof v === 'string')) return res.status(400).json({ error: 'txHash, investorId and usdcAmountAtomic are required as strings' });
    const prior: any = db.prepare('SELECT * FROM lifecycle_transactions WHERE payment_or_payout_tx_hash=?').get(txHash);
    if (prior) return res.status(409).json({ error: 'Transaction hash already recorded', status: prior.status });
    const verified = await verifyNearTransfer(txHash, investorId, lifecycleConfig.treasuryId, usdcAmountAtomic);
    const nav: any = await viewCall(lifecycleConfig.contractId, 'get_latest_nav');
    if (!nav || nav.currency !== 'USD') return res.status(409).json({ error: 'A published USD NAV is required before subscription settlement' });
    const shares = BigInt(usdcAmountAtomic) * 10_000_000_000n / BigInt(nav.nav_per_share);
    if (shares <= 0n) return res.status(400).json({ error: 'Subscription is too small to mint a base share unit' });
    const id = newId();
    db.prepare(`INSERT INTO lifecycle_transactions
      (id,fund_id,kind,investor_id,amount_atomic,share_amount_atomic,nav_sequence,nav_per_share_raw,payment_or_payout_tx_hash,status,created_at,updated_at,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'PROOFNAV-DEMO-001', 'SUBSCRIPTION', investorId, usdcAmountAtomic, shares.toString(), nav.sequence, nav.nav_per_share, txHash, 'PAYMENT_VERIFIED_AWAITING_SETTLEMENT', now(), now(), JSON.stringify(verified));
    res.json({ status: 'PAYMENT_VERIFIED_AWAITING_SETTLEMENT', verified, shareAmountAtomic: shares.toString(), navSequence: nav.sequence, nextContractCall: { methodName: 'settle_subscription', args: { investor_id: investorId, usdc_amount: usdcAmountAtomic, payment_tx_hash: txHash } } });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

lifecycleRouter.get('/liquidity', async (_req, res) => {
  try {
    const raw = await getUsdcBalance(lifecycleConfig.treasuryId);
    res.json({ treasuryId: lifecycleConfig.treasuryId, usdcBalanceAtomic: raw.toString(), available: true });
  } catch (e) { res.status(502).json({ error: (e as Error).message, available: false }); }
});

lifecycleRouter.post('/redemptions/quote', async (req, res) => {
  try {
    const shares = BigInt(String(req.body.shareAmountAtomic || '0'));
    if (shares <= 0n) return res.status(400).json({ error: 'shareAmountAtomic must be positive' });
    const nav: any = await viewCall(lifecycleConfig.contractId, 'get_latest_nav');
    if (!nav || nav.currency !== 'USD') return res.status(409).json({ error: 'A published USD NAV is required' });
    const proceeds = shares * BigInt(nav.nav_per_share) / 10_000_000_000n;
    if (proceeds <= 0n) return res.status(400).json({ error: 'Redemption is below one USDC base unit' });
    const balance = await getUsdcBalance(lifecycleConfig.treasuryId);
    res.json({ navSequence: nav.sequence, navPerShareRaw: nav.nav_per_share, shareAmountAtomic: shares.toString(), usdcAmountAtomic: proceeds.toString(), feeAtomic: '0', treasuryBalanceAtomic: balance.toString(), liquiditySufficient: balance >= proceeds });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

lifecycleRouter.post('/redemptions/verify-payout', requireOperator, async (req, res) => {
  try {
    const { requestId, investorId, txHash, usdcAmountAtomic } = req.body || {};
    if (![requestId, investorId, txHash, usdcAmountAtomic].every((v: unknown) => typeof v === 'string')) return res.status(400).json({ error: 'requestId, investorId, txHash and usdcAmountAtomic are required' });
    const existing: any = db.prepare("SELECT * FROM lifecycle_transactions WHERE id=? AND kind='REDEMPTION'").get(requestId);
    if (!existing) return res.status(404).json({ error: 'Unknown redemption request in backend ledger' });
    if (existing.status === 'SETTLED' || existing.payment_or_payout_tx_hash) return res.status(409).json({ error: 'Redemption already has a payout hash' });
    const verified = await verifyNearTransfer(txHash, lifecycleConfig.treasuryId, investorId, usdcAmountAtomic);
    db.prepare("UPDATE lifecycle_transactions SET payment_or_payout_tx_hash=?,status='PAYOUT_VERIFIED',updated_at=? WHERE id=?").run(txHash, now(), requestId);
    res.json({ status: 'PAYOUT_VERIFIED_AWAITING_ONCHAIN_FINALIZATION', verified, nextContractCall: { methodName: 'settle_redemption', args: { request_id: requestId, payout_tx_hash: txHash } } });
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});

lifecycleRouter.get('/investors/:accountId', (req, res) => {
  const rows = db.prepare('SELECT * FROM lifecycle_transactions WHERE investor_id=? ORDER BY created_at DESC LIMIT 100').all(req.params.accountId);
  res.json(rows);
});

// Record requests only after the corresponding wallet transaction is finalized
// and the contract view confirms the same request. Never trust client-submitted NAV.
lifecycleRouter.post('/redemptions/record', async (req, res) => {
  try {
    const { requestId, investorId } = req.body || {};
    if (typeof requestId !== 'string' || typeof investorId !== 'string') return res.status(400).json({ error: 'requestId and investorId required' });
    const record: any = await viewCall(lifecycleConfig.contractId, 'get_redemption', { request_id: requestId });
    if (!record || record.investor_id !== investorId) return res.status(404).json({ error: 'On-chain redemption not found for investor' });
    db.prepare(`INSERT OR IGNORE INTO lifecycle_transactions
      (id,fund_id,kind,investor_id,amount_atomic,share_amount_atomic,nav_sequence,nav_per_share_raw,status,created_at,updated_at,metadata_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(requestId, 'PROOFNAV-DEMO-001', 'REDEMPTION', investorId, record.usdc_amount, record.share_amount, record.nav_sequence, '0', record.status, now(), now(), JSON.stringify(record));
    res.json(record);
  } catch (e) { res.status(400).json({ error: (e as Error).message }); }
});
