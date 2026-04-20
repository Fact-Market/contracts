// Shared message definitions for Fact Market prediction market

// Resolution message sent by oracle
message(0x0eb9c738) ResolveMarket {
    outcome: Int as uint8;  // 1 = Yes, 2 = No, 3 = Cancelled
}

// Claim winnings with signature proof
message(0x7f8549fb) ClaimWinnings {
    nonce: Int as uint64;           // Unique bet identifier
    userAddress: Address;           // Address that placed the bet
    outcome: Int as uint8;          // 1 = Yes, 2 = No
    amount: Int as coins;           // Bet amount in nanotons
    marketId: String;               // DB market ID bound to this receipt
    signature: Slice;               // Ed25519 signature from backend
}

// Refund request (for cancelled markets)
message(0x6d763313) RefundDeposit {
    nonce: Int as uint64;           // Deposit nonce for tracking
    userAddress: Address;           // Address to refund
    amount: Int as coins;           // Amount to refund
    marketId: String;               // DB market ID bound to this receipt
    signature: Slice;               // Ed25519 signature from backend
}

// Update backend public key (admin only)
message(0xfaa2b336) UpdateBackendKey {
    newPubKey: Int as uint256;      // New 256-bit Ed25519 public key
}

// Update oracle address (admin only)
message(0x40a08d51) UpdateOracle {
    newOracle: Address;
}

// Withdraw accumulated fees (admin only)
message(0x0350a2f4) WithdrawFees {
    amount: Int as coins;
    recipient: Address;
}

// Deploy new market escrow from factory
message(0x918ff1ef) DeployMarketEscrow {
    question: String;
    endTime: Int as uint64;
    bettingClosesAt: Int as uint64;  // When betting stops (event start); 0 = same as endTime
    minBet: Int as coins;
    feePercentage: Int as uint8;
}

// Deposit TON into escrow (binary opcode for performance;
message(0x4a25ce37) Deposit {
}

// Emergency cancel: if oracle never resolves within grace period, anyone can trigger
message(0x56bd3ff8) EmergencyCancel {
}

// Event emitted when deposit received
message(0x0d815715) DepositReceived {
    depositor: Address;
    amount: Int as coins;
    timestamp: Int as uint64;
}

// Event emitted when claim processed
message(0x00a3b6dd) ClaimProcessed {
    claimer: Address;
    nonce: Int as uint64;
    amount: Int as coins;
    timestamp: Int as uint64;
}

// Event emitted when market resolved
message(0xec30287c) MarketResolved {
    outcome: Int as uint8;
    totalPool: Int as coins;
    timestamp: Int as uint64;
}

// Event emitted when refund processed
message(0xd8d57933) RefundProcessed {
    recipient: Address;
    nonce: Int as uint64;
    amount: Int as coins;
    timestamp: Int as uint64;
}

// Update minimum bet (factory admin only)
message(0xc91c0948) UpdateMinBet {
    newMinBet: Int as coins;
}

// Update fee percentage (factory admin only)
message(0x1dbf70cf) UpdateFeePercentage {
    newFeePercentage: Int as uint8;
}

// Transfer admin role (two-step: propose then accept)
message(0x0dc797c9) TransferAdmin {
    newAdmin: Address;
}

// Accept pending admin role (sent by the proposed new admin)
message(0x5fd2daef) AcceptAdmin {
}

// Fund the factory with TON (anyone can send, only admin can withdraw)
message(0xc19e47cc) FundFactory {
}

// Record a bet on an escrow contract (sent to factory, which forwards to escrow)
message(0x410bbfb6) RecordBet {
    escrowAddress: Address;     // Target escrow contract
    outcome: Int as uint8;      // 1 = Yes, 2 = No
    amount: Int as coins;       // Explicit bet amount in nanotons
}

// Record a bet directly on an escrow contract (forwarded by factory)
message(0x9af07529) RecordBetOnEscrow {
    outcome: Int as uint8;      // 1 = Yes, 2 = No
    amount: Int as coins;       // Explicit bet amount in nanotons
}

// Update backend public key on a specific deployed escrow (factory forwards to escrow)
message(0xdd8728c0) UpdateEscrowBackendKey {
    escrowAddress: Address;
    newPubKey: Int as uint256;
}

// Update oracle address on a specific deployed escrow (factory forwards to escrow)
message(0x427b9990) UpdateEscrowOracle {
    escrowAddress: Address;
    newOracle: Address;
}

// Deploy a private market escrow (sent by any user to PrivateMarketFactory)
message(0xa1b2c3d4) DeployPrivateMarketEscrow {
    question: String;
    endTime: Int as uint64;
    bettingClosesAt: Int as uint64;  // When betting stops (event start); 0 = same as endTime
    minBet: Int as coins;
    feePercentage: Int as uint8;
}

// Update creation fee for private markets (admin only, sent to PrivateMarketFactory)
message(0xb2c3d4e5) UpdateCreationFee {
    newFee: Int as coins;
}

// Creator resolves their private market (sent by creator to MarketEscrow)
message(0xc3d4e5f6) CreatorResolve {
    outcome: Int as uint8;  // 1 = Yes, 2 = No, 3 = Cancelled
}

// Drain remaining balance from a settled escrow (admin only)
// Recovers deploy funds + accumulated gas leftovers after all claims/refunds are complete
message(0xe4f5a6b7) DrainBalance {
    recipient: Address;
}

// Forward WithdrawFees through factory (factory is escrow admin, wallet can't call escrow directly)
message(0xf5a6b7c8) ForwardWithdrawFees {
    escrowAddress: Address;
    amount: Int as coins;
    recipient: Address;
}

// Forward DrainBalance through factory
message(0xa6b7c8d9) ForwardDrainBalance {
    escrowAddress: Address;
    recipient: Address;
}
