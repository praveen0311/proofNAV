export type ReconciliationStatus = "MATCHED" | "WARNING" | "FAILED" | "INCOMPLETE" | "PROVISIONAL";

export interface SnapshotPosition {
  positionId: string;
  assetId: string;
  symbol: string;
  assetType: string;
  quantity: string;
  unitPrice: string;
  accruedIncome: string;
  marketValue: string;
  priceSource: string;
  priceObservedAt: string;
}

export interface SnapshotPayload {
  fundId: string;
  sequence: number;
  valuationTimestamp: string;
  currency: string;
  positions: SnapshotPosition[];
  liabilities: Array<{ id: string; description: string; amount: string }>;
  grossAssets: string;
  totalLiabilities: string;
  nav: string;
  eligibleShares: string;
  navPerShare: string;
  reconciliationStatus: ReconciliationStatus;
  calculationVersion: string;
}


export interface SubscriptionPaymentRequest {
  txHash: string;
  investorId: string;
  usdcAmountAtomic: string;
}

export interface VerifiedSubscriptionPayment {
  txHash: string;
  senderId: string;
  treasuryId: string;
  amountAtomic: string;
  blockHeight: number;
}

export interface OnChainSubscriptionRecord {
  investor_id: string;
  usdc_amount: string;
  share_amount: string;
  payment_tx_hash: string;
  nav_sequence: number;
  settled_at: number;
}
