/**
 * Self-Claim Script for Fact Market Users
 *
 * Allows users to claim trade payouts or refunds directly from the smart
 * contract using their exported receipt file, without relying on the
 * Fact Market backend.
 *
 * Usage:
 *   npx tsx scripts/self-claim.ts <receipts-file.json> [options]
 *
 * Options:
 *   --verify       Check receipt status without sending transactions (no mnemonic needed)
 *   --claim        Send claim/refund transactions (requires mnemonic)
 *   --network      TON network: mainnet (default) or testnet
 *   --api-key      TonCenter API key (optional, increases rate limits)
 *   --receipt       Claim a specific receipt by nonce (default: all eligible)
 *
 * Examples:
 *   npx tsx scripts/self-claim.ts my-receipts.json --verify
 *   npx tsx scripts/self-claim.ts my-receipts.json --claim
 *   npx tsx scripts/self-claim.ts my-receipts.json --claim --receipt 42
 */

import { TonClient, WalletContractV4, internal } from '@ton/ton';
import { Address, beginCell, toNano } from '@ton/core';
import { mnemonicToPrivateKey, mnemonicValidate } from '@ton/crypto';
import { readFileSync } from 'fs';
import { createInterface } from 'readline';

// ── Types ──────────────────────────────────────────────────────────────

interface TradeReceipt {
  signature: string; // Base64 Ed25519 signature
  nonce: number;
  userAddress: string; // TON wallet address
  contractAddress: string; // Escrow contract address
  marketId: string;
  outcome: number; // 1=YES, 2=NO
  amount: string; // nanotons as string
  question: string;
  timestamp: number;
  backendPublicKey: string; // hex
}

interface ReceiptExport {
  version: number;
  exportedAt: string;
  userAddress: string;
  receipts: TradeReceipt[];
}

interface ReceiptStatus {
  receipt: TradeReceipt;
  resolved: boolean;
  winningOutcome: number; // 0=NONE, 1=YES, 2=NO, 3=CANCEL
  nonceClaimed: boolean;
  action: 'claim' | 'refund' | 'none';
  reason: string;
  expectedPayout?: bigint;
}

// ── Constants ──────────────────────────────────────────────────────────

const CLAIM_OPCODE = 2139441659; // ClaimWinnings 0x7f8549fb
const REFUND_OPCODE = 1836462867; // RefundDeposit 0x6d763313
const GAS_AMOUNT = toNano('0.1'); // 0.1 TON gas per transaction

const ENDPOINTS: Record<string, string> = {
  mainnet: 'https://toncenter.com/api/v2/jsonRPC',
  testnet: 'https://testnet.toncenter.com/api/v2/jsonRPC'
};

// ── Message Builders ───────────────────────────────────────────────────

function buildClaimMessage(receipt: TradeReceipt) {
  const signatureBuffer = Buffer.from(receipt.signature, 'base64');
  const signatureCell = beginCell().storeBuffer(signatureBuffer).endCell();

  return beginCell()
    .storeUint(CLAIM_OPCODE, 32)
    .storeUint(receipt.nonce, 64)
    .storeAddress(Address.parse(receipt.userAddress))
    .storeUint(receipt.outcome, 8)
    .storeCoins(BigInt(receipt.amount))
    .storeStringRefTail(receipt.marketId)
    .storeRef(signatureCell)
    .endCell();
}

function buildRefundMessage(receipt: TradeReceipt) {
  const signatureBuffer = Buffer.from(receipt.signature, 'base64');
  const signatureCell = beginCell().storeBuffer(signatureBuffer).endCell();

  return beginCell()
    .storeUint(REFUND_OPCODE, 32)
    .storeUint(receipt.nonce, 64)
    .storeAddress(Address.parse(receipt.userAddress))
    .storeCoins(BigInt(receipt.amount))
    .storeStringRefTail(receipt.marketId)
    .storeRef(signatureCell)
    .endCell();
}

