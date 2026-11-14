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

  return <section style={{margin:'24px 0',padding:24,border:'1px solid #273449',borderRadius:16,background:'#101a29',color:'#edf3fb'}}>
    <div style={{display:'flex',justifyContent:'space-between',gap:12,flexWrap:'wrap'}}><div><div style={{fontSize:11,letterSpacing:2,color:'#8ea7c4'}}>INVESTOR PORTAL</div><h2 style={{margin:'6px 0 16px'}}>Subscribe & redeem</h2></div><button onClick={async()=>{await connectWallet();setAccount(await getConnectedAccount());}}>{account || 'Connect wallet'}</button></div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:18}}>
      <div style={{padding:16,background:'#17263a',borderRadius:12}}><h3>Subscribe with USDC</h3><p style={{color:'#9db0c7'}}>Transfer native Circle USDC to the fund treasury.</p><input value={usdc} onChange={e=>setUsdc(e.target.value)} aria-label="USDC amount" style={{width:'100%',padding:12,boxSizing:'border-box'}}/><button disabled={busy} onClick={subscribe} style={{marginTop:12}}>Transfer USDC</button><small style={{display:'block',marginTop:10,color:'#9db0c7'}}>Shares are minted only after payment verification and on-chain settlement.</small></div>
      <div style={{padding:16,background:'#17263a',borderRadius:12}}><h3>Redeem PNAV</h3><p style={{color:'#9db0c7'}}>Uses the latest published NAV, with no redemption fee.</p><input value={shares} onChange={e=>setShares(e.target.value)} aria-label="PNAV shares" style={{width:'100%',padding:12,boxSizing:'border-box'}}/><button disabled={busy} onClick={loadQuote} style={{marginTop:12}}>Check quote & liquidity</button>{quote && <div style={{marginTop:12,fontSize:13}}>Est. payout: <b>{money(quote.usdcAmountAtomic)} USDC</b><br/>NAV sequence: {quote.navSequence}<br/>Treasury liquidity: {quote.liquiditySufficient ? 'Sufficient' : 'Insufficient'}</div>}<button disabled={busy || !quote?.liquiditySufficient} onClick={redeem} style={{marginTop:12,display:'block'}}>Request redemption</button></div>
    </div>
    {message && <p role="status" style={{marginTop:16,overflowWrap:'anywhere'}}>{message}</p>}
  </section>;
}
