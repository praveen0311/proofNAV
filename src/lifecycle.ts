import crypto from 'node:crypto';

const RPC = process.env.NEAR_RPC_URL || 'https://rpc.testnet.near.org';
const NETWORK = process.env.NEAR_NETWORK || 'testnet';
const USDC = process.env.PROOFNAV_USDC_TOKEN_ID || '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const TREASURY = process.env.PROOFNAV_TREASURY_ID || 'treasury.blockmintlabs.testnet';
const CONTRACT = process.env.PROOFNAV_CONTRACT_ID || 'proofnav.blockmintlabs.testnet';

export const newId = () => crypto.randomUUID();

async function rpc<T>(method: string, params: unknown): Promise<T> {
  const response = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'proofnav', method, params }) });
  const body: any = await response.json();
  if (!response.ok || body.error) throw new Error(body.error?.cause?.name || body.error?.message || `NEAR RPC ${response.status}`);
  return body.result as T;
}

export async function viewCall<T>(accountId: string, methodName: string, args: Record<string, unknown> = {}): Promise<T> {
  const result: any = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: accountId, method_name: methodName, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
  return JSON.parse(Buffer.from(result.result).toString('utf8')) as T;
}

export async function getUsdcBalance(accountId: string): Promise<bigint> {
  const raw = await viewCall<string>(USDC, 'ft_balance_of', { account_id: accountId });
  return BigInt(raw);
}

export async function verifyNearTransfer(txHash: string, signerId: string, expectedReceiver: string, expectedAmount: string) {
  if (!/^[A-Za-z0-9_-]{40,100}$/.test(txHash)) throw new Error('Invalid NEAR transaction hash');
  const result: any = await rpc('tx', [txHash, signerId]);
  if (result.status?.Failure) throw new Error('Transaction failed');
  const logs: string[] = [];
  const walk = (receipts: any[] = []) => { for (const r of receipts) { logs.push(...(r.outcome?.logs || [])); walk(r.receipts_outcome || []); } };
  logs.push(...(result.transaction_outcome?.outcome?.logs || []));
  walk(result.receipts_outcome || []);
  const events = logs.flatMap(line => {
    try {
      const eventJson = line.startsWith('EVENT_JSON:') ? line.slice('EVENT_JSON:'.length) : line;
      const event = JSON.parse(eventJson);
      return event.standard === 'nep141' && event.event === 'ft_transfer' ? event.data : [];
    } catch { return []; }
  });
  const match = events.some((e: any) => e.old_owner_id === signerId && e.new_owner_id === expectedReceiver && String(e.amount) === expectedAmount);
  if (!match) throw new Error('Finalized transaction does not contain the expected NEP-141 transfer event');
  return { txHash, signerId, receiverId: expectedReceiver, amountAtomic: expectedAmount, blockHeight: result.transaction_outcome?.block_height };
}

export const lifecycleConfig = { network: NETWORK, usdcTokenId: USDC, treasuryId: TREASURY, contractId: CONTRACT };
