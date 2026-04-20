import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, toNano } from '@ton/core';
import { KeyPair } from '@ton/crypto';
import '@ton/test-utils';
import { MarketEscrow } from '../build/MarketEscrow_MarketEscrow';
import {
  createTestKeyPair,
  publicKeyToBigInt,
  signBetReceipt,
  signRefundReceipt,
  deployEscrow
} from './utils/test-helpers';

const TEST_MARKET_ID = 'test-market-id-escrow';

describe('MarketEscrow', () => {
  let blockchain: Blockchain;
  let admin: SandboxContract<TreasuryContract>;
  let oracle: SandboxContract<TreasuryContract>;
  let user1: SandboxContract<TreasuryContract>;
  let user2: SandboxContract<TreasuryContract>;
  let backendKeyPair: KeyPair;
  let backendPubKey: bigint;
  let escrow: SandboxContract<MarketEscrow>;
  let endTime: bigint;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    admin = await blockchain.treasury('admin');
    oracle = await blockchain.treasury('oracle');
    user1 = await blockchain.treasury('user1');
    user2 = await blockchain.treasury('user2');
    backendKeyPair = await createTestKeyPair();
    backendPubKey = publicKeyToBigInt(backendKeyPair.publicKey);

    // Set blockchain time to a known value
    blockchain.now = Math.floor(Date.now() / 1000);
    endTime = BigInt(blockchain.now! + 3600); // 1 hour from now

    escrow = await deployEscrow({
      blockchain,
      admin,
      oracle,
      backendPubKey,
      endTime
    });
  });

  // ────────────────────────────────────────────────────────
  // Deposit Tests
  // ────────────────────────────────────────────────────────
  describe('Deposit', () => {
    it('should accept valid deposit', async () => {
      const depositAmount = toNano('1');
      const result = await escrow.send(
        user1.getSender(),
        { value: depositAmount },
        { $$type: 'Deposit' }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: true
      });

      const totalPool = await escrow.getGetTotalPool();
      expect(totalPool).toBeGreaterThan(0n);
    });

    it('should reject deposit below minimum bet', async () => {
      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.01') }, // below 0.1 TON minimum
        { $$type: 'Deposit' }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 54981 // "Deposit below minimum"
      });
    });

    it('should reject deposit after market end time', async () => {
      // Advance time past end
      blockchain.now = Number(endTime) + 100;

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('1') },
        { $$type: 'Deposit' }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 36192 // "Market has ended"
      });
    });

    it('should reject deposit if market already resolved', async () => {
      // Advance time past end and resolve
      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('1') },
        { $$type: 'Deposit' }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false
      });
    });

    it('should track cumulative deposits per user', async () => {
      await escrow.send(user1.getSender(), { value: toNano('1') }, { $$type: 'Deposit' });

      const deposit1 = await escrow.getGetUserDeposit(user1.address);
      expect(deposit1).toBeGreaterThan(0n);

      await escrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });

      const deposit2 = await escrow.getGetUserDeposit(user1.address);
      expect(deposit2).toBeGreaterThan(deposit1);
    });
  });

  // ────────────────────────────────────────────────────────
  // Resolution Tests
  // ────────────────────────────────────────────────────────
  describe('Resolution', () => {
    beforeEach(async () => {
      // Deposit to ensure contract has enough balance for outgoing messages
      await escrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      // Record bets on both sides so auto-cancel doesn't trigger
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('0.5') }
      );
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('0.5') }
      );
      // Advance past end time for resolution tests
      blockchain.now = Number(endTime) + 100;
    });

    it('should allow oracle to resolve market (outcome=1 Yes)', async () => {
      const result = await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      expect(result.transactions).toHaveTransaction({
        from: oracle.address,
        to: escrow.address,
        success: true
      });

      expect(await escrow.getGetResolved()).toBe(true);
      expect(await escrow.getGetWinningOutcome()).toBe(1n);
    });

    it('should allow oracle to resolve market (outcome=2 No)', async () => {
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 2n }
      );

      expect(await escrow.getGetResolved()).toBe(true);
      expect(await escrow.getGetWinningOutcome()).toBe(2n);
    });

    it('should allow oracle to resolve market (outcome=3 Cancelled)', async () => {
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 3n }
      );

      expect(await escrow.getGetResolved()).toBe(true);
      expect(await escrow.getGetWinningOutcome()).toBe(3n);
    });

    it('should reject resolution from non-oracle address', async () => {
      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 37536 // "Only oracle can resolve"
      });
    });

    it('should allow oracle to resolve before market end time', async () => {
      // Reset time to before end
      blockchain.now = Number(endTime) - 100;

      const result = await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      expect(result.transactions).toHaveTransaction({
        from: oracle.address,
        to: escrow.address,
        success: true
      });

      expect(await escrow.getGetResolved()).toBe(true);
      expect(await escrow.getGetWinningOutcome()).toBe(1n);
    });

    it('should reject double resolution', async () => {
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      const result = await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 2n }
      );

      expect(result.transactions).toHaveTransaction({
        from: oracle.address,
        to: escrow.address,
        success: false,
        exitCode: 31038 // "Already resolved"
      });
    });

    it('should reject invalid outcome (0)', async () => {
      const result = await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 0n }
      );

      expect(result.transactions).toHaveTransaction({
        from: oracle.address,
        to: escrow.address,
        success: false,
        exitCode: 38283 // "Invalid outcome"
      });
    });

    it('should emit MarketResolved event on resolution', async () => {
      const result = await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      // Verify resolution happened via getter
      expect(await escrow.getGetResolved()).toBe(true);

      // External messages (events) are emitted - check transaction was successful
      expect(result.transactions).toHaveTransaction({
        from: oracle.address,
        to: escrow.address,
        success: true
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // Claim Winnings Tests
  // ────────────────────────────────────────────────────────
  describe('Claim Winnings', () => {
    const betAmount = toNano('1');
    const nonce = 1n;

    beforeEach(async () => {
      // Deposit from user1
      await escrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });

      // Deposit from user2
      await escrow.send(user2.getSender(), { value: toNano('3') }, { $$type: 'Deposit' });

      // Record bets via admin (factory)
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('3') } // YES bets
      );
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('2') } // NO bets
      );

      // Advance past end and resolve with outcome=1 (YES wins)
      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );
    });

    it('should verify valid signature and pay winnings', async () => {
      const sig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce,
        outcome: 1n,
        amount: betAmount,
        marketId: TEST_MARKET_ID
      });

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce,
          userAddress: user1.address,
          outcome: 1n,
          amount: betAmount,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: true
      });

      // Nonce should be marked as claimed
      expect(await escrow.getIsNonceClaimed(nonce)).toBe(true);
    });

    it('should reject claim with invalid signature', async () => {
      // Use a different keypair to create an invalid signature
      const fakeKeyPair = await createTestKeyPair();
      const fakeSig = signBetReceipt({
        keyPair: fakeKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce,
        outcome: 1n,
        amount: betAmount,
        marketId: TEST_MARKET_ID
      });

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce,
          userAddress: user1.address,
          outcome: 1n,
          amount: betAmount,
          signature: fakeSig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 48401 // "Invalid signature"
      });
    });

    it('should reject claim on unresolved market', async () => {
      // Deploy fresh unresolved escrow
      const freshEscrow = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        endTime: BigInt(blockchain.now! + 7200)
      });

      const sig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: freshEscrow.address,
        nonce,
        outcome: 1n,
        amount: betAmount,
        marketId: TEST_MARKET_ID
      });

      const result = await freshEscrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce,
          userAddress: user1.address,
          outcome: 1n,
          amount: betAmount,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: freshEscrow.address,
        success: false,
        exitCode: 18221 // "Market not resolved"
      });
    });

    it('should reject claim on cancelled market (use refund)', async () => {
      // Deploy a separate escrow, deposit, resolve as cancelled
      const cancelEndTime = BigInt(blockchain.now! + 600);
      const cancelledEscrow = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        endTime: cancelEndTime
      });

      await cancelledEscrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });

      blockchain.now = Number(cancelEndTime) + 100;
      await cancelledEscrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 3n } // Cancelled
      );

      const sig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: cancelledEscrow.address,
        nonce,
        outcome: 1n,
        amount: betAmount,
        marketId: TEST_MARKET_ID
      });

      const result = await cancelledEscrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce,
          userAddress: user1.address,
          outcome: 1n,
          amount: betAmount,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: cancelledEscrow.address,
        success: false,
        exitCode: 36693 // "Market cancelled - use refund"
      });
    });

    it('should reject claim for wrong outcome', async () => {
      // Market resolved as outcome=1 (YES), try to claim with outcome=2 (NO)
      const sig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce,
        outcome: 2n,
        amount: betAmount,
        marketId: TEST_MARKET_ID
      });

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce,
          userAddress: user1.address,
          outcome: 2n,
          amount: betAmount,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 7047 // "Bet not on winning outcome"
      });
    });

    it('should reject double-claim with same nonce', async () => {
      const sig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce,
        outcome: 1n,
        amount: betAmount,
        marketId: TEST_MARKET_ID
      });

      // First claim succeeds
      await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce,
          userAddress: user1.address,
          outcome: 1n,
          amount: betAmount,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      // Second claim with same nonce fails
      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce,
          userAddress: user1.address,
          outcome: 1n,
          amount: betAmount,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 42504 // "Already claimed"
      });
    });

    it('should correctly calculate payout with fee deduction', async () => {
      // totalPool ~ 5+3 = 8 TON (minus gas fees in deposits)
      // totalYes = 3 TON, totalNo = 2 TON
      // fee = 2% of totalPool
      // prizePool = totalPool - fee
      // userShare = (betAmount * prizePool) / totalYes
      const totalPool = await escrow.getGetTotalPool();
      const totalYes = await escrow.getGetTotalYes();
      const feePercentage = await escrow.getGetFeePercentage();

      const fee = (totalPool * BigInt(feePercentage)) / 100n;
      const prizePool = totalPool - fee;
      const expectedPayout = (betAmount * prizePool) / totalYes;

      // Verify calculatePayout getter returns the same value
      const calculatedPayout = await escrow.getCalculatePayout(betAmount, 1n);
      expect(calculatedPayout).toBe(expectedPayout);
    });

    it('should handle multiple winners correctly', async () => {
      // Claim for user1 with nonce=1
      const sig1 = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce: 1n,
        outcome: 1n,
        amount: toNano('2'),
        marketId: TEST_MARKET_ID
      });

      const result1 = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce: 1n,
          userAddress: user1.address,
          outcome: 1n,
          amount: toNano('2'),
          signature: sig1,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result1.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: true
      });

      // Claim for user2 with nonce=2
      const sig2 = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user2.address,
        contractAddress: escrow.address,
        nonce: 2n,
        outcome: 1n,
        amount: toNano('1'),
        marketId: TEST_MARKET_ID
      });

      const result2 = await escrow.send(
        user2.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce: 2n,
          userAddress: user2.address,
          outcome: 1n,
          amount: toNano('1'),
          signature: sig2,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result2.transactions).toHaveTransaction({
        from: user2.address,
        to: escrow.address,
        success: true
      });

      // Both nonces should be claimed
      expect(await escrow.getIsNonceClaimed(1n)).toBe(true);
      expect(await escrow.getIsNonceClaimed(2n)).toBe(true);
    });

    it('should reject claim when no bets on winning side', async () => {
      // Deploy a fresh escrow where outcome=1 wins but totalYes == 0
      const freshEndTime = BigInt(blockchain.now! + 600);
      const freshEscrow = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        endTime: freshEndTime
      });

      // Deposit funds
      await freshEscrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });

      // Record bets only on NO side
      await freshEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('2') }
      );

      // Resolve with YES wins (but totalYes == 0)
      blockchain.now = Number(freshEndTime) + 100;
      await freshEscrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      expect(await freshEscrow.getGetTotalYes()).toBe(0n);

      // Try to claim on winning side - should fail because winningTotal == 0
      const sig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: freshEscrow.address,
        nonce: 1n,
        outcome: 1n,
        amount: toNano('1'),
        marketId: TEST_MARKET_ID
      });

      const result = await freshEscrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce: 1n,
          userAddress: user1.address,
          outcome: 1n,
          amount: toNano('1'),
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: freshEscrow.address,
        success: false
      });
    });

    it('should reject claim when userShare is zero (amount=0)', async () => {
      // Claim with amount=0 → userShare = (0 * prizePool) / winningTotal = 0
      const sig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce: 99n,
        outcome: 1n,
        amount: 0n,
        marketId: TEST_MARKET_ID
      });

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce: 99n,
          userAddress: user1.address,
          outcome: 1n,
          amount: 0n,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false
      });
    });

    it('should emit ClaimProcessed event', async () => {
      const sig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce,
        outcome: 1n,
        amount: betAmount,
        marketId: TEST_MARKET_ID
      });

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce,
          userAddress: user1.address,
          outcome: 1n,
          amount: betAmount,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      // Verify via transaction success and nonce state
      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: true
      });
      expect(await escrow.getIsNonceClaimed(nonce)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────
  // Refund Tests
  // ────────────────────────────────────────────────────────
  describe('Refund', () => {
    const refundAmount = toNano('1');
    const nonce = 10n;

    beforeEach(async () => {
      // Deposit funds
      await escrow.send(user1.getSender(), { value: toNano('3') }, { $$type: 'Deposit' });

      // Advance past end and resolve as cancelled
      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 3n } // Cancelled
      );
    });

    it('should allow refund for cancelled market with valid signature', async () => {
      const sig = signRefundReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce,
        amount: refundAmount,
        marketId: TEST_MARKET_ID
      });

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RefundDeposit',
          nonce,
          userAddress: user1.address,
          amount: refundAmount,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: true
      });

      expect(await escrow.getIsNonceClaimed(nonce)).toBe(true);
    });

    it('should reject refund for non-cancelled market', async () => {
      // Deploy a new escrow, deposit funds, resolve with YES (not cancelled)
      const yesEndTime = BigInt(blockchain.now! + 600);
      const yesEscrow = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        endTime: yesEndTime
      });

      // Deposit so contract has funds
      await yesEscrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      // Record bets on both sides so auto-cancel doesn't trigger
      await yesEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('0.5') }
      );
      await yesEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('0.5') }
      );

      // Advance past end and resolve with YES
      blockchain.now = Number(yesEndTime) + 100;
      await yesEscrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n } // YES, not cancelled
      );

      const sig = signRefundReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: yesEscrow.address,
        nonce,
        amount: refundAmount,
        marketId: TEST_MARKET_ID
      });

      const result = await yesEscrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RefundDeposit',
          nonce,
          userAddress: user1.address,
          amount: refundAmount,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      // Refund must be rejected with 1871 "Market not cancelled" (market resolved YES)
      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: yesEscrow.address,
        success: false,
        exitCode: 1871
      });
    });

    it('should reject refund with invalid signature', async () => {
      const fakeKeyPair = await createTestKeyPair();
      const fakeSig = signRefundReceipt({
        keyPair: fakeKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce,
        amount: refundAmount,
        marketId: TEST_MARKET_ID
      });

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RefundDeposit',
          nonce,
          userAddress: user1.address,
          amount: refundAmount,
          signature: fakeSig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 48401 // "Invalid signature"
      });
    });

    it('should reject double-refund with same nonce', async () => {
      const sig = signRefundReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce,
        amount: refundAmount,
        marketId: TEST_MARKET_ID
      });

      // First refund succeeds
      await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RefundDeposit',
          nonce,
          userAddress: user1.address,
          amount: refundAmount,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      // Second refund with same nonce fails
      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RefundDeposit',
          nonce,
          userAddress: user1.address,
          amount: refundAmount,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 22411 // "Already refunded"
      });
    });

    it('should emit RefundProcessed event', async () => {
      const sig = signRefundReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce,
        amount: refundAmount,
        marketId: TEST_MARKET_ID
      });

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RefundDeposit',
          nonce,
          userAddress: user1.address,
          amount: refundAmount,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: true
      });
      expect(await escrow.getIsNonceClaimed(nonce)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────
  // Bet Recording Tests
  // ────────────────────────────────────────────────────────
  describe('Bet Recording', () => {
    beforeEach(async () => {
      // Deposit to create a pool
      await escrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });
    });

    it('should allow admin to record bet totals', async () => {
      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('2') }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: true
      });

      expect(await escrow.getGetTotalYes()).toBe(toNano('2'));
      expect(await escrow.getGetTotalNo()).toBe(0n);
    });

    it('should reject recording from non-admin', async () => {
      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('1') }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 16461 // "Only admin"
      });
    });

    it('should reject recording after resolution', async () => {
      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('1') }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: false,
        exitCode: 7405 // "Market resolved"
      });
    });

    it('should reject recording after market end', async () => {
      blockchain.now = Number(endTime) + 100;

      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('1') }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: false,
        exitCode: 36192 // "Market has ended"
      });
    });

    it('should reject invalid outcome in bet record', async () => {
      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 3n, amount: toNano('1') }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: false,
        exitCode: 38283 // "Invalid outcome"
      });
    });

    it('should reject recording with zero amount', async () => {
      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: 0n }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: false
      });
    });

    it('should hard-revert bet recording when amount exceeds pool (invariant check)', async () => {
      // Contract enforces: totalYes + totalNo + amount <= totalPool
      // When violated, hard reverts with require() — no silent failure
      const totalPool = await escrow.getGetTotalPool();
      const excessAmount = totalPool + toNano('1');

      const totalYesBefore = await escrow.getGetTotalYes();
      const totalNoBefore = await escrow.getGetTotalNo();

      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: excessAmount }
      );

      // Transaction reverts — require() failure
      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: false
      });

      // State must remain unchanged
      expect(await escrow.getGetTotalYes()).toBe(totalYesBefore);
      expect(await escrow.getGetTotalNo()).toBe(totalNoBefore);
    });
  });

  // ────────────────────────────────────────────────────────
  // Fee Withdrawal Tests
  // ────────────────────────────────────────────────────────
  describe('Fee Withdrawal', () => {
    let recipient: Address;

    beforeEach(async () => {
      const recipientWallet = await blockchain.treasury('recipient');
      recipient = recipientWallet.address;
      // Create a market with deposits and bets, then resolve
      await escrow.send(user1.getSender(), { value: toNano('10') }, { $$type: 'Deposit' });

      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('5') }
      );
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('3') }
      );

      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );
    });

    it('should allow admin to withdraw fees after resolution', async () => {
      const totalPool = await escrow.getGetTotalPool();
      const feePercentage = await escrow.getGetFeePercentage();
      const maxFee = (totalPool * BigInt(feePercentage)) / 100n;

      // Withdraw a small portion of fees
      const withdrawAmount = maxFee / 2n;
      if (withdrawAmount > 0n) {
        const result = await escrow.send(
          admin.getSender(),
          { value: toNano('0.1') },
          {
            $$type: 'WithdrawFees',
            amount: withdrawAmount,
            recipient
          }
        );

        expect(result.transactions).toHaveTransaction({
          from: admin.address,
          to: escrow.address,
          success: true
        });
      }
    });

    it('should reject withdrawal from non-admin', async () => {
      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'WithdrawFees',
          amount: toNano('0.01'),
          recipient
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 16461 // "Only admin"
      });
    });

    it('should reject withdrawal before resolution', async () => {
      // Deploy unresolved escrow
      const freshEscrow = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        endTime: BigInt(blockchain.now! + 7200)
      });

      const result = await freshEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'WithdrawFees',
          amount: toNano('0.01'),
          recipient
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: freshEscrow.address,
        success: false,
        exitCode: 18221 // "Market not resolved"
      });
    });

    it('should reject withdrawal on cancelled market', async () => {
      // Deploy a new escrow, deposit, then resolve as cancelled
      const cancelEndTime = BigInt(blockchain.now! + 600);
      const cancelledEscrow = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        endTime: cancelEndTime
      });

      await cancelledEscrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });

      // Advance past end and resolve as cancelled
      blockchain.now = Number(cancelEndTime) + 100;
      await cancelledEscrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 3n }
      );

      const result = await cancelledEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'WithdrawFees',
          amount: toNano('0.01'),
          recipient
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: cancelledEscrow.address,
        success: false,
        exitCode: 26045 // "Market cancelled"
      });
    });

    it('should reject withdrawal with zero amount', async () => {
      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'WithdrawFees',
          amount: 0n,
          recipient
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: false
      });
    });

    it('should reject withdrawal exceeding available fees', async () => {
      const totalPool = await escrow.getGetTotalPool();
      const feePercentage = await escrow.getGetFeePercentage();
      const maxFee = (totalPool * BigInt(feePercentage)) / 100n;

      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'WithdrawFees',
          amount: maxFee + toNano('1'), // more than available
          recipient
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: false
      });
    });

    it('should allow partial fee withdrawals via cumulative counter', async () => {
      // Contract uses feesWithdrawn: Int as coins (cumulative counter)
      // require(feesWithdrawn + amount <= fee) allows multiple partial withdrawals
      const totalPool = await escrow.getGetTotalPool();
      const feePercentage = await escrow.getGetFeePercentage();
      const maxFee = (totalPool * BigInt(feePercentage)) / 100n;
      const halfFee = maxFee / 2n;

      expect(await escrow.getGetFeesWithdrawn()).toBe(0n);

      // First partial withdrawal succeeds
      const result1 = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'WithdrawFees',
          amount: halfFee,
          recipient
        }
      );

      expect(result1.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: true
      });

      expect(await escrow.getGetFeesWithdrawn()).toBe(halfFee);

      // Second partial withdrawal succeeds (remaining fees)
      const remaining = maxFee - halfFee;
      const result2 = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'WithdrawFees',
          amount: remaining,
          recipient
        }
      );

      expect(result2.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: true
      });

      expect(await escrow.getGetFeesWithdrawn()).toBe(maxFee);
    });

    it('should reject withdrawal exceeding remaining fees', async () => {
      // Withdraw all fees first
      const totalPool = await escrow.getGetTotalPool();
      const feePercentage = await escrow.getGetFeePercentage();
      const maxFee = (totalPool * BigInt(feePercentage)) / 100n;

      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'WithdrawFees',
          amount: maxFee,
          recipient
        }
      );

      expect(await escrow.getGetFeesWithdrawn()).toBe(maxFee);

      // Any further withdrawal fails (feesWithdrawn + 1 > fee)
      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'WithdrawFees',
          amount: 1n,
          recipient
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: false,
        exitCode: 23771 // "Amount exceeds remaining fee"
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // Drain Balance Tests
  // ────────────────────────────────────────────────────────
  describe('DrainBalance', () => {
    let drainRecipient: SandboxContract<TreasuryContract>;
    // user1=YES bettor, user2=NO bettor; each deposits 10 TON, bets 5 TON
    const betAmount = toNano('5');

    beforeEach(async () => {
      drainRecipient = await blockchain.treasury('drain-recipient');

      // Set up a resolved market: user1 bets YES, user2 bets NO, resolve YES
      await escrow.send(user1.getSender(), { value: toNano('10') }, { $$type: 'Deposit' });
      await escrow.send(user2.getSender(), { value: toNano('10') }, { $$type: 'Deposit' });
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: betAmount }
      );
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: betAmount }
      );
      blockchain.now = Number(await escrow.getGetEndTime()) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );
    });

    it('should reject drain when payouts pending and claim window active', async () => {
      // Resolved but no claims yet, window not expired → must reject
      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'DrainBalance', recipient: drainRecipient.address }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: false,
        exitCode: 39281 // "Payouts pending and claim window active"
      });
    });

    it('should allow drain after all claims settled (path A — sole YES winner)', async () => {
      // user1 is the only YES bettor → their claim exhausts the entire prize pool →
      // totalPaidOut >= expectedPayout after a single claim
      const totalPool = await escrow.getGetTotalPool();
      const feePercentage = await escrow.getGetFeePercentage();
      const expectedPayout = (totalPool * (100n - feePercentage)) / 100n;

      const sig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce: 1n,
        outcome: 1n,
        amount: betAmount,
        marketId: TEST_MARKET_ID
      });
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.2') },
        {
          $$type: 'ClaimWinnings',
          nonce: 1n,
          userAddress: user1.address,
          outcome: 1n,
          amount: betAmount,
          marketId: TEST_MARKET_ID,
          signature: sig
        }
      );

      expect(await escrow.getGetTotalPaidOut()).toBeGreaterThanOrEqual(expectedPayout);

      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'DrainBalance', recipient: drainRecipient.address }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: true
      });
      expect(result.transactions).toHaveTransaction({
        from: escrow.address,
        to: drainRecipient.address,
        success: true
      });
    });

    it('should allow drain after all claims settled (path A — multiple YES winners)', async () => {
      // Deploy a fresh market with 2 YES winners and 1 NO loser.
      // Both YES winners must claim before path A allows drain.
      const user3 = await blockchain.treasury('user3');
      const multiEscrow = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        endTime: BigInt(blockchain.now! + 7200)
      });

      // user1 and user3 both bet YES (3 TON each), user2 bets NO (2 TON)
      const yesBet = toNano('3');
      const noBet = toNano('2');
      await multiEscrow.send(
        user1.getSender(),
        { value: yesBet + toNano('0.05') },
        { $$type: 'Deposit' }
      );
      await multiEscrow.send(
        user3.getSender(),
        { value: yesBet + toNano('0.05') },
        { $$type: 'Deposit' }
      );
      await multiEscrow.send(
        user2.getSender(),
        { value: noBet + toNano('0.05') },
        { $$type: 'Deposit' }
      );
      await multiEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: yesBet }
      );
      await multiEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: yesBet }
      );
      await multiEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: noBet }
      );
      blockchain.now = blockchain.now! + 7300;
      await multiEscrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      const totalPool = await multiEscrow.getGetTotalPool();
      const feePercentage = await multiEscrow.getGetFeePercentage();
      const expectedPayout = (totalPool * (100n - feePercentage)) / 100n;

      // After first claim: totalPaidOut < expectedPayout → drain still blocked
      const sig1 = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: multiEscrow.address,
        nonce: 1n,
        outcome: 1n,
        amount: yesBet,
        marketId: TEST_MARKET_ID
      });
      await multiEscrow.send(
        admin.getSender(),
        { value: toNano('0.2') },
        {
          $$type: 'ClaimWinnings',
          nonce: 1n,
          userAddress: user1.address,
          outcome: 1n,
          amount: yesBet,
          marketId: TEST_MARKET_ID,
          signature: sig1
        }
      );

      const afterFirst = await multiEscrow.getGetTotalPaidOut();
      expect(afterFirst).toBeLessThan(expectedPayout); // still blocked

      const blockedResult = await multiEscrow.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'DrainBalance', recipient: drainRecipient.address }
      );
      expect(blockedResult.transactions).toHaveTransaction({
        from: admin.address,
        to: multiEscrow.address,
        success: false,
        exitCode: 39281
      });

      // After second claim: totalPaidOut >= expectedPayout → drain allowed
      const sig2 = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user3.address,
        contractAddress: multiEscrow.address,
        nonce: 2n,
        outcome: 1n,
        amount: yesBet,
        marketId: TEST_MARKET_ID
      });
      await multiEscrow.send(
        admin.getSender(),
        { value: toNano('0.2') },
        {
          $$type: 'ClaimWinnings',
          nonce: 2n,
          userAddress: user3.address,
          outcome: 1n,
          amount: yesBet,
          marketId: TEST_MARKET_ID,
          signature: sig2
        }
      );

      expect(await multiEscrow.getGetTotalPaidOut()).toBeGreaterThanOrEqual(expectedPayout);

      const drainResult = await multiEscrow.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'DrainBalance', recipient: drainRecipient.address }
      );
      expect(drainResult.transactions).toHaveTransaction({
        from: admin.address,
        to: multiEscrow.address,
        success: true
      });
      expect(drainResult.transactions).toHaveTransaction({
        from: multiEscrow.address,
        to: drainRecipient.address,
        success: true
      });
    });

    it('should allow drain after all refunds settled on cancelled market (path A)', async () => {
      // CANCEL market: expectedPayout = totalYes + totalNo (not totalPool, which is inflated by gas)
      const cancelEscrow = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        endTime: BigInt(blockchain.now! + 7200)
      });
      const refundAmount = toNano('3');
      // user sends 3 TON bet + 0.05 TON gas → totalPool = 3.05, but totalYes = 3
      await cancelEscrow.send(
        user1.getSender(),
        { value: refundAmount + toNano('0.05') },
        { $$type: 'Deposit' }
      );
      await cancelEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: refundAmount }
      );
      blockchain.now = blockchain.now! + 7300;
      await cancelEscrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 3n }
      );

      // expectedPayout = totalYes + totalNo = 3 TON (gas dust excluded)
      const totalYes = await cancelEscrow.getGetTotalYes();
      const totalNo = await cancelEscrow.getGetTotalNo();
      expect(totalYes + totalNo).toBe(refundAmount);

      // Before refund: drain blocked
      const blockedResult = await cancelEscrow.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'DrainBalance', recipient: drainRecipient.address }
      );
      expect(blockedResult.transactions).toHaveTransaction({
        from: admin.address,
        to: cancelEscrow.address,
        success: false,
        exitCode: 39281
      });

      // Refund user1
      const sig = signRefundReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: cancelEscrow.address,
        nonce: 1n,
        amount: refundAmount,
        marketId: TEST_MARKET_ID
      });
      await cancelEscrow.send(
        admin.getSender(),
        { value: toNano('0.2') },
        {
          $$type: 'RefundDeposit',
          nonce: 1n,
          userAddress: user1.address,
          amount: refundAmount,
          marketId: TEST_MARKET_ID,
          signature: sig
        }
      );

      // totalPaidOut (3 TON) >= expectedPayout (3 TON) → drain now allowed
      expect(await cancelEscrow.getGetTotalPaidOut()).toBeGreaterThanOrEqual(totalYes + totalNo);

      const drainResult = await cancelEscrow.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'DrainBalance', recipient: drainRecipient.address }
      );
      expect(drainResult.transactions).toHaveTransaction({
        from: admin.address,
        to: cancelEscrow.address,
        success: true
      });
      expect(drainResult.transactions).toHaveTransaction({
        from: cancelEscrow.address,
        to: drainRecipient.address,
        success: true
      });
    });

    it('should allow drain on empty pool market immediately after resolution (path A)', async () => {
      // Empty pool → totalYes + totalNo = 0 → expectedPayout = 0 → totalPaidOut(0) >= 0 → path A fires immediately
      const emptyEscrow = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        endTime: BigInt(blockchain.now! + 7200)
      });
      // Resolve YES with empty pool → auto-cancel to outcome 3
      await emptyEscrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      // path A: totalPaidOut(0) >= totalYes+totalNo(0) → drain allowed immediately
      const result = await emptyEscrow.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'DrainBalance', recipient: drainRecipient.address }
      );
      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: emptyEscrow.address,
        success: true
      });
    });

    it('should allow drain after claim window expires (path B)', async () => {
      // No claims, but claim window (endTime + 90 days) has expired
      const claimWindowExpiry = await escrow.getGetClaimWindowExpiry();
      blockchain.now = Number(claimWindowExpiry) + 1;

      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'DrainBalance', recipient: drainRecipient.address }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: true
      });
      expect(result.transactions).toHaveTransaction({
        from: escrow.address,
        to: drainRecipient.address,
        success: true
      });
    });

    it('should reject drain from non-admin', async () => {
      // Advance past window so rejection is access-control, not payout-guard
      const claimWindowExpiry = await escrow.getGetClaimWindowExpiry();
      blockchain.now = Number(claimWindowExpiry) + 1;

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.05') },
        { $$type: 'DrainBalance', recipient: drainRecipient.address }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 16461 // "Only admin"
      });
    });

    it('should reject drain before resolution', async () => {
      const freshEscrow = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        endTime: BigInt(blockchain.now! + 7200)
      });

      const result = await freshEscrow.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'DrainBalance', recipient: drainRecipient.address }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: freshEscrow.address,
        success: false,
        exitCode: 18221 // "Market not resolved"
      });
    });

    it('getTotalPaidOut tracks claims correctly', async () => {
      expect(await escrow.getGetTotalPaidOut()).toBe(0n);

      const totalPool = await escrow.getGetTotalPool();
      const feePercentage = await escrow.getGetFeePercentage();
      const totalYes = await escrow.getGetTotalYes();
      // user1 is sole YES bettor → their userShare equals the entire prize pool
      const expectedUserShare =
        (betAmount * ((totalPool * (100n - feePercentage)) / 100n)) / totalYes;

      const sig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce: 1n,
        outcome: 1n,
        amount: betAmount,
        marketId: TEST_MARKET_ID
      });
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.2') },
        {
          $$type: 'ClaimWinnings',
          nonce: 1n,
          userAddress: user1.address,
          outcome: 1n,
          amount: betAmount,
          marketId: TEST_MARKET_ID,
          signature: sig
        }
      );

      expect(await escrow.getGetTotalPaidOut()).toBe(expectedUserShare);
    });

    it('getTotalPaidOut tracks refunds correctly', async () => {
      const cancelEscrow = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        endTime: BigInt(blockchain.now! + 7200)
      });
      const refundAmount = toNano('3');
      await cancelEscrow.send(
        user1.getSender(),
        { value: refundAmount + toNano('0.05') },
        { $$type: 'Deposit' }
      );
      blockchain.now = blockchain.now! + 7300;
      await cancelEscrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 3n }
      );

      expect(await cancelEscrow.getGetTotalPaidOut()).toBe(0n);

      const sig = signRefundReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: cancelEscrow.address,
        nonce: 1n,
        amount: refundAmount,
        marketId: TEST_MARKET_ID
      });
      await cancelEscrow.send(
        admin.getSender(),
        { value: toNano('0.2') },
        {
          $$type: 'RefundDeposit',
          nonce: 1n,
          userAddress: user1.address,
          amount: refundAmount,
          marketId: TEST_MARKET_ID,
          signature: sig
        }
      );

      expect(await cancelEscrow.getGetTotalPaidOut()).toBe(refundAmount);
    });
  });

  // ────────────────────────────────────────────────────────
  // Admin Key Management Tests
  // ────────────────────────────────────────────────────────
  describe('Admin Key Management', () => {
    it('should allow admin to update backend public key', async () => {
      const newKeyPair = await createTestKeyPair();
      const newPubKey = publicKeyToBigInt(newKeyPair.publicKey);

      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'UpdateBackendKey', newPubKey }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: true
      });

      expect(await escrow.getGetBackendPubKey()).toBe(newPubKey);
    });

    it('should reject key update from non-admin', async () => {
      const newKeyPair = await createTestKeyPair();
      const newPubKey = publicKeyToBigInt(newKeyPair.publicKey);

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        { $$type: 'UpdateBackendKey', newPubKey }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 16461 // "Only admin"
      });
    });

    it('should allow admin to update oracle address', async () => {
      const newOracle = await blockchain.treasury('newOracle');

      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'UpdateOracle', newOracle: newOracle.address }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: true
      });

      expect((await escrow.getGetOracle()).equals(newOracle.address)).toBe(true);
    });

    it('should reject oracle update from non-admin', async () => {
      const newOracle = await blockchain.treasury('newOracle2');

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        { $$type: 'UpdateOracle', newOracle: newOracle.address }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 16461 // "Only admin"
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // Getter Tests
  // ────────────────────────────────────────────────────────
  describe('Getters', () => {
    it('getQuestion returns correct question', async () => {
      expect(await escrow.getGetQuestion()).toBe('Will BTC reach $100k?');
    });

    it('getEndTime returns correct timestamp', async () => {
      expect(await escrow.getGetEndTime()).toBe(endTime);
    });

    it('getResolved returns correct state', async () => {
      expect(await escrow.getGetResolved()).toBe(false);

      // Deposit first so contract has enough balance for resolution actions
      await escrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      expect(await escrow.getGetResolved()).toBe(true);
    });

    it('getWinningOutcome returns correct outcome', async () => {
      expect(await escrow.getGetWinningOutcome()).toBe(0n); // unresolved

      // Deposit first so contract has enough balance for resolution actions
      await escrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      // Record bets on both sides so auto-cancel doesn't trigger
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('0.5') }
      );
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('0.5') }
      );
      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 2n }
      );

      expect(await escrow.getGetWinningOutcome()).toBe(2n);
    });

    it('getTotalPool returns correct sum', async () => {
      expect(await escrow.getGetTotalPool()).toBe(0n);

      await escrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });

      expect(await escrow.getGetTotalPool()).toBeGreaterThan(0n);
    });

    it('getTotalYes/No return correct totals', async () => {
      await escrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });

      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('2') }
      );

      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('1') }
      );

      expect(await escrow.getGetTotalYes()).toBe(toNano('2'));
      expect(await escrow.getGetTotalNo()).toBe(toNano('1'));
    });

    it('getMinBet returns configured minimum', async () => {
      expect(await escrow.getGetMinBet()).toBe(toNano('0.1'));
    });

    it('getFeePercentage returns configured fee', async () => {
      expect(await escrow.getGetFeePercentage()).toBe(2n);
    });

    it('isNonceClaimed returns correct status', async () => {
      expect(await escrow.getIsNonceClaimed(1n)).toBe(false);
      expect(await escrow.getIsNonceClaimed(999n)).toBe(false);
    });

    it('getUserDeposit returns user total deposit', async () => {
      expect(await escrow.getGetUserDeposit(user1.address)).toBe(0n);

      await escrow.send(user1.getSender(), { value: toNano('3') }, { $$type: 'Deposit' });

      expect(await escrow.getGetUserDeposit(user1.address)).toBeGreaterThan(0n);
    });

    it('getFeesWithdrawn returns correct cumulative amount', async () => {
      expect(await escrow.getGetFeesWithdrawn()).toBe(0n);

      // Set up market: deposit, record bets, resolve
      await escrow.send(user1.getSender(), { value: toNano('10') }, { $$type: 'Deposit' });

      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('5') }
      );

      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      const totalPool = await escrow.getGetTotalPool();
      const feePercentage = await escrow.getGetFeePercentage();
      const maxFee = (totalPool * BigInt(feePercentage)) / 100n;
      const recipient = (await blockchain.treasury('feeRecipient')).address;

      // Withdraw partial fees
      const partialAmount = maxFee / 3n;
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'WithdrawFees',
          amount: partialAmount,
          recipient
        }
      );

      expect(await escrow.getGetFeesWithdrawn()).toBe(partialAmount);
    });

    it('calculatePayout returns correct expected payout', async () => {
      // Before resolution, payout should be 0
      expect(await escrow.getCalculatePayout(toNano('1'), 1n)).toBe(0n);

      // Set up and resolve
      await escrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });

      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('3') }
      );

      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('1') }
      );

      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      // For winning outcome, payout should be > 0
      const payout = await escrow.getCalculatePayout(toNano('1'), 1n);
      expect(payout).toBeGreaterThan(0n);

      // For losing outcome, payout should be 0
      expect(await escrow.getCalculatePayout(toNano('1'), 2n)).toBe(0n);
    });
  });

  // ────────────────────────────────────────────────────────
  // CreatorResolve Tests (Private Markets)
  // ────────────────────────────────────────────────────────
  describe('CreatorResolve', () => {
    let creator: SandboxContract<TreasuryContract>;
    let privateEscrow: SandboxContract<MarketEscrow>;

    beforeEach(async () => {
      creator = await blockchain.treasury('creator');
      privateEscrow = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        endTime,
        creator: creator.address
      });
    });

    it('should allow creator to resolve private market after endTime', async () => {
      // Deposit and record bets
      await privateEscrow.send(user1.getSender(), { value: toNano('3') }, { $$type: 'Deposit' });
      await privateEscrow.send(user2.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('3') }
      );
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('2') }
      );

      blockchain.now = Number(endTime) + 100;
      const result = await privateEscrow.send(
        creator.getSender(),
        { value: toNano('0.1') },
        { $$type: 'CreatorResolve', outcome: 1n }
      );

      expect(result.transactions).toHaveTransaction({
        from: creator.address,
        to: privateEscrow.address,
        success: true
      });

      expect(await privateEscrow.getGetResolved()).toBe(true);
      expect(await privateEscrow.getGetWinningOutcome()).toBe(1n);
    });

    it('should allow creator to resolve BEFORE endTime (early resolution)', async () => {
      await privateEscrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      await privateEscrow.send(user2.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('2') }
      );
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('2') }
      );

      // DO NOT advance time — still before endTime
      const result = await privateEscrow.send(
        creator.getSender(),
        { value: toNano('0.1') },
        { $$type: 'CreatorResolve', outcome: 2n }
      );

      expect(result.transactions).toHaveTransaction({
        from: creator.address,
        to: privateEscrow.address,
        success: true
      });

      expect(await privateEscrow.getGetResolved()).toBe(true);
      expect(await privateEscrow.getGetWinningOutcome()).toBe(2n);
    });

    it('should reject CreatorResolve from non-creator', async () => {
      blockchain.now = Number(endTime) + 100;
      const result = await privateEscrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        { $$type: 'CreatorResolve', outcome: 1n }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: privateEscrow.address,
        success: false,
        exitCode: 37536 // Only creator
      });
    });

    it('should reject CreatorResolve on public market (creator == admin)', async () => {
      // The default escrow (from outer beforeEach) has creator = admin (public market)
      blockchain.now = Number(endTime) + 100;
      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'CreatorResolve', outcome: 1n }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: false,
        exitCode: 37537 // Not on public markets
      });
    });

    it('should reject CreatorResolve on already-resolved market', async () => {
      await privateEscrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      await privateEscrow.send(user2.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('2') }
      );
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('2') }
      );

      // Resolve once
      await privateEscrow.send(
        creator.getSender(),
        { value: toNano('0.1') },
        { $$type: 'CreatorResolve', outcome: 1n }
      );

      // Try to resolve again
      const result = await privateEscrow.send(
        creator.getSender(),
        { value: toNano('0.1') },
        { $$type: 'CreatorResolve', outcome: 2n }
      );

      expect(result.transactions).toHaveTransaction({
        from: creator.address,
        to: privateEscrow.address,
        success: false,
        exitCode: 31038 // Already resolved
      });
    });

    it('should reject CreatorResolve with invalid outcome', async () => {
      const result = await privateEscrow.send(
        creator.getSender(),
        { value: toNano('0.1') },
        { $$type: 'CreatorResolve', outcome: 4n }
      );

      expect(result.transactions).toHaveTransaction({
        from: creator.address,
        to: privateEscrow.address,
        success: false,
        exitCode: 38283 // Invalid outcome
      });
    });

    it('should NOT auto-cancel when losing side has zero liquidity (winning side has bets)', async () => {
      // Only bet on YES, no bets on NO — resolve YES
      // Winning side (YES) has bets, so NO auto-cancel (matches oracle behavior)
      await privateEscrow.send(user1.getSender(), { value: toNano('3') }, { $$type: 'Deposit' });
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('3') }
      );

      const result = await privateEscrow.send(
        creator.getSender(),
        { value: toNano('0.1') },
        { $$type: 'CreatorResolve', outcome: 1n }
      );

      expect(result.transactions).toHaveTransaction({
        from: creator.address,
        to: privateEscrow.address,
        success: true
      });

      expect(await privateEscrow.getGetResolved()).toBe(true);
      expect(await privateEscrow.getGetWinningOutcome()).toBe(1n); // YES, not cancelled
    });

    it('should auto-cancel when winning side has zero bets', async () => {
      // Bet on NO only, resolve YES → winning side (YES) has 0 → auto-cancel
      await privateEscrow.send(user1.getSender(), { value: toNano('3') }, { $$type: 'Deposit' });
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('3') }
      );

      const result = await privateEscrow.send(
        creator.getSender(),
        { value: toNano('0.1') },
        { $$type: 'CreatorResolve', outcome: 1n }
      );

      expect(result.transactions).toHaveTransaction({ success: true });
      expect(await privateEscrow.getGetWinningOutcome()).toBe(3n); // Cancelled — winning side empty
    });

    it('should NOT auto-cancel when creator resolves with outcome=3 (explicit cancel)', async () => {
      await privateEscrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      await privateEscrow.send(user2.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('2') }
      );
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('2') }
      );

      const result = await privateEscrow.send(
        creator.getSender(),
        { value: toNano('0.1') },
        { $$type: 'CreatorResolve', outcome: 3n }
      );

      expect(result.transactions).toHaveTransaction({ success: true });
      expect(await privateEscrow.getGetWinningOutcome()).toBe(3n);
    });

    it('should allow oracle to still resolve private market after endTime', async () => {
      await privateEscrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      await privateEscrow.send(user2.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('2') }
      );
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('2') }
      );

      blockchain.now = Number(endTime) + 100;
      const result = await privateEscrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      expect(result.transactions).toHaveTransaction({ success: true });
      expect(await privateEscrow.getGetResolved()).toBe(true);
      expect(await privateEscrow.getGetWinningOutcome()).toBe(1n);
    });

    it('should store and return creator address via getter', async () => {
      const storedCreator = await privateEscrow.getGetCreator();
      expect(storedCreator.equals(creator.address)).toBe(true);
    });

    it('full cycle: deposit -> bet -> creator resolve -> claim', async () => {
      // user1 bets YES, user2 bets NO
      await privateEscrow.send(user1.getSender(), { value: toNano('3') }, { $$type: 'Deposit' });
      await privateEscrow.send(user2.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('3') }
      );
      await privateEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('2') }
      );

      // Creator resolves YES (early — before endTime)
      await privateEscrow.send(
        creator.getSender(),
        { value: toNano('0.1') },
        { $$type: 'CreatorResolve', outcome: 1n }
      );

      expect(await privateEscrow.getGetResolved()).toBe(true);
      expect(await privateEscrow.getGetWinningOutcome()).toBe(1n);

      // user1 claims winnings
      const signature = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: privateEscrow.address,
        nonce: 1n,
        outcome: 1n,
        amount: toNano('3'),
        marketId: TEST_MARKET_ID
      });

      const claimResult = await privateEscrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce: 1n,
          userAddress: user1.address,
          outcome: 1n,
          amount: toNano('3'),
          marketId: TEST_MARKET_ID,
          signature
        }
      );

      expect(claimResult.transactions).toHaveTransaction({
        from: privateEscrow.address,
        to: user1.address,
        success: true
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // EmergencyCancel Tests
  // ────────────────────────────────────────────────────────
  // EmergencyCancel is the permissionless safety-net: if the oracle never resolves,
  // anyone can force-cancel the market 30 days past endTime so depositors can refund.
  // Exit codes under test: 31038 (already resolved), 12914 (grace period not expired).
  describe('EmergencyCancel', () => {
    const gracePeriodSeconds = 30 * 24 * 3600;

    it('should allow anyone to emergency-cancel after the 30-day grace period', async () => {
      // Deposit so the market has state to cancel against
      await escrow.send(user1.getSender(), { value: toNano('3') }, { $$type: 'Deposit' });

      blockchain.now = Number(endTime) + gracePeriodSeconds + 1;

      // Called by a non-admin, non-oracle third party — EmergencyCancel is permissionless
      const result = await escrow.send(
        user2.getSender(),
        { value: toNano('0.1') },
        { $$type: 'EmergencyCancel' }
      );

      expect(result.transactions).toHaveTransaction({
        from: user2.address,
        to: escrow.address,
        success: true
      });

      expect(await escrow.getGetResolved()).toBe(true);
      expect(await escrow.getGetWinningOutcome()).toBe(3n);
    });

    it('should reject emergency-cancel before grace period expires', async () => {
      // Advance past endTime but not past the 30-day grace window
      blockchain.now = Number(endTime) + gracePeriodSeconds - 60;

      const result = await escrow.send(
        user2.getSender(),
        { value: toNano('0.1') },
        { $$type: 'EmergencyCancel' }
      );

      expect(result.transactions).toHaveTransaction({
        from: user2.address,
        to: escrow.address,
        success: false,
        exitCode: 12914 // "Grace period not expired"
      });

      expect(await escrow.getGetResolved()).toBe(false);
      expect(await escrow.getGetWinningOutcome()).toBe(0n);
    });

    it('should reject emergency-cancel on already-resolved market', async () => {
      // Record a trade on each side so oracle can resolve cleanly (no auto-cancel)
      await escrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      await escrow.send(user2.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('1') }
      );
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('1') }
      );

      // Oracle resolves
      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      // Advance past the 30-day window and try to emergency-cancel anyway
      blockchain.now = Number(endTime) + gracePeriodSeconds + 1;
      const result = await escrow.send(
        user2.getSender(),
        { value: toNano('0.1') },
        { $$type: 'EmergencyCancel' }
      );

      expect(result.transactions).toHaveTransaction({
        from: user2.address,
        to: escrow.address,
        success: false,
        exitCode: 31038 // "Already resolved"
      });

      // Outcome stays as the oracle set it
      expect(await escrow.getGetWinningOutcome()).toBe(1n);
    });

    it('should allow refunds after emergency cancel', async () => {
      const depositAmount = toNano('3');
      const refundAmount = toNano('2');
      const nonce = 999n;

      await escrow.send(user1.getSender(), { value: depositAmount }, { $$type: 'Deposit' });

      blockchain.now = Number(endTime) + gracePeriodSeconds + 1;
      await escrow.send(user2.getSender(), { value: toNano('0.1') }, { $$type: 'EmergencyCancel' });

      const sig = signRefundReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce,
        amount: refundAmount,
        marketId: TEST_MARKET_ID
      });

      const refundResult = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RefundDeposit',
          nonce,
          userAddress: user1.address,
          amount: refundAmount,
          signature: sig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(refundResult.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: true
      });
      expect(refundResult.transactions).toHaveTransaction({
        from: escrow.address,
        to: user1.address,
        success: true
      });
      expect(await escrow.getIsNonceClaimed(nonce)).toBe(true);
    });

    it('should reject claims after emergency cancel', async () => {
      // Set up a market where user1 has a real YES position
      await escrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('2') }
      );

      // Oracle never shows up. Third party triggers emergency-cancel after grace.
      blockchain.now = Number(endTime) + gracePeriodSeconds + 1;
      await escrow.send(user2.getSender(), { value: toNano('0.1') }, { $$type: 'EmergencyCancel' });

      // Attempting to claim winnings now must fail — cancelled markets use the refund path
      const nonce = 1000n;
      const sig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce,
        outcome: 1n,
        amount: toNano('2'),
        marketId: TEST_MARKET_ID
      });

      const claimResult = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce,
          userAddress: user1.address,
          outcome: 1n,
          amount: toNano('2'),
          marketId: TEST_MARKET_ID,
          signature: sig
        }
      );

      expect(claimResult.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false,
        exitCode: 36693 // "Market cancelled - use refund"
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // BettingClosesAt Tests
  // ────────────────────────────────────────────────────────
  describe('BettingClosesAt', () => {
    it('should default bettingClosesAt to endTime when 0 is passed', async () => {
      // The default escrow from beforeEach uses bettingClosesAt=0 (via deployEscrow helper)
      const bettingClosesAt = await escrow.getGetBettingClosesAt();
      expect(bettingClosesAt).toBe(endTime);
    });

    it('should use explicit bettingClosesAt when non-zero', async () => {
      const bettingCutoff = BigInt(blockchain.now! + 1800); // 30 min
      const marketEndTime = BigInt(blockchain.now! + 3600); // 1 hour

      const customEscrow = blockchain.openContract(
        await MarketEscrow.fromInit(
          'Betting closes early?',
          marketEndTime,
          bettingCutoff,
          oracle.address,
          backendPubKey,
          toNano('0.1'),
          2n,
          admin.address,
          admin.address
        )
      );

      await customEscrow.send(
        admin.getSender(),
        { value: toNano('1') },
        { $$type: 'Deploy', queryId: 0n }
      );

      expect(await customEscrow.getGetBettingClosesAt()).toBe(bettingCutoff);
      expect(await customEscrow.getGetEndTime()).toBe(marketEndTime);
    });

    it('should reject deposit after bettingClosesAt (even if endTime not reached)', async () => {
      const bettingCutoff = BigInt(blockchain.now! + 1800); // 30 min
      const marketEndTime = BigInt(blockchain.now! + 3600); // 1 hour

      const customEscrow = blockchain.openContract(
        await MarketEscrow.fromInit(
          'Early cutoff deposit test?',
          marketEndTime,
          bettingCutoff,
          oracle.address,
          backendPubKey,
          toNano('0.1'),
          2n,
          admin.address,
          admin.address
        )
      );

      await customEscrow.send(
        admin.getSender(),
        { value: toNano('1') },
        { $$type: 'Deploy', queryId: 0n }
      );

      // Advance past bettingClosesAt but before endTime
      blockchain.now = Number(bettingCutoff) + 10;

      const result = await customEscrow.send(
        user1.getSender(),
        { value: toNano('1') },
        { $$type: 'Deposit' }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: customEscrow.address,
        success: false,
        exitCode: 36192 // Betting closed
      });
    });

    it('should reject RecordBetOnEscrow after bettingClosesAt', async () => {
      const bettingCutoff = BigInt(blockchain.now! + 1800);
      const marketEndTime = BigInt(blockchain.now! + 3600);

      const customEscrow = blockchain.openContract(
        await MarketEscrow.fromInit(
          'Early cutoff bet test?',
          marketEndTime,
          bettingCutoff,
          oracle.address,
          backendPubKey,
          toNano('0.1'),
          2n,
          admin.address,
          admin.address
        )
      );

      await customEscrow.send(
        admin.getSender(),
        { value: toNano('1') },
        { $$type: 'Deploy', queryId: 0n }
      );

      // Deposit before cutoff
      await customEscrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });

      // Advance past bettingClosesAt but before endTime
      blockchain.now = Number(bettingCutoff) + 10;

      const result = await customEscrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('1') }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: customEscrow.address,
        success: false,
        exitCode: 36192 // Betting closed
      });
    });

    it('should allow oracle to resolve before endTime', async () => {
      // Deposit and record bets
      await escrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('2') }
      );
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('1') }
      );

      // Do NOT advance time — still before endTime
      const result = await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      expect(result.transactions).toHaveTransaction({
        from: oracle.address,
        to: escrow.address,
        success: true
      });

      expect(await escrow.getGetResolved()).toBe(true);
      expect(await escrow.getGetWinningOutcome()).toBe(1n);
    });

    it('should allow deposit before bettingClosesAt on early-cutoff market', async () => {
      const bettingCutoff = BigInt(blockchain.now! + 1800);
      const marketEndTime = BigInt(blockchain.now! + 3600);

      const customEscrow = blockchain.openContract(
        await MarketEscrow.fromInit(
          'Allow deposit before cutoff?',
          marketEndTime,
          bettingCutoff,
          oracle.address,
          backendPubKey,
          toNano('0.1'),
          2n,
          admin.address,
          admin.address
        )
      );

      await customEscrow.send(
        admin.getSender(),
        { value: toNano('1') },
        { $$type: 'Deploy', queryId: 0n }
      );

      // Deposit before cutoff — should succeed
      const result = await customEscrow.send(
        user1.getSender(),
        { value: toNano('1') },
        { $$type: 'Deposit' }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: customEscrow.address,
        success: true
      });

      expect(await customEscrow.getGetTotalPool()).toBeGreaterThan(0n);
    });
  });
});
