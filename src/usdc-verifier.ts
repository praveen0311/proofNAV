/**
 * Verifies Circle native USDC NEP-141 transfers on NEAR Testnet.
 * Requires a finalized successful transaction and a nep141 ft_transfer event
 * emitted by the exact Circle token contract to the configured treasury.
 * This verifier is an off-chain trusted component; do not expose settlement
 * operator signing credentials to the browser.
 */
export const NEAR_TESTNET_RPC = "https://rpc.testnet.near.org";
export const CIRCLE_USDC_TESTNET = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";

export type VerifiedUsdcPayment = {
  txHash: string;
  senderId: string;
  treasuryId: string;
  amountAtomic: string;
  blockHeight: number;
};

type RpcResult = {
  status?: { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown };
  transaction?: { hash?: string; signer_id?: string; receiver_id?: string };
  transaction_outcome?: { block_hash?: string; outcome?: { status?: unknown } };
  receipts_outcome?: Array<{ outcome?: { logs?: string[]; status?: unknown } }>;
};

async function rpc(method: string, params: unknown): Promise<any> {
  const response = await fetch(NEAR_TESTNET_RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "proofnav-usdc-verifier", method, params })
  });
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const body = await response.json() as { result?: any; error?: { message?: string; data?: string } };
  if (body.error) throw new Error(body.error.data || body.error.message || "NEAR RPC error");
  return body.result;
}

function isSuccessful(status: any): boolean {
  return Boolean(status && ("SuccessValue" in status || "SuccessReceiptId" in status));
}

export async function verifyCircleUsdcTransfer(input: {
  txHash: string;
  expectedSender: string;
  treasuryId: string;
  expectedAmountAtomic: string;
}): Promise<VerifiedUsdcPayment> {
  if (!/^[0-9a-f]{64}$/i.test(input.txHash)) throw new Error("Invalid NEAR transaction hash");
  if (!/^\d+$/.test(input.expectedAmountAtomic) || BigInt(input.expectedAmountAtomic) <= 0n)
    throw new Error("Invalid USDC amount");

  const result = await rpc("EXPERIMENTAL_tx_status", [input.txHash, input.expectedSender]) as RpcResult;
  if (!result.transaction || result.transaction.hash?.toLowerCase() !== input.txHash.toLowerCase())
    throw new Error("Transaction not found or hash mismatch");
  if (result.transaction.signer_id !== input.expectedSender)
    throw new Error("Transaction signer does not match investor");
  if (result.transaction.receiver_id !== CIRCLE_USDC_TESTNET)
    throw new Error("Transaction was not sent to Circle's NEAR Testnet USDC contract");
  if (!isSuccessful(result.status)) throw new Error("USDC transfer transaction did not succeed");

  const logs = (result.receipts_outcome || []).flatMap(x => x.outcome?.logs || []);
  const events: any[] = [];
  for (const log of logs) {
    const prefix = "EVENT_JSON:";
    if (!log.startsWith(prefix)) continue;
    try {
      const parsed = JSON.parse(log.slice(prefix.length));
      if (parsed.standard === "nep141" && parsed.event === "ft_transfer") events.push(...(parsed.data || []));
    } catch { /* ignore non-JSON application logs */ }
  }
  const transfer = events.find(e => e.old_owner_id === input.expectedSender &&
    e.new_owner_id === input.treasuryId && String(e.amount) === input.expectedAmountAtomic);
  if (!transfer) throw new Error("No matching finalized NEP-141 transfer event to the configured treasury");

  // Resolve block height from the transaction outcome block hash.
  const blockHash = result.transaction_outcome?.block_hash;
  let blockHeight = 0;
  if (blockHash) {
    const block = await rpc("block", { block_id: blockHash });
    blockHeight = Number(block?.header?.height || 0);
  }
  return { txHash: input.txHash, senderId: input.expectedSender, treasuryId: input.treasuryId,
    amountAtomic: input.expectedAmountAtomic, blockHeight };
}