// ── Contract Queries ───────────────────────────────────────────────────

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 3000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRateLimit = msg.includes('429') || msg.includes('rate');
      if (isRateLimit && i < retries - 1) {
        await sleep(delayMs * (i + 1));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

async function getEscrowState(client: TonClient, contractAddress: string) {
  const address = Address.parse(contractAddress);

  // Query sequentially to avoid rate limits on free toncenter tier
  const resolved = await withRetry(() =>
    client.runMethod(address, 'getResolved').then((r) => r.stack.readBoolean())
  );
  const winningOutcome = await withRetry(() =>
    client.runMethod(address, 'getWinningOutcome').then((r) => r.stack.readNumber())
  );
  const totalPool = await withRetry(() =>
    client.runMethod(address, 'getTotalPool').then((r) => r.stack.readBigNumber())
  );
  const totalYes = await withRetry(() =>
    client.runMethod(address, 'getTotalYes').then((r) => r.stack.readBigNumber())
  );
  const totalNo = await withRetry(() =>
    client.runMethod(address, 'getTotalNo').then((r) => r.stack.readBigNumber())
  );
  const feePercentage = await withRetry(() =>
    client.runMethod(address, 'getFeePercentage').then((r) => r.stack.readNumber())
  );

  return { resolved, winningOutcome, totalPool, totalYes, totalNo, feePercentage };
}

async function isNonceClaimed(
  client: TonClient,
  contractAddress: string,
  nonce: number
): Promise<boolean> {
  const address = Address.parse(contractAddress);
  return withRetry(async () => {
    const result = await client.runMethod(address, 'isNonceClaimed', [
      { type: 'int', value: BigInt(nonce) }
    ]);
    return result.stack.readBoolean();
  });
}

// ── Formatting Helpers ─────────────────────────────────────────────────

function formatTON(nanotons: bigint | string): string {
  const value = typeof nanotons === 'string' ? BigInt(nanotons) : nanotons;
  const str = value.toString().padStart(10, '0');
  const whole = str.slice(0, -9) || '0';
  const frac = str.slice(-9).replace(/0+$/, '').padEnd(2, '0');
  return `${whole}.${frac} TON`;
}

function outcomeLabel(outcome: number): string {
  switch (outcome) {
    case 0:
      return 'UNRESOLVED';
    case 1:
      return 'YES';
    case 2:
      return 'NO';
    case 3:
      return 'CANCELLED';
    default:
      return `UNKNOWN(${outcome})`;
  }
}

function formatContractError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('exit_code: -13') || msg.includes('exit_code:-13')) {
    return 'Contract not active (not deployed or frozen)';
  }
  if (msg.includes('429')) {
    return 'Rate limited by RPC — try again with --api-key or wait a minute';
  }
  return msg;
}

// ── Receipt Analysis ───────────────────────────────────────────────────

async function analyzeReceipt(client: TonClient, receipt: TradeReceipt): Promise<ReceiptStatus> {
  try {
    const state = await getEscrowState(client, receipt.contractAddress);
    const claimed = await isNonceClaimed(client, receipt.contractAddress, receipt.nonce);

    if (!state.resolved) {
      return {
        receipt,
        resolved: false,
        winningOutcome: 0,
        nonceClaimed: claimed,
        action: 'none',
        reason: 'Market not yet resolved'
      };
    }

    if (claimed) {
      return {
        receipt,
        resolved: true,
        winningOutcome: state.winningOutcome,
        nonceClaimed: true,
        action: 'none',
        reason: 'Already claimed/refunded on-chain'
      };
    }

    // Cancelled market → refund
    if (state.winningOutcome === 3) {
      return {
        receipt,
        resolved: true,
        winningOutcome: 3,
        nonceClaimed: false,
        action: 'refund',
        reason: 'Market cancelled — eligible for refund',
        expectedPayout: BigInt(receipt.amount)
      };
    }

    // Check if the trade won
    if (receipt.outcome === state.winningOutcome) {
      // Calculate payout: amount * totalPool * (100 - fee) / (100 * winningTotal)
      const winningTotal = state.winningOutcome === 1 ? state.totalYes : state.totalNo;
      const payout =
        winningTotal > 0n
          ? (BigInt(receipt.amount) * state.totalPool * BigInt(100 - state.feePercentage)) /
            (100n * winningTotal)
          : 0n;

      return {
        receipt,
        resolved: true,
        winningOutcome: state.winningOutcome,
        nonceClaimed: false,
        action: 'claim',
        reason: `Won! Outcome: ${outcomeLabel(state.winningOutcome)}`,
        expectedPayout: payout
      };
    }

    return {
      receipt,
      resolved: true,
      winningOutcome: state.winningOutcome,
      nonceClaimed: false,
      action: 'none',
      reason: `Lost — winning outcome was ${outcomeLabel(state.winningOutcome)}, your trade was on ${outcomeLabel(receipt.outcome)}`
    };
  } catch (err) {
    return {
      receipt,
      resolved: false,
      winningOutcome: 0,
      nonceClaimed: false,
      action: 'none',
      reason: `Error querying contract: ${formatContractError(err)}`
    };
  }
}

