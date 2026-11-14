/**
 * Orchestration boundary for subscriptions.
 * Call verifyCircleUsdcTransfer first, then submit settle_subscription to the
 * ProofNAV contract using a server-held settlement-operator key. This file
 * deliberately does not contain a private key or auto-signing implementation.
 */
import { verifyCircleUsdcTransfer } from "./usdc-verifier";

export async function verifySubscriptionPayment(input: {
  txHash: string; investorId: string; treasuryId: string; usdcAmountAtomic: string;
}) {
  return verifyCircleUsdcTransfer({
    txHash: input.txHash,
    expectedSender: input.investorId,
    treasuryId: input.treasuryId,
    expectedAmountAtomic: input.usdcAmountAtomic,
  });
}

/**
 * After this returns successfully, a trusted backend signer must call the
 * deployed contract's settle_subscription method with:
 * { investor_id, usdc_amount: amountAtomic, payment_tx_hash: txHash }.
 * Store the verifier result and settlement transaction id in a durable DB.
 * Never accept a client-supplied "verified=true" flag.
 */
