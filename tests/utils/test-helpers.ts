import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, toNano, Slice } from '@ton/core';
import { KeyPair, mnemonicNew, mnemonicToPrivateKey, sign } from '@ton/crypto';
import { MarketEscrow } from '../../build/MarketEscrow_MarketEscrow';

// Generate a random Ed25519 keypair for testing
export async function createTestKeyPair(): Promise<KeyPair> {
  const mnemonic = await mnemonicNew(24);
  return mnemonicToPrivateKey(mnemonic);
}

// Convert public key buffer to bigint (as stored in contract)
export function publicKeyToBigInt(publicKey: Buffer): bigint {
  return BigInt('0x' + publicKey.toString('hex'));
}

// Sign bet receipt matching the contract's computeBetHash logic:
//   hash(userAddress, contractAddress, nonce, outcome, amount, marketId)
export function signBetReceipt(params: {
  keyPair: KeyPair;
  userAddress: Address;
  contractAddress: Address;
  nonce: bigint;
  outcome: bigint;
  amount: bigint;
  marketId: string;
}): Slice {
  const { keyPair, userAddress, contractAddress, nonce, outcome, amount, marketId } = params;

  const cell = beginCell()
    .storeAddress(userAddress)
    .storeAddress(contractAddress)
    .storeUint(nonce, 64)
    .storeUint(outcome, 8)
    .storeCoins(amount)
    .storeStringTail(marketId)
    .endCell();

  const hash = cell.hash();
  const signature = sign(hash, keyPair.secretKey);

  return beginCell().storeBuffer(signature).endCell().asSlice();
}

// Sign refund receipt matching the contract's computeRefundHash logic:
//   hash(userAddress, contractAddress, nonce, 0, amount, marketId)
export function signRefundReceipt(params: {
  keyPair: KeyPair;
  userAddress: Address;
  contractAddress: Address;
  nonce: bigint;
  amount: bigint;
  marketId: string;
}): Slice {
  const { keyPair, userAddress, contractAddress, nonce, amount, marketId } = params;

  const cell = beginCell()
    .storeAddress(userAddress)
    .storeAddress(contractAddress)
    .storeUint(nonce, 64)
    .storeUint(0, 8) // 0 indicates refund
    .storeCoins(amount)
    .storeStringTail(marketId)
    .endCell();

  const hash = cell.hash();
  const signature = sign(hash, keyPair.secretKey);

  return beginCell().storeBuffer(signature).endCell().asSlice();
}

// Deploy a MarketEscrow contract in sandbox with standard test parameters
// creator defaults to admin.address (public market sentinel — no CreatorResolve privileges)
export async function deployEscrow(params: {
  blockchain: Blockchain;
  admin: SandboxContract<TreasuryContract>;
  oracle: SandboxContract<TreasuryContract>;
  backendPubKey: bigint;
  question?: string;
  endTime?: bigint;
  minBet?: bigint;
  feePercentage?: bigint;
  creator?: Address;
}): Promise<SandboxContract<MarketEscrow>> {
  const {
    blockchain,
    admin,
    oracle,
    backendPubKey,
    question = 'Will BTC reach $100k?',
    endTime = BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour from now
    minBet = toNano('0.1'),
    feePercentage = 2n,
    creator
  } = params;

  const escrow = blockchain.openContract(
    await MarketEscrow.fromInit(
      question,
      endTime,
      0n, // bettingClosesAt: 0 = defaults to endTime
      oracle.address,
      backendPubKey,
      minBet,
      feePercentage,
      admin.address,
      creator ?? admin.address
    )
  );

  await escrow.send(admin.getSender(), { value: toNano('1') }, { $$type: 'Deploy', queryId: 0n });

  return escrow;
}
