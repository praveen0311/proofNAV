import { actionCreators, setupWalletSelector } from "@near-wallet-selector/core";
import { setupModal } from "@near-wallet-selector/modal-ui";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { CONTRACT_ID, RPC_URL, WALLET_NETWORK, WALLET_URL } from "./near-network";

type ViewFunctionResponse = {
  result?: { result?: number[] };
  error?: { message?: string; data?: string };
};

let selectorPromise: ReturnType<typeof setupWalletSelector> | undefined;
let modalPromise: ReturnType<typeof setupModal> | undefined;

export async function getWalletSelector() {
  selectorPromise ??= setupWalletSelector({
    network: WALLET_NETWORK,
    fallbackRpcUrls: [RPC_URL],
    modules: [
      setupMeteorWallet(),
      setupMyNearWallet(WALLET_URL ? { walletUrl: WALLET_URL } : {}),
    ],
    debug: import.meta.env.DEV,
  });
  return selectorPromise;
}

export async function getWalletModal() {
  if (!CONTRACT_ID) {
    throw new Error("Set VITE_NEAR_CONTRACT_ID to your deployed testnet contract account.");
  }
  const selector = await getWalletSelector();
  modalPromise ??= setupModal(selector, {
    contractId: CONTRACT_ID,
    description: "Connect to ProofNAV to approve and publish fund NAV commitments.",
    theme: "dark",
  });
  return modalPromise;
}

export async function getConnectedAccount(): Promise<string | null> {
  const selector = await getWalletSelector();
  const state = selector.store.getState();
  if (!state.selectedWalletId) return null;
  const wallet = await selector.wallet();
  const accounts = await wallet.getAccounts();
  return accounts[0]?.accountId ?? null;
}

export async function connectWallet() {
  const modal = await getWalletModal();
  modal.show();
}

export async function disconnectWallet() {
  const selector = await getWalletSelector();
  const state = selector.store.getState();
  if (state.selectedWalletId) {
    const wallet = await selector.wallet();
    await wallet.signOut();
  }
}

export async function viewContractAt<T>(
  receiverId: string,
  methodName: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const encodedArgs = btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(args)), byte => String.fromCharCode(byte)).join(""),
  );
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `proofnav-${methodName}`,
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: receiverId,
        method_name: methodName,
        args_base64: encodedArgs,
      },
    }),
  });
  if (!response.ok) throw new Error(`NEAR RPC request failed (${response.status})`);
  const result = await response.json() as ViewFunctionResponse;
  if (result.error) {
    throw new Error(result.error.data || result.error.message || `NEAR RPC failed for ${methodName}`);
  }
  if (!result.result?.result) throw new Error(`NEAR RPC returned no result for ${methodName}`);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(result.result.result))) as T;
}

export async function callContractAt(
  receiverId: string,
  methodName: string,
  args: Record<string, unknown>,
  attachedDeposit = 0n,
) {
  const selector = await getWalletSelector();
  const state = selector.store.getState();
  if (!state.selectedWalletId) throw new Error("Connect a NEAR wallet first.");
  const wallet = await selector.wallet();
  const accounts = await wallet.getAccounts();
  if (!accounts[0]?.accountId) throw new Error("No account is connected to the selected wallet.");
  return wallet.signAndSendTransaction({
    signerId: accounts[0].accountId,
    receiverId,
    actions: [
      actionCreators.functionCall(
        methodName,
        args,
        100_000_000_000_000n,
        attachedDeposit,
      ),
    ],
  });
}

export async function callContract(methodName: string, args: Record<string, unknown>) { return callContractAt(CONTRACT_ID, methodName, args); }
