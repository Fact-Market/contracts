import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import { KeyPair } from '@ton/crypto';
import '@ton/test-utils';
import { PrivateMarketFactory } from '../build/PrivateMarketFactory_PrivateMarketFactory';
import { MarketEscrow } from '../build/PrivateMarketFactory_MarketEscrow';
import { createTestKeyPair, publicKeyToBigInt, signBetReceipt } from './utils/test-helpers';

const TEST_MARKET_ID = 'test-private-market-id';

describe('PrivateMarketFactory', () => {
  let blockchain: Blockchain;
  let admin: SandboxContract<TreasuryContract>;
  let oracle: SandboxContract<TreasuryContract>;
  let creator: SandboxContract<TreasuryContract>;
  let user1: SandboxContract<TreasuryContract>;
  let user2: SandboxContract<TreasuryContract>;
  let backendKeyPair: KeyPair;
  let backendPubKey: bigint;
  let factory: SandboxContract<PrivateMarketFactory>;

  const defaultMinBet = toNano('0.1');
  const defaultFeePercentage = 2n;
  const creationFee = toNano('0.5');

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    admin = await blockchain.treasury('admin');
    oracle = await blockchain.treasury('oracle');
    creator = await blockchain.treasury('creator');
    user1 = await blockchain.treasury('user1');
    user2 = await blockchain.treasury('user2');
    backendKeyPair = await createTestKeyPair();
    backendPubKey = publicKeyToBigInt(backendKeyPair.publicKey);

    blockchain.now = Math.floor(Date.now() / 1000);

    factory = blockchain.openContract(
      await PrivateMarketFactory.fromInit(
        oracle.address,
        backendPubKey,
        defaultMinBet,
        defaultFeePercentage,
        creationFee
      )
    );

    await factory.send(
      admin.getSender(),
      { value: toNano('1') },
      { $$type: 'Deploy', queryId: 0n }
    );

    // Fund the factory so it has enough balance for deploy actions
    await factory.send(admin.getSender(), { value: toNano('5') }, { $$type: 'FundFactory' });
  });

  // ────────────────────────────────────────────────────────
  // Deployment Tests
  // ────────────────────────────────────────────────────────
  describe('Private Market Deployment', () => {
    it('should allow anyone to deploy with sufficient fee', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      const result = await factory.send(
        creator.getSender(),
        { value: creationFee + toNano('0.1') }, // fee + gas
        {
          $$type: 'DeployPrivateMarketEscrow',
          question: 'Will it rain tomorrow?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: creator.address,
        to: factory.address,
        success: true
      });

      expect(await factory.getGetMarketCount()).toBe(1n);
    });

    it('should reject deployment with insufficient fee', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      const result = await factory.send(
        creator.getSender(),
        { value: toNano('0.1') }, // way below 0.5 + 0.02
        {
          $$type: 'DeployPrivateMarketEscrow',
          question: 'Will it rain tomorrow?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: creator.address,
        to: factory.address,
        success: false,
        exitCode: 55501 // Insufficient creation fee
      });
    });

    it('should reject deployment with past endTime', async () => {
      const pastEndTime = BigInt(blockchain.now! - 100);

      const result = await factory.send(
        creator.getSender(),
        { value: creationFee + toNano('0.1') },
        {
          $$type: 'DeployPrivateMarketEscrow',
          question: 'Already ended?',
          endTime: pastEndTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: creator.address,
        to: factory.address,
        success: false,
        exitCode: 26966 // End time must be in future
      });
    });

    it('should reject deployment with fee percentage > 10', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      const result = await factory.send(
        creator.getSender(),
        { value: creationFee + toNano('0.1') },
        {
          $$type: 'DeployPrivateMarketEscrow',
          question: 'Too much fee?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 11n
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: creator.address,
        to: factory.address,
        success: false,
        exitCode: 46136 // Fee too high
      });
    });

    it('should track deployed markets correctly', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      // Deploy two markets
      await factory.send(
        creator.getSender(),
        { value: creationFee + toNano('0.1') },
        {
          $$type: 'DeployPrivateMarketEscrow',
          question: 'Market one?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      await factory.send(
        user1.getSender(),
        { value: creationFee + toNano('0.1') },
        {
          $$type: 'DeployPrivateMarketEscrow',
          question: 'Market two?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      expect(await factory.getGetMarketCount()).toBe(2n);

      const market0 = await factory.getGetMarket(0n);
      const market1 = await factory.getGetMarket(1n);
      expect(market0).not.toBeNull();
      expect(market1).not.toBeNull();
      expect(market0!.toString()).not.toEqual(market1!.toString());
    });

    it('should set creator on deployed escrow', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      await factory.send(
        creator.getSender(),
        { value: creationFee + toNano('0.1') },
        {
          $$type: 'DeployPrivateMarketEscrow',
          question: 'Creator check?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      const escrowAddr = await factory.getGetMarket(0n);
      expect(escrowAddr).not.toBeNull();

      const escrow = blockchain.openContract(MarketEscrow.fromAddress(escrowAddr!));
      const storedCreator = await escrow.getGetCreator();
      expect(storedCreator.equals(creator.address)).toBe(true);
    });
  });

  // ────────────────────────────────────────────────────────
  // Admin Settings Tests
  // ────────────────────────────────────────────────────────
  describe('Admin Settings', () => {
    it('should update creation fee (admin only)', async () => {
      const newFee = toNano('1');
      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'UpdateCreationFee', newFee }
      );

      expect(result.transactions).toHaveTransaction({ success: true });
      expect(await factory.getGetCreationFee()).toBe(newFee);
    });

    it('should reject creation fee update from non-admin', async () => {
      const result = await factory.send(
        user1.getSender(),
        { value: toNano('0.1') },
        { $$type: 'UpdateCreationFee', newFee: toNano('1') }
      );

      expect(result.transactions).toHaveTransaction({
        success: false,
        exitCode: 16461
      });
    });

    it('should enforce new creation fee on subsequent deploys', async () => {
      const newFee = toNano('2');
      await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'UpdateCreationFee', newFee }
      );

      const endTime = BigInt(blockchain.now! + 3600);

      // Old fee should fail
      const failResult = await factory.send(
        creator.getSender(),
        { value: toNano('0.5') + toNano('0.1') },
        {
          $$type: 'DeployPrivateMarketEscrow',
          question: 'Underpaying?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      expect(failResult.transactions).toHaveTransaction({
        success: false,
        exitCode: 55501
      });

      // New fee should succeed
      const okResult = await factory.send(
        creator.getSender(),
        { value: newFee + toNano('0.1') },
        {
          $$type: 'DeployPrivateMarketEscrow',
          question: 'Paying correctly?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      expect(okResult.transactions).toHaveTransaction({ success: true });
    });
  });

  // ────────────────────────────────────────────────────────
  // Fee Withdrawal Tests
  // ────────────────────────────────────────────────────────
  describe('Fee Withdrawal', () => {
    it('should allow admin to withdraw accumulated creation fees', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      // Deploy 2 private markets → 1.0 TON in creation fees
      for (let i = 0; i < 2; i++) {
        await factory.send(
          creator.getSender(),
          { value: creationFee + toNano('0.1') },
          {
            $$type: 'DeployPrivateMarketEscrow',
            question: `Market ${i}?`,
            endTime,
            bettingClosesAt: 0n,
            minBet: 0n,
            feePercentage: 0n
          }
        );
      }

      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'WithdrawFees',
          amount: toNano('0.5'),
          recipient: admin.address
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: factory.address,
        to: admin.address,
        success: true
      });
    });

    it('should reject withdrawal from non-admin', async () => {
      const result = await factory.send(
        user1.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'WithdrawFees',
          amount: toNano('0.1'),
          recipient: user1.address
        }
      );

      expect(result.transactions).toHaveTransaction({
        success: false,
        exitCode: 16461
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // RecordBet Forwarding Tests
  // ────────────────────────────────────────────────────────
  describe('RecordBet', () => {
    it('should forward RecordBet to deployed escrow', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      await factory.send(
        creator.getSender(),
        { value: creationFee + toNano('0.1') },
        {
          $$type: 'DeployPrivateMarketEscrow',
          question: 'Bet test?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      const escrowAddr = await factory.getGetMarket(0n);
      expect(escrowAddr).not.toBeNull();

      // Deposit into escrow
      const escrow = blockchain.openContract(MarketEscrow.fromAddress(escrowAddr!));
      await escrow.send(user1.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });

      // Admin records bet via factory
      const result = await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        {
          $$type: 'RecordBet',
          escrowAddress: escrowAddr!,
          outcome: 1n,
          amount: toNano('2')
        }
      );

      expect(result.transactions).toHaveTransaction({
        from: factory.address,
        to: escrowAddr!,
        success: true
      });

      expect(await escrow.getGetTotalYes()).toBe(toNano('2'));
    });
  });

  // ────────────────────────────────────────────────────────
  // Full E2E: Deploy → Deposit → Bet → CreatorResolve → Claim
  // ────────────────────────────────────────────────────────
  describe('Full E2E Cycle', () => {
    it('complete private market lifecycle', async () => {
      const endTime = BigInt(blockchain.now! + 3600);

      // 1. Creator deploys private market via factory
      await factory.send(
        creator.getSender(),
        { value: creationFee + toNano('0.1') },
        {
          $$type: 'DeployPrivateMarketEscrow',
          question: 'Will team A win?',
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 2n
        }
      );

      const escrowAddr = await factory.getGetMarket(0n);
      expect(escrowAddr).not.toBeNull();
      const escrow = blockchain.openContract(MarketEscrow.fromAddress(escrowAddr!));

      // Verify creator is set
      expect((await escrow.getGetCreator()).equals(creator.address)).toBe(true);

      // 2. Users deposit
      await escrow.send(user1.getSender(), { value: toNano('3') }, { $$type: 'Deposit' });
      await escrow.send(user2.getSender(), { value: toNano('2') }, { $$type: 'Deposit' });

      // 3. Admin records bets
      await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBet', escrowAddress: escrowAddr!, outcome: 1n, amount: toNano('3') }
      );
      await factory.send(
        admin.getSender(),
        { value: toNano('0.1') },
        { $$type: 'RecordBet', escrowAddress: escrowAddr!, outcome: 2n, amount: toNano('2') }
      );

      expect(await escrow.getGetTotalYes()).toBe(toNano('3'));
      expect(await escrow.getGetTotalNo()).toBe(toNano('2'));

      // 4. Creator resolves (early — before endTime)
      const resolveResult = await escrow.send(
        creator.getSender(),
        { value: toNano('0.1') },
        { $$type: 'CreatorResolve', outcome: 1n }
      );

      expect(resolveResult.transactions).toHaveTransaction({ success: true });
      expect(await escrow.getGetResolved()).toBe(true);
      expect(await escrow.getGetWinningOutcome()).toBe(1n);

      // 5. Winner claims
      const signature = signBetReceipt({
        keyPair: backendKeyPair,
        userAddress: user1.address,
        contractAddress: escrowAddr!,
        nonce: 1n,
        outcome: 1n,
        amount: toNano('3'),
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
          amount: toNano('3'),
          marketId: TEST_MARKET_ID,
          signature
        }
      );

      expect(claimResult.transactions).toHaveTransaction({
        from: escrowAddr!,
        to: user1.address,
        success: true
      });
    });
  });

  // ────────────────────────────────────────────────────────
  // Getter Tests
  // ────────────────────────────────────────────────────────
  describe('Getters', () => {
    it('should return correct initial values', async () => {
      expect(await factory.getGetCreationFee()).toBe(creationFee);
      expect(await factory.getGetMarketCount()).toBe(0n);
      expect((await factory.getGetAdmin()).equals(admin.address)).toBe(true);
      expect(await factory.getGetDefaultFeePercentage()).toBe(defaultFeePercentage);
      expect(await factory.getGetDefaultMinBet()).toBe(defaultMinBet);
    });

    it('computeEscrowAddress should match actual deployed address', async () => {
      const endTime = BigInt(blockchain.now! + 3600);
      const question = 'Compute check?';

      const computed = await factory.getComputeEscrowAddress(
        question,
        endTime,
        0n,
        0n,
        0n,
        creator.address
      );

      await factory.send(
        creator.getSender(),
        { value: creationFee + toNano('0.1') },
        {
          $$type: 'DeployPrivateMarketEscrow',
          question,
          endTime,
          bettingClosesAt: 0n,
          minBet: 0n,
          feePercentage: 0n
        }
      );

      const actual = await factory.getGetMarket(0n);
      expect(actual).not.toBeNull();
      expect(computed.equals(actual!)).toBe(true);
    });
  });
});