// ── Interactive Mnemonic Input ─────────────────────────────────────────

async function promptMnemonic(): Promise<string[]> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  return new Promise((resolve) => {
    console.error('\n🔐 Enter your 24-word TON wallet mnemonic (space-separated):');
    console.error('   (Input is not echoed for security)\n');

    // Disable echo if possible
    if (process.stdin.isTTY) {
      process.stdin.setRawMode?.(true);
    }

    let input = '';

    if (process.stdin.isTTY) {
      // Raw mode: collect characters manually to hide input
      process.stdin.on('data', function handler(data: Buffer) {
        const char = data.toString();
        if (char === '\n' || char === '\r') {
          process.stdin.setRawMode?.(false);
          process.stdin.removeListener('data', handler);
          rl.close();
          console.error(''); // newline after hidden input
          const words = input.trim().split(/\s+/).filter(Boolean);
          resolve(words);
        } else if (char === '\u0003') {
          // Ctrl+C
          process.exit(1);
        } else if (char === '\u007f' || char === '\b') {
          // Backspace
          input = input.slice(0, -1);
        } else {
          input += char;
        }
      });
    } else {
      // Non-TTY (piped input): read line normally
      rl.question('', (answer) => {
        rl.close();
        const words = answer.trim().split(/\s+/).filter(Boolean);
        resolve(words);
      });
    }
  });
}

// ── Claim Execution ────────────────────────────────────────────────────

