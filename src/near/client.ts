import { Account, JsonRpcProvider, teraToGas } from "near-api-js";
import { isImplicitAccount } from "./account.js";

export type NearNetwork = "testnet" | "mainnet";

export interface ReceiptArgs {
  payee: string;
  answerId: string;
  usdCents: number;
  yocto: bigint;
  payoutTx: string;
  splitHash: string;
}
export interface OnchainReceipt {
  id: number;
  payee: string;
  answer_id: string;
  usd_cents: number;
  yocto_near: string;
  payout_tx: string;
  split_hash: string;
  timestamp_ns: number;
}

/** What the settlement code needs from NEAR. Real implementation below; `SimNearClient` is the offline stand-in. */
export interface NearClient {
  readonly mode: "live" | "simulator";
  readonly network: NearNetwork;
  readonly accountId: string;
  readonly receiptContract: string | null;
  accountExists(id: string): Promise<boolean>;
  balance(): Promise<bigint>;
  /** Native NEAR transfer from the settlement account. Throws if the transaction or any of its receipts failed. */
  transfer(receiver: string, yocto: bigint): Promise<{ txHash: string }>;
  logReceipt(r: ReceiptArgs): Promise<{ txHash: string }>;
  recentReceipts(limit?: number): Promise<OnchainReceipt[]>;
  explorerTx(hash: string): string;
  explorerAccount(id: string): string;
}

export const explorerBase = (n: NearNetwork) => (n === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io");
export const defaultRpc = (n: NearNetwork) => (n === "mainnet" ? "https://free.rpc.fastnear.com" : "https://test.rpc.fastnear.com");

/** First failure anywhere in a transaction result (the tx itself or any receipt), or null. */
export function firstFailure(res: any): string | null {
  const bad = (st: any) => (st && typeof st === "object" && "Failure" in st ? JSON.stringify(st.Failure) : null);
  const top = bad(res?.status);
  if (top) return top;
  for (const r of res?.receipts_outcome ?? []) {
    const f = bad(r?.outcome?.status);
    if (f) return f;
  }
  return null;
}

export interface RealNearOpts {
  network: NearNetwork;
  rpcUrl?: string;
  accountId: string;
  privateKey: string; // "ed25519:..."
  receiptContract?: string | null;
}

export class RealNearClient implements NearClient {
  readonly mode = "live" as const;
  readonly network: NearNetwork;
  readonly accountId: string;
  readonly receiptContract: string | null;
  private provider: JsonRpcProvider;
  private account: Account;

  constructor(o: RealNearOpts) {
    this.network = o.network;
    this.accountId = o.accountId;
    this.receiptContract = o.receiptContract ?? null;
    this.provider = new JsonRpcProvider({ url: o.rpcUrl || defaultRpc(o.network) });
    this.account = new Account(o.accountId, this.provider, o.privateKey as any);
  }

  async accountExists(id: string): Promise<boolean> {
    if (isImplicitAccount(id)) return true; // an implicit account is created by its first incoming transfer
    try {
      await this.provider.viewAccount({ accountId: id });
      return true;
    } catch (e) {
      const m = String((e as any)?.type ?? "") + " " + String((e as Error)?.message ?? "");
      if (/UnknownAccount|UNKNOWN_ACCOUNT|does not exist|doesn't exist/i.test(m)) return false;
      throw e;
    }
  }

  balance(): Promise<bigint> {
    return this.account.getBalance();
  }

  async transfer(receiver: string, yocto: bigint) {
    const res: any = await this.account.transfer({ receiverId: receiver, amount: yocto });
    const bad = firstFailure(res);
    if (bad) throw new Error(`NEAR transfer failed: ${bad}`);
    const txHash = res?.transaction?.hash ?? res?.transaction_outcome?.id;
    if (!txHash) throw new Error("NEAR transfer returned no transaction hash");
    return { txHash: String(txHash) };
  }

  async logReceipt(r: ReceiptArgs) {
    if (!this.receiptContract) throw new Error("no receipt contract configured");
    const res: any = await this.account.callFunctionRaw({
      contractId: this.receiptContract,
      methodName: "log_receipt",
      args: { payee: r.payee, answer_id: r.answerId, usd_cents: r.usdCents, yocto_near: r.yocto.toString(), payout_tx: r.payoutTx, split_hash: r.splitHash },
      gas: teraToGas("30"),
      deposit: 0n,
    } as any);
    const bad = firstFailure(res);
    if (bad) throw new Error(`log_receipt failed: ${bad}`);
    return { txHash: String(res?.transaction?.hash ?? res?.transaction_outcome?.id) };
  }

  async recentReceipts(limit = 10): Promise<OnchainReceipt[]> {
    if (!this.receiptContract) return [];
    const out = await this.provider.callFunction({ contractId: this.receiptContract, method: "recent", args: { limit } });
    return (out as OnchainReceipt[]) ?? [];
  }

  explorerTx = (h: string) => `${explorerBase(this.network)}/txns/${h}`;
  explorerAccount = (a: string) => `${explorerBase(this.network)}/address/${a}`;
}

/**
 * Offline stand-in used only when NEAR_SIMULATOR=1 (and by tests). It moves no value and every hash it returns
 * is prefixed `sim_`, so it can never be mistaken for a chain transaction. The UI labels it "NEAR: simulator".
 */
export class SimNearClient implements NearClient {
  readonly mode = "simulator" as const;
  readonly network: NearNetwork = "testnet";
  readonly accountId = "settlement.sim.testnet";
  readonly receiptContract: string | null = "receipts.sim.testnet";
  transfers: { receiver: string; yocto: bigint; txHash: string }[] = [];
  receipts: OnchainReceipt[] = [];
  missing = new Set<string>();
  failTransfers = false;
  private n = 0;
  private hash = () => `sim_${(++this.n).toString().padStart(6, "0")}${Math.random().toString(16).slice(2, 10)}`;
  async accountExists(id: string) { return !this.missing.has(id) && !/^missing/.test(id); }
  async balance() { return 1000n * 10n ** 24n; }
  async transfer(receiver: string, yocto: bigint) {
    if (this.failTransfers) throw new Error("NEAR transfer failed (simulated)");
    const txHash = this.hash();
    this.transfers.push({ receiver, yocto, txHash });
    return { txHash };
  }
  async logReceipt(r: ReceiptArgs) {
    const txHash = this.hash();
    this.receipts.push({ id: this.receipts.length, payee: r.payee, answer_id: r.answerId, usd_cents: r.usdCents, yocto_near: r.yocto.toString(), payout_tx: r.payoutTx, split_hash: r.splitHash, timestamp_ns: Date.now() * 1e6 });
    return { txHash };
  }
  async recentReceipts(limit = 10) { return this.receipts.slice(-limit); }
  explorerTx = (h: string) => `sim://near/txns/${h}`;
  explorerAccount = (a: string) => `sim://near/address/${a}`;
}
