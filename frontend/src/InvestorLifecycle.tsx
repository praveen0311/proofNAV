import React, { useEffect, useState } from 'react';
import { callContract, callContractAt, getConnectedAccount, connectWallet, viewContractAt } from './near-wallet';

const API = import.meta.env.VITE_PROOFNAV_API_URL || 'http://localhost:3001';
const USDC = import.meta.env.VITE_PROOFNAV_USDC_TOKEN_ID || '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const TREASURY = import.meta.env.VITE_PROOFNAV_TREASURY_ID || 'treasury.blockmintlabs.testnet';
const toAtomic = (v: string, decimals: number) => {
  if (!/^\d+(\.\d*)?$/.test(v)) throw new Error('Enter a valid positive amount');
  const [whole, frac = ''] = v.split('.');
  if (frac.length > decimals) throw new Error(`Maximum ${decimals} decimal places`);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals))).toString();
};
const money = (atomic: string) => (Number(atomic) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });

export default function InvestorLifecycle() {
  const [account, setAccount] = useState<string | null>(null);
  const [usdc, setUsdc] = useState('100');
  const [shares, setShares] = useState('1');
  const [quote, setQuote] = useState<any>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { getConnectedAccount().then(setAccount).catch(() => {}); }, []);

  async function subscribe() {
    setBusy(true); setMessage('');
    try {
      if (!account) { await connectWallet(); setAccount(await getConnectedAccount()); return; }
      if (!USDC || !TREASURY) throw new Error('Set the testnet USDC token and treasury account in the VITE_PROOFNAV environment variables.');
      const atomic = toAtomic(usdc, 6);
      const treasuryBalance = await viewContractAt<{ total: string; available: string } | null>(
        USDC,
        'storage_balance_of',
        { account_id: TREASURY },
      );
      if (!treasuryBalance) {
        const bounds = await viewContractAt<{ min: string }>(USDC, 'storage_balance_bounds');
        if (!bounds?.min) throw new Error('The USDC token did not provide its required treasury registration deposit.');
        setMessage('Treasury is not registered for USDC. Confirm its storage registration in your wallet…');
        await callContractAt(
          USDC,
          'storage_deposit',
          { account_id: TREASURY, registration_only: true },
          BigInt(bounds.min),
        );
      }
      setMessage('Confirm native USDC transfer in your wallet…');
      const result: any = await callContractAt(
        USDC,
        'ft_transfer',
        { receiver_id: TREASURY, amount: atomic, memo: 'ProofNAV subscription' },
        1n,
      );
      const hash = result?.transaction?.hash || result?.transaction_outcome?.id || '';
      setMessage(hash ? `USDC transfer submitted: ${hash}. Verify it with the backend payment-verification endpoint, then the settlement operator must finalize settle_subscription.` : 'Transfer submitted. Capture its transaction hash and verify payment with the backend.');
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }

  async function loadQuote() {
    try {
      const atomic = toAtomic(shares, 8);
      const r = await fetch(`${API}/api/v1/lifecycle/redemptions/quote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shareAmountAtomic: atomic }) });
      const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Quote failed'); setQuote(data);
    } catch (e) { setMessage((e as Error).message); }
  }

  async function redeem() {
    setBusy(true); setMessage('');
    try {
      if (!account) { await connectWallet(); setAccount(await getConnectedAccount()); return; }
      const q = quote || (await (async () => { const r=await fetch(`${API}/api/v1/lifecycle/redemptions/quote`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({shareAmountAtomic:toAtomic(shares,8)})}); const d=await r.json(); if(!r.ok) throw new Error(d.error); setQuote(d); return d; })());
      if (!q.liquiditySufficient) throw new Error('Treasury liquidity is insufficient; redemption cannot proceed.');
      const requestId = `pn-${crypto.randomUUID()}`;
      const tx: any = await callContract('request_redemption', { request_id: requestId, share_amount: q.shareAmountAtomic });
      await fetch(`${API}/api/v1/lifecycle/redemptions/record`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({requestId,investorId:account}) });
      setMessage(`Redemption escrowed. Request ${requestId}. Expected payout ${money(q.usdcAmountAtomic)} USDC at NAV sequence ${q.navSequence}. Treasury payout and on-chain finalization are pending.`);
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(false); }
  }

  return <section className="panel investor-panel">
    <div className="panel-heading investor-heading">
      <div><span className="eyebrow">INVESTOR PORTAL</span><h3>Subscribe & redeem</h3></div>
      <button className="wallet-button" type="button" onClick={async () => { await connectWallet(); setAccount(await getConnectedAccount()); }}>
        {account || 'Connect wallet'}
      </button>
    </div>
    <div className="investor-grid">
      <div className="investor-card">
        <h3>Subscribe with USDC</h3>
        <p>Transfer native Circle USDC to the fund treasury.</p>
        <label className="investor-field">
          USDC amount
          <input type="text" inputMode="decimal" value={usdc} onChange={event => setUsdc(event.target.value)} aria-label="USDC amount" />
        </label>
        <button className="primary-button" type="button" disabled={busy} onClick={subscribe}>Transfer USDC</button>
        <small>Shares are minted only after payment verification and on-chain settlement.</small>
      </div>
      <div className="investor-card">
        <h3>Redeem PNAV</h3>
        <p>Uses the latest published NAV, with no redemption fee.</p>
        <label className="investor-field">
          PNAV shares
          <input type="text" inputMode="decimal" value={shares} onChange={event => setShares(event.target.value)} aria-label="PNAV shares" />
        </label>
        <div className="investor-actions">
          <button className="secondary-button" type="button" disabled={busy} onClick={loadQuote}>Check quote & liquidity</button>
          <button className="primary-button" type="button" disabled={busy || !quote?.liquiditySufficient} onClick={redeem}>Request redemption</button>
        </div>
        {quote && <div className="investor-quote">
          <div><span>Estimated payout</span><b>{money(quote.usdcAmountAtomic)} USDC</b></div>
          <div><span>NAV sequence</span><b>#{quote.navSequence}</b></div>
          <div><span>Treasury liquidity</span><b className={quote.liquiditySufficient ? "investor-liquidity-ok" : "investor-liquidity-low"}>{quote.liquiditySufficient ? 'Sufficient' : 'Insufficient'}</b></div>
        </div>}
      </div>
    </div>
    {message && <p className="investor-message" role="status">{message}</p>}
  </section>;
}
