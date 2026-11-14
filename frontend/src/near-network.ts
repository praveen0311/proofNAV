import type { Network } from "@near-wallet-selector/core";

export const NETWORK = "testnet";
export const RPC_URL = import.meta.env.VITE_NEAR_RPC_URL || "https://test.rpc.fastnear.com";
export const CONTRACT_ID = import.meta.env.VITE_NEAR_CONTRACT_ID || "";
export const EXPLORER_URL = import.meta.env.VITE_NEAR_EXPLORER_URL || undefined;
export const WALLET_URL = import.meta.env.VITE_NEAR_WALLET_URL || undefined;

export const WALLET_NETWORK: Network = {
  networkId: NETWORK,
  nodeUrl: RPC_URL,
  helperUrl: import.meta.env.VITE_NEAR_HELPER_URL || RPC_URL,
  explorerUrl: EXPLORER_URL || "https://testnet.nearblocks.io",
  indexerUrl: import.meta.env.VITE_NEAR_INDEXER_URL || RPC_URL,
};
