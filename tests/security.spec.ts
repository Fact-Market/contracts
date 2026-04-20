import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { KeyPair } from '@ton/crypto';
import '@ton/test-utils';
import { MarketEscrow } from '../build/MarketEscrow_MarketEscrow';
import { MarketFactory } from '../build/MarketFactory_MarketFactory';
import {
  createTestKeyPair,
  publicKeyToBigInt,
  signBetReceipt,
  signRefundReceipt,
  deployEscrow
} from './utils/test-helpers';

const TEST_MARKET_ID = 'test-market-id-security';

// Adversarial security tests for Fact Market contracts.
// These complement the functional tests in MarketEscrow.spec.ts and MarketFactory.spec.ts
// by targeting cross-contract replay, key rotation, fund lock edges, and factory-level risks.

describe('MarketEscrow Security', () => {
  let blockchain: Blockchain;
  let admin: SandboxContract<TreasuryContract>;
  let oracle: SandboxContract<TreasuryContract>;
  let user1: SandboxContract<TreasuryContract>;
  let _user2: SandboxContract<TreasuryContract>;
  let backendKeyPair: KeyPair;
  let backendPubKey: bigint;
  let escrow: SandboxContract<MarketEscrow>;
  let endTime: bigint;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    admin = await blockchain.treasury('admin');
    oracle = await blockchain.treasury('oracle');
    user1 = await blockchain.treasury('user1');
    _user2 = await blockchain.treasury('user2');
    backendKeyPair = await createTestKeyPair();
    backendPubKey = publicKeyToBigInt(backendKeyPair.publicKey);

    blockchain.now = Math.floor(Date.now() / 1000);
    endTime = BigInt(blockchain.now! + 3600);

    escrow = await deployEscrow({
      blockchain,
      admin,
      oracle,
      backendPubKey,
      endTime
    });
  });

  describe('Cross-contract signature replay', () => {
    it('should reject a signature created for a different escrow contract', async () => {
      const escrowB = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        question: 'Will ETH flip BTC?',
        endTime
      });

      // Deposit and record bets on both escrows
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

      await escrowB.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });
      await escrowB.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('3') }
      );
      await escrowB.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('1') }
      );

      // Resolve both
      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );
      await escrowB.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      // Sign receipt scoped to escrow A
      const sigForA = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce: 1n,
        outcome: 1n,
        amount: toNano('1'),
        marketId: TEST_MARKET_ID
      });

      // Attempt to use escrow A's signature on escrow B — must fail
      const result = await escrowB.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce: 1n,
          userAddress: user1.address,
          outcome: 1n,
          amount: toNano('1'),
          signature: sigForA,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrowB.address,
        success: false,
        exitCode: 48401 // "Invalid signature"
      });
    });
  });

  describe('Key rotation mid-market', () => {
    it('should reject old-key signatures after backend key rotation', async () => {
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

      // Sign receipt with the ORIGINAL key before rotation
      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      const sigOldKey = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce: 1n,
        outcome: 1n,
        amount: toNano('1'),
        marketId: TEST_MARKET_ID
      });

      // Rotate key
      const newKeyPair = await createTestKeyPair();
      const newPubKey = publicKeyToBigInt(newKeyPair.publicKey);
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'UpdateBackendKey', newPubKey }
      );

      // Old-key signature must be rejected
      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce: 1n,
          userAddress: user1.address,
          outcome: 1n,
          amount: toNano('1'),
          signature: sigOldKey,
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

    it('should accept new-key signatures after backend key rotation', async () => {
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

      // Rotate key BEFORE resolution
      const newKeyPair = await createTestKeyPair();
      const newPubKey = publicKeyToBigInt(newKeyPair.publicKey);
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'UpdateBackendKey', newPubKey }
      );

      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      // Sign with new key — must succeed
      const sigNewKey = signBetReceipt({
        keyPair: newKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce: 1n,
        outcome: 1n,
        amount: toNano('1'),
        marketId: TEST_MARKET_ID
      });

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce: 1n,
          userAddress: user1.address,
          outcome: 1n,
          amount: toNano('1'),
          signature: sigNewKey,
          marketId: TEST_MARKET_ID
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: true
      });
    });
  });

  describe('Zero winning-side auto-cancel', () => {
    it('should auto-cancel market and allow refunds when winning side has zero bets', async () => {
      // Deposit funds
      await escrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });

      // Record bets ONLY on NO side
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('3') }
      );

      // Resolve with YES wins — but totalYes == 0, triggers auto-cancel
      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      expect(await escrow.getGetTotalYes()).toBe(0n);
      expect(await escrow.getGetTotalPool()).toBeGreaterThan(0n);

      // Market should be auto-cancelled (outcome=3) instead of locked
      expect(await escrow.getGetWinningOutcome()).toBe(3n);
      expect(await escrow.getGetResolved()).toBe(true);

      // Claims fail because market is cancelled
      const sig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce: 1n,
        outcome: 1n,
        amount: toNano('1'),
        marketId: TEST_MARKET_ID
      });

      const claimResult = await escrow.send(
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

      expect(claimResult.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: false
      });

      // Refunds NOW work because the market is auto-cancelled
      const refundSig = signRefundReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce: 2n,
        amount: toNano('1'),
        marketId: TEST_MARKET_ID
      });

      const refundResult = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RefundDeposit',
          nonce: 2n,
          userAddress: user1.address,
          amount: toNano('1'),
          signature: refundSig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(refundResult.transactions).toHaveTransaction({
        from: user1.address,
        to: escrow.address,
        success: true
      });
    });

    it('should auto-cancel when totalNo is zero and outcome=2', async () => {
      await escrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });

      // Record bets ONLY on YES side
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: toNano('3') }
      );

      // Resolve with NO wins — but totalNo == 0
      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 2n }
      );

      expect(await escrow.getGetTotalNo()).toBe(0n);
      expect(await escrow.getGetWinningOutcome()).toBe(3n);
    });

    it('should NOT auto-cancel when winning side has bets', async () => {
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

      // Should remain outcome=1, NOT auto-cancelled
      expect(await escrow.getGetWinningOutcome()).toBe(1n);
    });
  });

  describe('Nonce collision between claims and refunds', () => {
    it('should prevent claiming with a nonce that was already used for refund', async () => {
      // Set up market, deposit, resolve as cancelled, refund with nonce=1
      const cancelEndTime = BigInt(blockchain.now! + 600);
      const cancelEscrow = await deployEscrow({
        blockchain,
        admin,
        oracle,
        backendPubKey,
        endTime: cancelEndTime
      });

      await cancelEscrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });

      blockchain.now = Number(cancelEndTime) + 100;
      await cancelEscrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 3n }
      );

      // Refund with nonce=1
      const refundSig = signRefundReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: cancelEscrow.address,
        nonce: 1n,
        amount: toNano('1'),
        marketId: TEST_MARKET_ID
      });

      await cancelEscrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RefundDeposit',
          nonce: 1n,
          userAddress: user1.address,
          amount: toNano('1'),
          signature: refundSig,
          marketId: TEST_MARKET_ID
        }
      );

      expect(await cancelEscrow.getIsNonceClaimed(1n)).toBe(true);

      // ClaimWinnings with the same nonce=1 must fail (market is cancelled anyway,
      // but the nonce is also burned)
      const claimSig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: cancelEscrow.address,
        nonce: 1n,
        outcome: 1n,
        amount: toNano('1'),
        marketId: TEST_MARKET_ID
      });

      const result = await cancelEscrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce: 1n,
          userAddress: user1.address,
          outcome: 1n,
          amount: toNano('1'),
          signature: claimSig,
          marketId: TEST_MARKET_ID
        }
      );

      // Rejected — either "Market cancelled - use refund" or "Already claimed"
      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: cancelEscrow.address,
        success: false
      });
    });
  });

  describe('Claim amount exceeds deposit', () => {
    it('should revert when claim amount exceeds user deposit', async () => {
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

      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 1n }
      );

      const userDeposit = await escrow.getGetUserDeposit(user1.address);

      const sig = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce: 1n,
        outcome: 1n,
        amount: userDeposit + toNano('1'),
        marketId: TEST_MARKET_ID
      });

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'ClaimWinnings',
          nonce: 1n,
          userAddress: user1.address,
          outcome: 1n,
          amount: userDeposit + toNano('1'),
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
  });

  describe('Refund amount exceeds deposit', () => {
    it('should revert when refund amount exceeds user deposit', async () => {
      await escrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });

      blockchain.now = Number(endTime) + 100;
      await escrow.send(
        oracle.getSender(),
        { value: toNano('0.1') },
        { $$type: 'ResolveMarket', outcome: 3n }
      );

      const userDeposit = await escrow.getGetUserDeposit(user1.address);

      const sig = signRefundReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrow.address,
        nonce: 1n,
        amount: userDeposit + toNano('1'),
        marketId: TEST_MARKET_ID
      });

      const result = await escrow.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RefundDeposit',
          nonce: 1n,
          userAddress: user1.address,
          amount: userDeposit + toNano('1'),
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
  });

  describe('RecordBetOnEscrow invariant enforcement', () => {
    it('should hard-revert bet recording that would violate totalYes + totalNo <= totalPool', async () => {
      await escrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });
      const totalPool = await escrow.getGetTotalPool();

      // Record yes bets close to pool total
      await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 1n, amount: totalPool - toNano('1') }
      );

      // This would push totalYes + totalNo above totalPool
      const result = await escrow.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBetOnEscrow', outcome: 2n, amount: toNano('2') }
      );

      // Transaction fails with require() revert (no silent failure)
      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: escrow.address,
        success: false
      });

      // totalNo should remain 0
      expect(await escrow.getGetTotalNo()).toBe(0n);
    });
  });
});

