#!/usr/bin/env node
/**
 * Solana rent reclaim: close a wallet's empty token accounts (SPL Token and
 * Token-2022) and get back the SOL each one holds for rent, about
 * 0.002 SOL per account.
 *
 *   node reclaim.mjs                 dry run: list what can be closed
 *   node reclaim.mjs --send          close them
 *
 * Run with --help for every option.
 *
 * Web version, which also burns dust tokens and NFTs so their accounts can
 * be closed too: https://solstack.xyz/tools/reclaim-solana-rent
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, clusterApiUrl } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  createHarvestWithheldTokensToMintInstruction,
} from "@solana/spl-token";

const USAGE = `Usage: node reclaim.mjs [options]

Options
  --keypair <path>        wallet keypair file (default ~/.config/solana/id.json)
  --to <address>          where the reclaimed SOL goes (default: the wallet itself)
  --cluster <name>        devnet (default), mainnet-beta or testnet
  --rpc <url>             RPC endpoint, overrides --cluster
  --priority-fee <n>      priority fee in micro-lamports per compute unit (default 0)
  --send                  close the accounts; without it nothing is sent
  --yes                   skip the confirmation prompt on mainnet
  -h, --help              show this help`;

const { values: opt } = parseArgs({
  options: {
    keypair: { type: "string", default: path.join(os.homedir(), ".config", "solana", "id.json") },
    to: { type: "string" },
    cluster: { type: "string", default: "devnet" },
    rpc: { type: "string" },
    "priority-fee": { type: "string", default: "0" },
    send: { type: "boolean", default: false },
    yes: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const fail = (msg) => {
  console.error(`\nError: ${msg}`);
  process.exit(1);
};
if (opt.help) {
  console.log(USAGE);
  process.exit(0);
}

// Transactions over 1,232 bytes are rejected by the network.
const MAX_TX_BYTES = 1232;
const BASE_FEE_LAMPORTS = 5000;
const GENESIS = {
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d": "mainnet",
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: "devnet",
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY": "testnet",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sol = (lamports) => (lamports / 1e9).toFixed(9).replace(/\.?0+$/, "");

const loadKeypair = (file) => {
  const full = file.replace(/^~(?=$|\/)/, os.homedir());
  if (!fs.existsSync(full)) fail(`no keypair at ${full}. Create one with \`solana-keygen new\` or pass --keypair.`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(full, "utf8"))));
};

// Greedily fill each transaction with whole accounts (a close, plus a fee
// harvest where needed) until the next one would push it past the size limit.
const pack = (items, feePayer, reserved) => {
  const size = (ixs) => {
    const tx = new Transaction({ feePayer, recentBlockhash: PublicKey.default.toBase58() }).add(...reserved, ...ixs);
    return tx.serializeMessage().length + 1 + 64;
  };
  const batches = [];
  let cur = [];
  for (const item of items) {
    const next = [...cur, item];
    if (cur.length && size(next.flatMap((x) => x.ixs)) > MAX_TX_BYTES) {
      batches.push(cur);
      cur = [item];
    } else cur = next;
  }
  if (cur.length) batches.push(cur);
  return batches;
};

// Send, rebroadcast every 2 s until confirmed, and only re-sign with a new
// blockhash once the old one has expired.
const sendAndConfirm = async (conn, build) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const raw = build(blockhash).serialize();
    const sig = await conn.sendRawTransaction(raw, { maxRetries: 0 });
    for (;;) {
      await sleep(2000);
      const { value: [st] } = await conn.getSignatureStatuses([sig]);
      if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
      if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) break;
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
    const { value: [st] } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    if (st && !st.err) return sig;
    console.log(`    ${sig} expired before it landed, signing again with a new blockhash`);
  }
  throw new Error("not confirmed after 3 attempts; the network may be congested, try --priority-fee");
};

// ---- find closable accounts ----------------------------------------------------
const rpc = opt.rpc || clusterApiUrl(opt.cluster === "mainnet" ? "mainnet-beta" : opt.cluster);
const conn = new Connection(rpc, "confirmed");
const cluster = GENESIS[await conn.getGenesisHash()] || "custom";
const wallet = loadKeypair(opt.keypair);
const owner = wallet.publicKey.toBase58();
let destination = wallet.publicKey;
if (opt.to) {
  try {
    destination = new PublicKey(opt.to);
  } catch {
    fail(`--to ${opt.to} is not an address`);
  }
}
const priorityFee = Number(opt["priority-fee"]);
if (!Number.isInteger(priorityFee) || priorityFee < 0) fail("--priority-fee must be a whole number of micro-lamports");

const closable = [];
const skipped = {};
let holding = 0;
let harvested = 0;
const skip = (why) => (skipped[why] = (skipped[why] || 0) + 1);
for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
  const { value } = await conn.getParsedTokenAccountsByOwner(wallet.publicKey, { programId });
  for (const { pubkey, account } of value) {
    const info = account.data.parsed.info;
    const ext = Object.fromEntries((info.extensions || []).map((e) => [e.extension, e.state]));
    if (info.tokenAmount.amount !== "0") holding++;
    else if (info.state === "frozen") skip("frozen by the token's freeze authority");
    else if (info.closeAuthority && info.closeAuthority !== owner) skip("another address holds the close authority");
    else if (ext.confidentialTransferAccount) skip("confidential transfer account");
    else {
      // Token-2022 accounts that received a transfer-fee token keep the fee
      // "withheld" and can't close until it moves to the mint. Anyone may do
      // that, so harvest it in the same transaction as the close.
      const withheld = Number(ext.transferFeeAmount?.withheldAmount || 0) > 0;
      if (withheld) harvested++;
      closable.push({
        pubkey,
        lamports: account.lamports,
        mint: info.mint,
        ixs: [
          ...(withheld ? [createHarvestWithheldTokensToMintInstruction(new PublicKey(info.mint), [pubkey], programId)] : []),
          createCloseAccountInstruction(pubkey, destination, wallet.publicKey, [], programId),
        ],
      });
    }
  }
}

// ---- plan ----------------------------------------------------------------------
const budgetIxs = (units) => [
  ComputeBudgetProgram.setComputeUnitLimit({ units }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
];
const batches = pack(closable, wallet.publicKey, priorityFee ? budgetIxs(1_400_000) : []);
const rent = closable.reduce((s, a) => s + a.lamports, 0);
const fees = batches.length * BASE_FEE_LAMPORTS;

console.log(`
Network          ${cluster} (${rpc})
Wallet           ${owner}${destination.equals(wallet.publicKey) ? "" : `\nSOL goes to      ${destination.toBase58()}`}
Empty accounts   ${closable.length} can be closed, ${sol(rent)} SOL of rent back${harvested ? `\n                 (${harvested} first ${harvested > 1 ? "move their" : "moves its"} withheld transfer fees to the mint)` : ""}
Transactions     ${batches.length} (network fees ${sol(fees)} SOL${priorityFee ? " plus priority fees" : ""})`);
for (const [why, n] of Object.entries(skipped)) console.log(`Skipped          ${n} ${n > 1 ? "accounts" : "account"}: ${why}`);
if (holding)
  console.log(`Still holding    ${holding} token account${holding > 1 ? "s" : ""} with a balance; send or burn the tokens first to close ${holding > 1 ? "them" : "it"}`);

if (!closable.length) {
  console.log("\nNothing to close.");
  process.exit(0);
}
if (!opt.send) {
  console.log(`\nDry run: nothing was sent. Add --send to close ${closable.length} account${closable.length > 1 ? "s" : ""}.`);
  process.exit(0);
}
if (fees > (await conn.getBalance(wallet.publicKey))) fail("the wallet doesn't have enough SOL for the network fees");
if (cluster === "mainnet" && !opt.yes) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nClose ${closable.length} accounts on mainnet? Type "yes" to continue: `);
  rl.close();
  if (answer.trim().toLowerCase() !== "yes") fail("cancelled");
}

// ---- close -----------------------------------------------------------------------
// A batch that fails simulation is retried one account at a time, so one odd
// account (a mint rule this script doesn't know about) doesn't block the rest.
let closed = 0;
let back = 0;
const run = async (batch, label) => {
  const ixs = batch.flatMap((a) => a.ixs);
  const probe = new Transaction({ feePayer: wallet.publicKey }).add(...(priorityFee ? budgetIxs(1_400_000) : []), ...ixs);
  const sim = await conn.simulateTransaction(probe);
  if (sim.value.err) {
    if (batch.length > 1) {
      for (const a of batch) await run([a], label);
      return;
    }
    console.log(`${label} skipped ${batch[0].pubkey.toBase58()} (mint ${batch[0].mint}): ${JSON.stringify(sim.value.err)}`);
    return;
  }
  const units = priorityFee ? Math.ceil(sim.value.unitsConsumed * 1.1) + 1000 : null;
  const sig = await sendAndConfirm(conn, (blockhash) => {
    const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash });
    if (units) tx.add(...budgetIxs(units));
    tx.add(...ixs).sign(wallet);
    return tx;
  });
  closed += batch.length;
  back += batch.reduce((s, a) => s + a.lamports, 0);
  console.log(`${label} closed ${batch.length}  ${sig}`);
};

console.log("");
for (const [i, batch] of batches.entries()) {
  try {
    await run(batch, `[${i + 1}/${batches.length}]`);
  } catch (e) {
    console.error(`\n[${i + 1}/${batches.length}] ${e.message}`);
    fail(`${closed} accounts closed so far (${sol(back)} SOL). Run the same command again to continue.`);
  }
}
console.log(`\nDone: ${closed} account${closed === 1 ? "" : "s"} closed, ${sol(back)} SOL back to ${destination.toBase58()}.`);
