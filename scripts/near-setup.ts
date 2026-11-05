/**
 * One-shot NEAR testnet setup (no wallet, no browser, no user funds):
 *   1. creates a fresh testnet settlement account through the public testnet helper (it funds new accounts),
 *   2. creates the royalty-receipts contract account (a sub-account), deploys contracts/royalty-receipts, initialises it,
 *   3. creates the demo creator accounts declared by the bundled demo sites,
 *   4. writes NEAR_* settings into .env (git-ignored).
 * Re-run safe: existing NEAR_ACCOUNT_ID in .env is reused.   Usage: npm run near:setup
 */
import fs from "node:fs";
import { Account, JsonRpcProvider, KeyPair, nearToYocto, teraToGas } from "near-api-js";

const RPC = process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com";
const HELPER = process.env.NEAR_HELPER_URL || "https://helper.testnet.near.org/account";
const WASM = "contracts/royalty-receipts/target/wasm32-unknown-unknown/release/footnote_royalty_receipts.wasm";
const DEMO_CREATORS = ["footnote-demo-compost.testnet", "footnote-demo-worm.testnet"];
const provider = new JsonRpcProvider({ url: RPC });

const readEnv = (): Record<string, string> => {
  const out: Record<string, string> = {};
  if (fs.existsSync(".env")) for (const l of fs.readFileSync(".env", "utf8").split("\n")) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/); if (m) out[m[1]] = m[2]; }
  return out;
};
const setEnv = (kv: Record<string, string>) => {
  const cur = fs.existsSync(".env") ? fs.readFileSync(".env", "utf8").split("\n") : [];
  for (const [k, v] of Object.entries(kv)) {
    const i = cur.findIndex((l) => l.startsWith(k + "="));
    if (i >= 0) cur[i] = `${k}=${v}`; else cur.push(`${k}=${v}`);
  }
  fs.writeFileSync(".env", cur.filter((l, i, a) => l !== "" || i < a.length - 1).join("\n").replace(/\n*$/, "\n"));
};
const exists = async (id: string) => provider.viewAccount({ accountId: id }).then(() => true, () => false);
async function helperCreate(id: string, pk: string) {
  const r = await fetch(HELPER, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ newAccountId: id, newAccountPublicKey: pk }) });
  if (!r.ok) throw new Error(`helper ${r.status}: ${(await r.text()).slice(0, 200)}`);
  for (let i = 0; i < 20 && !(await exists(id)); i++) await new Promise((r) => setTimeout(r, 1000));
  if (!(await exists(id))) throw new Error(`${id} not visible on chain after creation`);
}

const env = readEnv();
let settleId = env.NEAR_ACCOUNT_ID;
let settleKey = env.NEAR_PRIVATE_KEY;
if (!settleId || !settleKey || !(await exists(settleId))) {
  settleId = `footnote-settle-${Math.random().toString(36).slice(2, 8)}.testnet`;
  const kp = KeyPair.fromRandom("ed25519");
  settleKey = kp.toString();
  console.log(`creating settlement account ${settleId} ...`);
  await helperCreate(settleId, kp.getPublicKey().toString());
}
const settle = new Account(settleId, provider, settleKey as any);
console.log(`settlement account ${settleId}: ${(Number((await settle.getBalance()) / 10n ** 20n) / 1e4).toFixed(2)} NEAR`);

// receipts contract on a sub-account of the settlement account
const contractId = env.NEAR_RECEIPT_CONTRACT || `royalty-log.${settleId}`;
if (!(await exists(contractId))) {
  const ckp = KeyPair.fromRandom("ed25519");
  console.log(`creating contract account ${contractId} ...`);
  await settle.createAccount({ newAccountId: contractId, publicKey: ckp.getPublicKey().toString(), nearToTransfer: nearToYocto("3") });
  setEnv({ NEAR_RECEIPT_CONTRACT_KEY: ckp.toString() }); // lets `near:setup` redeploy later
  const contract = new Account(contractId, provider, ckp.toString() as any);
  const wasm = fs.readFileSync(WASM);
  console.log(`deploying ${WASM} (${wasm.length} bytes) ...`);
  await contract.deployContract(wasm);
  await contract.callFunction({ contractId, methodName: "new", args: { settler: settleId }, gas: teraToGas("30") });
  console.log("contract initialised, settler =", settleId);
}

if (process.argv.includes("--redeploy") && env.NEAR_RECEIPT_CONTRACT_KEY) {
  // code upgrade keeps state; the contract's `new` must not be called again
  await new Account(contractId, provider, env.NEAR_RECEIPT_CONTRACT_KEY as any).deployContract(fs.readFileSync(WASM));
  console.log("contract code redeployed");
}

for (const id of DEMO_CREATORS) {
  if (await exists(id)) { console.log(`demo creator ${id} exists`); continue; }
  try { await helperCreate(id, KeyPair.fromRandom("ed25519").getPublicKey().toString()); console.log(`created demo creator ${id}`); }
  catch (e) { console.log(`could not create ${id}: ${(e as Error).message}`); }
}

setEnv({ NEAR_NETWORK: "testnet", NEAR_ACCOUNT_ID: settleId, NEAR_PRIVATE_KEY: settleKey!, NEAR_RECEIPT_CONTRACT: contractId });
console.log(`\n.env updated. Explorer: https://testnet.nearblocks.io/address/${settleId}\nNext: npm run near:e2e`);