describe('MarketFactory Security', () => {
  let blockchain: Blockchain;
  let admin: SandboxContract<TreasuryContract>;
  let oracle: SandboxContract<TreasuryContract>;
  let user1: SandboxContract<TreasuryContract>;
  let backendKeyPair: KeyPair;
  let backendPubKey: bigint;
  let factory: SandboxContract<MarketFactory>;

  const defaultMinBet = toNano('0.1');
  const defaultFeePercentage = 2n;

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    admin = await blockchain.treasury('admin');
    oracle = await blockchain.treasury('oracle');
    user1 = await blockchain.treasury('user1');
    backendKeyPair = await createTestKeyPair();
    backendPubKey = publicKeyToBigInt(backendKeyPair.publicKey);

    blockchain.now = Math.floor(Date.now() / 1000);

    factory = blockchain.openContract(
      await MarketFactory.fromInit(
        oracle.address,
        backendPubKey,
        defaultMinBet,
        defaultFeePercentage
      )
    );

    await factory.send(
      admin.getSender(),
      { value: toNano('0.5') },
      { $$type: 'Deploy', queryId: 0n }
    );

    // Fund the factory so it has enough balance for deploy actions
    await factory.send(admin.getSender(), { value: toNano('5') }, { $$type: 'FundFactory' });
  });

  describe('Market deployment registration', () => {
    // The 002-HIGH finding (phantom markets via SendIgnoreErrors) was fixed by removing
    // SendIgnoreErrors from the deploy send, so the whole transaction reverts if the
    // escrow cannot be deployed. Directly forcing the inner deploy send to fail from a
    // sandbox test is not practical; this test instead verifies the positive invariant
    // that successful deployment atomically registers the market in both `markets` and
    // `escrowAddresses`. Pre-deploy validation failures (non-admin, past endTime, fee
    // cap) are covered in MarketFactory.spec.ts with explicit exit-code assertions and
    // implicitly verify that rejection leaves the factory maps untouched.
    it('should deploy market and register it when given sufficient gas', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Test market deploy',
          endTime,
          bettingClosesAt: 0n,
          minBet: toNano('0.1'),
          feePercentage: 2n
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: true
      });

      expect(await factory.getGetMarketCount()).toBe(1n);

      const computedAddr = await factory.getComputeEscrowAddress(
        'Test market deploy',
        endTime,
        0n,
        toNano('0.1'),
        2n
      );
      const storedAddr = await factory.getGetMarket(0n);
      expect(storedAddr!.equals(computedAddr)).toBe(true);
    });
  });

  describe('UpdateMinBet typed message', () => {
    it('should set defaultMinBet to the explicit message field value', async () => {
      const newMinBet = toNano('0.5');

      await factory.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'UpdateMinBet', newMinBet }
      );

      const updatedMinBet = await factory.getGetDefaultMinBet();
      expect(updatedMinBet).toBe(newMinBet);
    });

    it('should reject UpdateMinBet from non-admin', async () => {
      const result = await factory.send(
        user1.getSender(),
        { value: toNano('0.05') },
        { $$type: 'UpdateMinBet', newMinBet: toNano('0.5') }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: factory.address,
        success: false
      });
    });

    it('should reject UpdateMinBet with zero value', async () => {
      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'UpdateMinBet', newMinBet: 0n }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: false
      });
    });
  });

  describe('Admin transfer access control', () => {
    it('should revoke old admin access and grant new admin access after two-step transfer', async () => {
      const newAdmin = await blockchain.treasury('newAdmin');

      // Step 1: propose new admin
      await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'TransferAdmin', newAdmin: newAdmin.address }
      );

      // Admin unchanged until accepted
      expect((await factory.getGetAdmin()).equals(admin.address)).toBe(true);

      // Step 2: new admin accepts
      await factory.send(newAdmin.getSender(), { value: toNano('0.1') }, { $$type: 'AcceptAdmin' });

      expect((await factory.getGetAdmin()).equals(newAdmin.address)).toBe(true);

      // Old admin can no longer deploy markets
      const endTime = BigInt(blockchain.now! + 3600);
      const oldAdminResult = await factory.send(
        admin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Should fail',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      expect(oldAdminResult.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: false
      });

      // New admin CAN deploy markets
      const newAdminResult = await factory.send(
        newAdmin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Should succeed',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      expect(newAdminResult.transactions).toHaveTransaction({
        from: newAdmin.address,
        to: factory.address,
        success: true
      });

      expect(await factory.getGetMarketCount()).toBe(1n);
    });

    it('should reject admin transfer proposal from non-admin', async () => {
      const attacker = await blockchain.treasury('attacker');

      const result = await factory.send(
        attacker.getSender(),
        { value: toNano('0.1') },
        { $$type: 'TransferAdmin', newAdmin: attacker.address }
      );

      expect(result.transactions).toHaveTransaction({
        from: attacker.address,
        to: factory.address,
        success: false
      });

      // Admin unchanged
      expect((await factory.getGetAdmin()).equals(admin.address)).toBe(true);
    });

    it('should reject AcceptAdmin from wrong address', async () => {
      const newAdmin = await blockchain.treasury('newAdmin');
      const attacker = await blockchain.treasury('attacker');

      // Propose new admin
      await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'TransferAdmin', newAdmin: newAdmin.address }
      );

      // Attacker tries to accept
      const result = await factory.send(
        attacker.getSender(),
        { value: toNano('0.1') },
        { $$type: 'AcceptAdmin' }
      );

      expect(result.transactions).toHaveTransaction({
        from: attacker.address,
        to: factory.address,
        success: false
      });

      // Admin unchanged
      expect((await factory.getGetAdmin()).equals(admin.address)).toBe(true);
    });

    it('should reject AcceptAdmin when no transfer is pending', async () => {
      const attacker = await blockchain.treasury('attacker');

      const result = await factory.send(
        attacker.getSender(),
        { value: toNano('0.1') },
        { $$type: 'AcceptAdmin' }
      );

      expect(result.transactions).toHaveTransaction({
        from: attacker.address,
        to: factory.address,
        success: false
      });
    });
  });

  describe('Factory WithdrawFees reverts on failure', () => {
    it('should allow admin to withdraw factory balance above minimum', async () => {
      // Fund the factory
      await factory.send(admin.getSender(), { value: toNano('5') }, { $$type: 'FundFactory' });

      const recipient = (await blockchain.treasury('feeRecipient')).address;

      // Withdraw should succeed
      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'WithdrawFees', amount: toNano('1'), recipient }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: true
      });
    });

    it('should reject withdrawal that would leave balance below minimum', async () => {
      // Fund minimally
      await factory.send(admin.getSender(), { value: toNano('0.1') }, { $$type: 'FundFactory' });

      const recipient = (await blockchain.treasury('feeRecipient')).address;

      // Try to withdraw more than available above minimum
      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'WithdrawFees', amount: toNano('10'), recipient }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: false
      });
    });
  });
});
