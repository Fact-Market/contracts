import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, toNano } from '@ton/core';
import { KeyPair } from '@ton/crypto';
import '@ton/test-utils';
import { MarketFactory } from '../build/MarketFactory_MarketFactory';
import { MarketEscrow } from '../build/MarketFactory_MarketEscrow';
import { createTestKeyPair, publicKeyToBigInt } from './utils/test-helpers';

describe('MarketFactory', () => {
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

    // Deploy the factory (admin is the deployer/sender, so admin = sender())
    await factory.send(
      admin.getSender(),
      { value: toNano('0.5') },
      { $$type: 'Deploy', queryId: 0n }
    );

    // Fund the factory so it has enough balance for deploy actions
    await factory.send(admin.getSender(), { value: toNano('5') }, { $$type: 'FundFactory' });
  });

  // ────────────────────────────────────────────────────────
  // Market Deployment Tests
  // ────────────────────────────────────────────────────────
  describe('Market Deployment', () => {
    it('should deploy new market escrow from admin', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Will ETH flip BTC?',
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
    });

    it('should reject deployment from non-admin', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      const result = await factory.send(
        user1.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Test?',
          endTime,
          bettingClosesAt: 0n,
          minBet: toNano('0.1'),
          feePercentage: 2n
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: factory.address,
        success: false,
        exitCode: 63259 // "Only admin can deploy markets"
      });
    });

    it('should reject deployment with end time in past', async () => {
      const pastEndTime = BigInt(blockchain.now! - 100);

      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Test?',
          endTime: pastEndTime,
          bettingClosesAt: 0n,
          minBet: toNano('0.1'),
          feePercentage: 2n
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: false,
        exitCode: 26966 // "End time must be in future"
      });
    });

    it('should track deployed markets correctly', async () => {
      const endTime1 = BigInt(blockchain.now! + 3600);
      const endTime2 = BigInt(blockchain.now! + 7200);

      // Deploy first market
      await factory.send(
        admin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Market 1?',
          endTime: endTime1,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      expect(await factory.getGetMarketCount()).toBe(1n);
      const market0 = await factory.getGetMarket(0n);
      expect(market0).not.toBeNull();

      // Deploy second market
      await factory.send(
        admin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Market 2?',
          endTime: endTime2,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      expect(await factory.getGetMarketCount()).toBe(2n);
      const market1 = await factory.getGetMarket(1n);
      expect(market1).not.toBeNull();

      // Verify different addresses
      expect(market0!.equals(market1!)).toBe(false);
    });

    it('should use default values when not specified', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      // Deploy with 0 minBet and 0 feePercentage (should use defaults)
      await factory.send(
        admin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Defaults test?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      const escrowAddress = await factory.getGetMarket(0n);
      expect(escrowAddress).not.toBeNull();

      // Open the deployed escrow and check its config
      const escrow = blockchain.openContract(MarketEscrow.fromAddress(escrowAddress!));
      expect(await escrow.getGetMinBet()).toBe(defaultMinBet);
      expect(await escrow.getGetFeePercentage()).toBe(defaultFeePercentage);
    });

    it('should emit events on deployment', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Event test?',
          endTime,
          bettingClosesAt: 0n,
          minBet: toNano('0.2'),
          feePercentage: 3n
        }
      );

      // Verify the factory transaction was successful (escrow deploy is sent)
      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: true
      });

      // The factory deploys the escrow, so there should be a message from factory to escrow
      expect(result.transactions.length).toBeGreaterThan(2);
    });
  });

  // ────────────────────────────────────────────────────────
  // Bet Recording Tests
  // ────────────────────────────────────────────────────────
  describe('Bet Recording', () => {
    let escrowAddress: Address;

    beforeEach(async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      await factory.send(
        admin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Bet recording test?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      escrowAddress = (await factory.getGetMarket(0n))!;

      // Fund escrow with deposit so bets can be recorded
      const escrow = blockchain.openContract(MarketEscrow.fromAddress(escrowAddress));
      await escrow.send(user1.getSender(), { value: toNano('5') }, { $$type: 'Deposit' });
    });

    it('should forward RecordBet to escrow contract', async () => {
      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RecordBet',
          escrowAddress,
          outcome: 1n,
          amount: toNano('1')
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: true
      });

      // Factory should have forwarded RecordBetOnEscrow to the escrow
      expect(result.transactions).toHaveTransaction({
        from: factory.address,
        to: escrowAddress,
        success: true
      });

      // Verify escrow state updated
      const escrow = blockchain.openContract(MarketEscrow.fromAddress(escrowAddress));
      expect(await escrow.getGetTotalYes()).toBe(toNano('1'));
    });

    it('should reject recording from non-admin', async () => {
      const result = await factory.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RecordBet',
          escrowAddress,
          outcome: 1n,
          amount: toNano('1')
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: user1.address,
        to: factory.address,
        success: false,
        exitCode: 16461 // "Only admin"
      });
    });

    it('should reject invalid outcome', async () => {
      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RecordBet',
          escrowAddress,
          outcome: 3n, // Only 1 or 2 allowed
          amount: toNano('1')
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: false,
        exitCode: 38283 // "Invalid outcome"
      });
    });

    it('should reject recording with zero amount', async () => {
      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RecordBet',
          escrowAddress,
          outcome: 1n,
          amount: 0n
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: false
      });
    });

    it('should validate escrow belongs to factory', async () => {
      const fakeAddress = (await blockchain.treasury('fake')).address;

      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RecordBet',
          escrowAddress: fakeAddress,
          outcome: 1n,
          amount: toNano('1')
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: false,
        exitCode: 43323 // "Unknown escrow"
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // Admin Functions Tests
  // ────────────────────────────────────────────────────────
  describe('Admin Functions', () => {
    it('should allow admin to update default oracle', async () => {
      const newOracle = await blockchain.treasury('newOracle');

      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'UpdateOracle', newOracle: newOracle.address }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: true
      });

      expect((await factory.getGetDefaultOracle()).equals(newOracle.address)).toBe(true);
    });

    it('should allow admin to update default backend key', async () => {
      const newKeyPair = await createTestKeyPair();
      const newPubKey = publicKeyToBigInt(newKeyPair.publicKey);

      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'UpdateBackendKey', newPubKey }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: true
      });

      expect(await factory.getGetDefaultBackendPubKey()).toBe(newPubKey);
    });

    it('should allow admin to update min bet', async () => {
      const newMinBet = toNano('0.5');

      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'UpdateMinBet', newMinBet }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: true
      });

      expect(await factory.getGetDefaultMinBet()).toBe(newMinBet);
    });

    it('should allow admin to update fee percentage (max 10%)', async () => {
      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'UpdateFeePercentage', newFeePercentage: 5n }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: true
      });

      expect(await factory.getGetDefaultFeePercentage()).toBe(5n);
    });

    it('should reject fee percentage above 10%', async () => {
      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'UpdateFeePercentage', newFeePercentage: 11n }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: false,
        exitCode: 46136 // "Fee too high"
      });
    });

    it('should allow admin to transfer admin role via two-step process', async () => {
      const newAdmin = await blockchain.treasury('newAdmin');

      // Step 1: propose new admin
      const proposeResult = await factory.send(
        admin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'TransferAdmin', newAdmin: newAdmin.address }
      );

      expect(proposeResult.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: true
      });

      // Admin unchanged until accepted
      expect((await factory.getGetAdmin()).equals(admin.address)).toBe(true);
      expect((await factory.getGetPendingAdmin())!.equals(newAdmin.address)).toBe(true);

      // Step 2: new admin accepts
      const acceptResult = await factory.send(
        newAdmin.getSender(),
        { value: toNano('0.05') },
        { $$type: 'AcceptAdmin' }
      );

      expect(acceptResult.transactions).toHaveTransaction({
        from: newAdmin.address,
        to: factory.address,
        success: true
      });

      expect((await factory.getGetAdmin()).equals(newAdmin.address)).toBe(true);
      expect(await factory.getGetPendingAdmin()).toBeNull();

      // Old admin should no longer be able to deploy
      const endTime = BigInt(blockchain.now! + 3600);
      const deployResult = await factory.send(
        admin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Should fail?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      expect(deployResult.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: false,
        exitCode: 63259 // "Only admin can deploy markets"
      });

      // New admin SHOULD be able to deploy
      const newAdminDeploy = await factory.send(
        newAdmin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'New admin market?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      expect(newAdminDeploy.transactions).toHaveTransaction({
        from: newAdmin.address,
        to: factory.address,
        success: true
      });

      expect(await factory.getGetMarketCount()).toBe(1n);
    });

    it('should allow admin to withdraw from factory', async () => {
      // Fund the factory first
      await factory.send(admin.getSender(), { value: toNano('2') }, { $$type: 'FundFactory' });

      const recipient = (await blockchain.treasury('recipient')).address;

      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.05') },
        {
          $$type: 'WithdrawFees',
          amount: toNano('0.5'),
          recipient
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: true
      });
    });

    it('should reject withdrawal exceeding available balance', async () => {
      const recipient = (await blockchain.treasury('recipient2')).address;

      // Try to withdraw more than the factory has (minus 0.01 TON reserve)
      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.05') },
        {
          $$type: 'WithdrawFees',
          amount: toNano('999'),
          recipient
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: admin.address,
        to: factory.address,
        success: false
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // Getter Tests
  // ────────────────────────────────────────────────────────
  describe('Getters', () => {
    it('getAdmin returns correct admin address', async () => {
      expect((await factory.getGetAdmin()).equals(admin.address)).toBe(true);
    });

    it('getDefaultOracle returns configured oracle', async () => {
      expect((await factory.getGetDefaultOracle()).equals(oracle.address)).toBe(true);
    });

    it('getDefaultBackendPubKey returns configured key', async () => {
      expect(await factory.getGetDefaultBackendPubKey()).toBe(backendPubKey);
    });

    it('getDefaultMinBet returns configured minimum', async () => {
      expect(await factory.getGetDefaultMinBet()).toBe(defaultMinBet);
    });

    it('getDefaultFeePercentage returns configured fee', async () => {
      expect(await factory.getGetDefaultFeePercentage()).toBe(defaultFeePercentage);
    });

    it('getMarketCount returns correct count', async () => {
      expect(await factory.getGetMarketCount()).toBe(0n);

      const endTime = BigInt(blockchain.now! + 3600);
      await factory.send(
        admin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Count test?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      expect(await factory.getGetMarketCount()).toBe(1n);
    });

    it('getMarket returns correct market address', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      await factory.send(
        admin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question: 'Address test?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      const addr = await factory.getGetMarket(0n);
      expect(addr).not.toBeNull();

      // Non-existent market should return null
      const noAddr = await factory.getGetMarket(999n);
      expect(noAddr).toBeNull();
    });

    it('computeEscrowAddress computes deterministic address', async () => {
      const endTime = BigInt(blockchain.now! + 3600);
      const question = 'Deterministic test?';

      // Compute address before deployment
      const preComputedAddr = await factory.getComputeEscrowAddress(
        question,
        endTime,
        0n,
        defaultMinBet,
        defaultFeePercentage
      );

      // Deploy the market
      await factory.send(
        admin.getSender(),
        { value: toNano('0.5') },
        {
          $$type: 'DeployMarketEscrow',
          question,
          endTime,
          bettingClosesAt: 0n,
          minBet: defaultMinBet,
          feePercentage: defaultFeePercentage
        }
      );

      // Get actual deployed address
      const actualAddr = await factory.getGetMarket(0n);

      // Pre-computed and actual should match
      expect(preComputedAddr.equals(actualAddr!)).toBe(true);
    });
  });
});