async function executeClaims(
  client: TonClient,
  statuses: ReceiptStatus[],
  mnemonic: string[]
): Promise<void> {
  const actionable = statuses.filter((s) => s.action !== 'none');
  if (actionable.length === 0) {
    console.log('\n✅ No actionable receipts. Nothing to claim or refund.');
    return;
  }

  // Derive wallet
  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
  const walletContract = client.open(wallet);

  const walletAddress = wallet.address.toString({ bounceable: false });
  console.log(`\n📬 Sending wallet: ${walletAddress}`);

  const balance = await walletContract.getBalance();
  const requiredGas = GAS_AMOUNT * BigInt(actionable.length);
  console.log(`💰 Wallet balance: ${formatTON(balance)}`);
  console.log(
    `⛽ Required gas:   ${formatTON(requiredGas)} (${formatTON(GAS_AMOUNT)} × ${actionable.length})`
  );

  if (balance < requiredGas + toNano('0.05')) {
    console.error(
      `\n❌ Insufficient balance. Need at least ${formatTON(requiredGas + toNano('0.05'))} (gas + reserve).`
    );
    process.exit(1);
  }

  let seqno = await walletContract.getSeqno();

  for (const status of actionable) {
    const { receipt, action } = status;
    const label = `[Nonce ${receipt.nonce}] "${receipt.question}"`;

    console.log(`\n─── ${label} ───`);
    console.log(`  Action: ${action.toUpperCase()}`);
    console.log(
      `  Amount: ${formatTON(receipt.amount)} staked → ${status.expectedPayout ? formatTON(status.expectedPayout) : 'N/A'} payout`
    );
    console.log(`  Contract: ${receipt.contractAddress}`);

    try {
      const body = action === 'claim' ? buildClaimMessage(receipt) : buildRefundMessage(receipt);

      await walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: Address.parse(receipt.contractAddress),
            value: GAS_AMOUNT,
            body
          })
        ]
      });

      console.log(`  ✅ Transaction sent (seqno: ${seqno})`);

      // Wait for seqno to increment (confirms wallet processed the message)
      const startTime = Date.now();
      const timeout = 60_000;
      let confirmed = false;

      while (Date.now() - startTime < timeout) {
        await sleep(3000);
        try {
          const currentSeqno = await walletContract.getSeqno();
          if (currentSeqno > seqno) {
            confirmed = true;
            break;
          }
        } catch {
          // Retry on transient errors
        }
      }

      if (confirmed) {
        console.log(`  ✅ Confirmed on-chain`);
      } else {
        console.log(`  ⏳ Timeout waiting for confirmation — tx may still be processing`);
      }

      seqno++;
    } catch (err) {
      console.error(`  ❌ Failed: ${err instanceof Error ? err.message : err}`);
    }

    // Rate-limit between transactions
    if (actionable.indexOf(status) < actionable.length - 1) {
      await sleep(5000);
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printUsage(): void {
  console.log(`
Fact Market Self-Claim Script
═══════════════════════════════

Claim your trade payouts or refunds directly from the smart contract,
without relying on the Fact Market backend.

Usage:
  npx tsx scripts/self-claim.ts <receipts-file.json> [options]

Options:
  --verify          Check receipt status only (no transactions, no mnemonic needed)
  --claim           Send claim/refund transactions (requires wallet mnemonic)
  --network <net>   TON network: mainnet (default) or testnet
  --api-key <key>   TonCenter API key (optional, for higher rate limits)
  --receipt <nonce>  Process only this receipt nonce (default: all eligible)
  --help            Show this help message

Examples:
  # Check status of all your receipts
  npx tsx scripts/self-claim.ts my-receipts.json --verify

  # Claim all eligible payouts/refunds
  npx tsx scripts/self-claim.ts my-receipts.json --claim

  # Claim a specific receipt
  npx tsx scripts/self-claim.ts my-receipts.json --claim --receipt 42

  # Use testnet
  npx tsx scripts/self-claim.ts my-receipts.json --verify --network testnet
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  // Parse arguments
  const receiptFile = args.find((a) => !a.startsWith('--'));
  const mode = args.includes('--claim') ? 'claim' : 'verify';
  const network = args.includes('--network')
    ? args[args.indexOf('--network') + 1] || 'mainnet'
    : 'mainnet';
  const apiKey = args.includes('--api-key') ? args[args.indexOf('--api-key') + 1] : undefined;
  const filterNonce = args.includes('--receipt')
    ? parseInt(args[args.indexOf('--receipt') + 1], 10)
    : undefined;

  if (!receiptFile) {
    console.error('❌ No receipt file specified. Run with --help for usage.');
    process.exit(1);
  }

  // Load receipts
  let exportData: ReceiptExport;
  try {
    const raw = readFileSync(receiptFile, 'utf-8');
    exportData = JSON.parse(raw);
  } catch (err) {
    console.error(`❌ Failed to read receipt file: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  if (!exportData.receipts || !Array.isArray(exportData.receipts)) {
    console.error('❌ Invalid receipt file format. Expected { version, receipts: [...] }');
    process.exit(1);
  }

  let receipts = exportData.receipts;

  if (filterNonce !== undefined) {
    receipts = receipts.filter((r) => r.nonce === filterNonce);
    if (receipts.length === 0) {
      console.error(`❌ No receipt found with nonce ${filterNonce}`);
      process.exit(1);
    }
  }

  console.log(`
╔══════════════════════════════════════════════╗
║   Fact Market — Self-Claim Script            ║
╚══════════════════════════════════════════════╝
`);
  console.log(`📄 Receipt file: ${receiptFile}`);
  console.log(`📋 Receipts:     ${receipts.length}`);
  console.log(`🌐 Network:      ${network}`);
  console.log(
    `🔍 Mode:         ${mode === 'verify' ? 'VERIFY (read-only)' : 'CLAIM (will send transactions)'}`
  );

  // Connect to TON
  const endpoint = ENDPOINTS[network];
  if (!endpoint) {
    console.error(`❌ Unknown network: ${network}. Use "mainnet" or "testnet".`);
    process.exit(1);
  }

  const client = new TonClient({
    endpoint,
    apiKey
  });

  // Analyze all receipts
  console.log('\n─── Analyzing receipts ───\n');

  const statuses: ReceiptStatus[] = [];

  for (const receipt of receipts) {
    process.stdout.write(`  Checking nonce ${receipt.nonce}... `);
    const status = await analyzeReceipt(client, receipt);
    statuses.push(status);

    const actionIcon = status.action === 'claim' ? '💰' : status.action === 'refund' ? '🔄' : '·';
    console.log(`${actionIcon} ${status.reason}`);

    // Rate limit contract queries (toncenter free tier is ~1 req/sec)
    await sleep(2000);
  }

  // Summary
  const claimable = statuses.filter((s) => s.action === 'claim');
  const refundable = statuses.filter((s) => s.action === 'refund');
  const alreadyClaimed = statuses.filter((s) => s.nonceClaimed);
  const lost = statuses.filter(
    (s) => s.resolved && !s.nonceClaimed && s.action === 'none' && s.winningOutcome !== 0
  );
  const pending = statuses.filter((s) => !s.resolved);

  const totalClaimPayout = claimable.reduce((sum, s) => sum + (s.expectedPayout || 0n), 0n);
  const totalRefundPayout = refundable.reduce((sum, s) => sum + (s.expectedPayout || 0n), 0n);

  console.log('\n─── Summary ───\n');
  console.log(
    `  💰 Claimable:       ${claimable.length} receipts (${formatTON(totalClaimPayout)} total payout)`
  );
  console.log(
    `  🔄 Refundable:      ${refundable.length} receipts (${formatTON(totalRefundPayout)} total refund)`
  );
  console.log(`  ✅ Already claimed: ${alreadyClaimed.length} receipts`);
  console.log(`  ❌ Lost:            ${lost.length} receipts`);
  console.log(`  ⏳ Pending:         ${pending.length} receipts`);

  if (claimable.length > 0) {
    console.log('\n  Claimable details:');
    for (const s of claimable) {
      console.log(
        `    Nonce ${s.receipt.nonce}: "${s.receipt.question}" — ${outcomeLabel(s.receipt.outcome)} — Payout: ${s.expectedPayout ? formatTON(s.expectedPayout) : 'N/A'}`
      );
    }
  }

  if (refundable.length > 0) {
    console.log('\n  Refundable details:');
    for (const s of refundable) {
      console.log(
        `    Nonce ${s.receipt.nonce}: "${s.receipt.question}" — Refund: ${formatTON(s.receipt.amount)}`
      );
    }
  }

  // Verify mode: done
  if (mode === 'verify') {
    if (claimable.length > 0 || refundable.length > 0) {
      console.log('\n💡 To claim, run again with --claim flag.');
    }
    return;
  }

  // Claim mode
  const actionable = statuses.filter((s) => s.action !== 'none');
  if (actionable.length === 0) {
    console.log('\n✅ No actionable receipts.');
    return;
  }

  // Get mnemonic
  console.log('\n⚠️  You are about to send on-chain transactions.');
  console.log('   Your mnemonic is needed to sign transactions from your wallet.');
  console.log('   It will NOT be stored or transmitted anywhere.\n');

  const mnemonic = await promptMnemonic();

  if (mnemonic.length !== 24) {
    console.error(`❌ Expected 24 words, got ${mnemonic.length}. Please try again.`);
    process.exit(1);
  }

  const valid = await mnemonicValidate(mnemonic);
  if (!valid) {
    console.error('❌ Invalid mnemonic. Please check your words and try again.');
    process.exit(1);
  }

  // Verify the mnemonic corresponds to the receipt's userAddress
  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
  const walletAddr = wallet.address;

  // Check if wallet matches any receipt's userAddress
  const firstReceipt = actionable[0].receipt;
  try {
    const receiptAddr = Address.parse(firstReceipt.userAddress);
    // Note: the sending wallet doesn't need to match the receipt address.
    // Anyone can submit a claim — funds go to receipt.userAddress regardless.
    // But we warn if they don't match, since the user might be confused.
    if (!walletAddr.equals(receiptAddr)) {
      console.log('\n⚠️  Note: Your wallet address does not match the receipt address.');
      console.log(`   Your wallet:    ${walletAddr.toString({ bounceable: false })}`);
      console.log(`   Receipt address: ${firstReceipt.userAddress}`);
      console.log('   This is OK — anyone can submit claims. Funds go to the receipt address.');
      console.log('   You will pay the gas fee (~0.1 TON per transaction).\n');
    }
  } catch {
    // Address parse failed, skip check
  }

  await executeClaims(client, statuses, mnemonic);

  console.log('\n═══ Done ═══\n');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
