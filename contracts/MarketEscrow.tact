import "@stdlib/deploy";
import "./imports/messages";

fun computeBetHash(contractAddress: Address, userAddress: Address, nonce: Int, outcome: Int, amount: Int, marketId: String): Int {
    let data: Cell = beginCell()
        .storeAddress(userAddress)
        .storeAddress(contractAddress)
        .storeUint(nonce, 64)
        .storeUint(outcome, 8)
        .storeCoins(amount)
        .storeSlice(marketId.asSlice())
        .endCell();
    return data.hash();
}

fun computeRefundHash(contractAddress: Address, userAddress: Address, nonce: Int, amount: Int, marketId: String): Int {
    let data: Cell = beginCell()
        .storeAddress(userAddress)
        .storeAddress(contractAddress)
        .storeUint(nonce, 64)
        .storeUint(0, 8)
        .storeCoins(amount)
        .storeSlice(marketId.asSlice())
        .endCell();
    return data.hash();
}

// MarketEscrow: Holds funds for a single prediction market
// - Accepts TON deposits from users
// - Tracks total pool and per-outcome totals
// - Verifies backend-signed bet receipts for claims
// - Oracle resolves market outcome
// - Users can claim directly with their receipt (trustless)
// - Uses custom Deploy receive (not Deployable trait) to keep 0.02 TON for gas
contract MarketEscrow {
    // Configuration (immutable after deployment)
    question: String;
    endTime: Int as uint64;
    bettingClosesAt: Int as uint64;  // When betting stops (event start); <= endTime
    minBet: Int as coins;
    feePercentage: Int as uint8;
    
    // Key addresses
    admin: Address;                         // Can update keys, withdraw fees
    oracle: Address;                        // Can resolve market
    backendPubKey: Int as uint256;         // Backend's Ed25519 public key for signature verification
    creator: Address;                       // Market creator: factory address = public, user address = private (can CreatorResolve)
    
    // Market state
    resolved: Bool;
    winningOutcome: Int as uint8;           // 0 = unresolved, 1 = Yes, 2 = No, 3 = Cancelled
    
    // Pool tracking
    totalPool: Int as coins;
    totalYes: Int as coins;
    totalNo: Int as coins;
    
    // Claim tracking by nonce (prevents double-spend).
    // IMPORTANT: This map is shared between ClaimWinnings and RefundDeposit.
    // The backend MUST issue nonces from separate ranges to prevent collisions.
    // Recommended: claims use 0x1_XXXX prefix, refunds use 0x2_XXXX prefix.
    // We never .del() nonces (UnboundMap): removing would allow double-claim; growth is bounded by number of claims/refunds.
    claimedNonces: map<Int, Bool>;
    
    // Deposit tracking by user (for refunds on cancellation)
    deposits: map<Address, Int>;
    
    // Fee tracking (cumulative amount withdrawn, supports partial withdrawals)
    feesWithdrawn: Int as coins;

    // Payout tracking: cumulative sum of all winnings + refunds sent to users.
    // DrainBalance uses this to enforce that all claims are settled before admin can drain.
    totalPaidOut: Int as coins;
    
    init(
        question: String,
        endTime: Int,
        bettingClosesAt: Int,
        oracle: Address,
        backendPubKey: Int,
        minBet: Int,
        feePercentage: Int,
        admin: Address,
        creator: Address
    ) {
        throwUnless(46136, feePercentage <= 10);  // Fee too high

        self.question = question;
        self.endTime = endTime;
        self.bettingClosesAt = bettingClosesAt > 0 ? bettingClosesAt : endTime;
        self.oracle = oracle;
        self.backendPubKey = backendPubKey;
        self.minBet = minBet;
        self.feePercentage = feePercentage;

        self.admin = admin;
        self.creator = creator;
        self.resolved = false;
        self.winningOutcome = 0;
        self.totalPool = 0;
        self.totalYes = 0;
        self.totalNo = 0;
        self.feesWithdrawn = 0;
        self.totalPaidOut = 0;
    }

    // Override Deployable: accept Deploy but keep the 0.02 TON for gas.
    // Default Deployable sends value back via notify(); factory does not handle DeployOk, causing failed transfers.
    receive(deploy: Deploy) {
        // Accept and keep funds — no forward to sender
    }

    // Accept TON deposits
    // Users send TON to this contract, backend indexes and credits their balance
    receive(msg: Deposit) {
        throwUnless(36192, now() < self.bettingClosesAt);  // Betting closed
        throwUnless(20846, !self.resolved);  // Market already resolved
        
        let amount: Int = context().value;
        throwUnless(54981, amount >= self.minBet);  // Deposit below minimum
        
        // Track deposit for potential refund
        let existingDepositOpt: Int? = self.deposits.get(sender());
        let existingDeposit: Int = existingDepositOpt != null ? existingDepositOpt!! : 0;
        self.deposits.set(sender(), existingDeposit + amount);
        
        self.totalPool += amount;
        // Indexer uses getTransactions + "deposit" comment, not DepositReceived event.
        // emit() sends to addr_none and causes Failed Transfer on Tonscan; removed.
    }
    
    // Oracle resolves the market
    receive(msg: ResolveMarket) {
        throwUnless(37536, sender() == self.oracle);  // Only oracle can resolve
        throwUnless(31038, !self.resolved);  // Already resolved
        throwUnless(38283, msg.outcome >= 1 && msg.outcome <= 3);  // Invalid outcome
        
        // Auto-cancel if winning side has zero bets (prevents permanent fund lock)
        let effectiveOutcome: Int = msg.outcome;
        if ((msg.outcome == 1 && self.totalYes == 0) || (msg.outcome == 2 && self.totalNo == 0)) {
            effectiveOutcome = 3;
        }
        
        self.resolved = true;
        self.winningOutcome = effectiveOutcome;
        
        // Return unused gas to oracle
        cashback(sender());
        
        // Emit event
        emit(MarketResolved{
            outcome: effectiveOutcome,
            totalPool: self.totalPool,
            timestamp: now()
        }.toCell());
    }
    
    // Creator resolves their private market (no endTime restriction)
    // Only works on private markets where creator != admin (factory sentinel)
    receive(msg: CreatorResolve) {
        throwUnless(37536, sender() == self.creator);           // Only creator
        throwUnless(37537, self.creator != self.admin);         // Not on public markets (creator == factory)
        throwUnless(31038, !self.resolved);                     // Already resolved
        throwUnless(38283, msg.outcome >= 1 && msg.outcome <= 3);  // Invalid outcome

        // Auto-cancel if winning side has zero bets (prevents permanent fund lock)
        // Matches oracle ResolveMarket logic: only cancel when winners can't claim
        let effectiveOutcome: Int = msg.outcome;
        if ((msg.outcome == 1 && self.totalYes == 0) || (msg.outcome == 2 && self.totalNo == 0)) {
            effectiveOutcome = 3;
        }

        self.resolved = true;
        self.winningOutcome = effectiveOutcome;

        cashback(sender());

        emit(MarketResolved{
            outcome: effectiveOutcome,
            totalPool: self.totalPool,
            timestamp: now()
        }.toCell());
    }

    // Claim winnings with backend-signed receipt
    // This allows users to claim even if backend is down
    receive(msg: ClaimWinnings) {
        throwUnless(18221, self.resolved);  // Market not resolved
        throwUnless(36693, self.winningOutcome != 3);  // Market cancelled - use refund
        throwUnless(7047, msg.outcome == self.winningOutcome);  // Bet not on winning outcome
        
        // Check nonce not already claimed
        let alreadyClaimedOpt: Bool? = self.claimedNonces.get(msg.nonce);
        let alreadyClaimed: Bool = alreadyClaimedOpt != null ? alreadyClaimedOpt!! : false;
        throwUnless(42504, !alreadyClaimed);  // Already claimed
        
        // Verify signature from backend
        // Message hash = hash(userAddress, contractAddress, nonce, outcome, amount, marketId)
        let messageHash: Int = computeBetHash(
            myAddress(),
            msg.userAddress,
            msg.nonce,
            msg.outcome,
            msg.amount,
            msg.marketId
        );
        
        throwUnless(48401, checkSignature(messageHash, msg.signature, self.backendPubKey));  // Invalid signature
        
        // Claim amount cannot exceed user's total deposit (defense-in-depth against key compromise)
        let userDeposit: Int = self.getUserDeposit(msg.userAddress);
        throwUnless(46410, msg.amount <= userDeposit);  // Claim amount exceeds deposit
        
        // Calculate user's share of prize pool (multiply before divide to avoid precision loss)
        let winningTotal: Int = self.winningOutcome == 1 ? self.totalYes : self.totalNo;
        throwUnless(17833, winningTotal > 0);  // No bets on winning side
        
        // prizePool = totalPool * (100 - feePercentage) / 100; userShare = amount * prizePool / winningTotal
        // Combined: userShare = amount * totalPool * (100 - feePercentage) / (100 * winningTotal)
        let userShare: Int = (msg.amount * self.totalPool * (100 - self.feePercentage)) / (100 * winningTotal);
        
        throwUnless(44799, userShare > 0);  // Nothing to claim
        
        // Mark nonce as claimed BEFORE sending (prevents reentrancy)
        self.claimedNonces.set(msg.nonce, true);
        self.totalPaidOut += userShare;
        
        // Decrement user deposit to maintain defense-in-depth invariant
        // Prevents multiple valid-nonce claims from exceeding the original deposit
        let newDeposit: Int = userDeposit - msg.amount;
        if (newDeposit > 0) {
            self.deposits.set(msg.userAddress, newDeposit);
        } else {
            self.deposits.del(msg.userAddress);
        }
        
        // Send winnings (default mode: reverts entire tx on failure so nonce stays unclaimed)
        message(MessageParameters{
            to: msg.userAddress,
            value: userShare,
            bounce: false,
            body: "Fact Market payout".asComment()
        });
        
        // Return unused gas to claim sender
        cashback(sender());
        
        // Emit event
        emit(ClaimProcessed{
            claimer: msg.userAddress,
            nonce: msg.nonce,
            amount: userShare,
            timestamp: now()
        }.toCell());
    }
    
    // Refund deposits for cancelled markets
    receive(msg: RefundDeposit) {
        throwUnless(18221, self.resolved);  // Market not resolved
        throwUnless(1871, self.winningOutcome == 3);  // Market not cancelled
        
        // Check nonce not already refunded
        let alreadyRefundedOpt: Bool? = self.claimedNonces.get(msg.nonce);
        let alreadyRefunded: Bool = alreadyRefundedOpt != null ? alreadyRefundedOpt!! : false;
        throwUnless(22411, !alreadyRefunded);  // Already refunded
        
        // Verify signature from backend
        let messageHash: Int = computeRefundHash(
            myAddress(),
            msg.userAddress,
            msg.nonce,
            msg.amount,
            msg.marketId
        );
        
        throwUnless(48401, checkSignature(messageHash, msg.signature, self.backendPubKey));  // Invalid signature
        
        // Refund amount cannot exceed user's total deposit (defense-in-depth against key compromise)
        let userDeposit: Int = self.getUserDeposit(msg.userAddress);
        throwUnless(25605, msg.amount <= userDeposit);  // Refund exceeds deposit
        
        // Mark as refunded
        self.claimedNonces.set(msg.nonce, true);
        self.totalPaidOut += msg.amount;
        
        // Decrement user deposit to maintain defense-in-depth invariant
        let newDeposit: Int = userDeposit - msg.amount;
        if (newDeposit > 0) {
            self.deposits.set(msg.userAddress, newDeposit);
        } else {
            self.deposits.del(msg.userAddress);
        }
        
        // Send refund (default mode: reverts entire tx on failure so nonce stays unrefunded)
        message(MessageParameters{
            to: msg.userAddress,
            value: msg.amount,
            bounce: false,
            body: "Fact Market refund".asComment()
        });
        
        // Return unused gas to refund sender
        cashback(sender());
        
        // Emit event
        emit(RefundProcessed{
            recipient: msg.userAddress,
            nonce: msg.nonce,
            amount: msg.amount,
            timestamp: now()
        }.toCell());
    }
    
    // Record bet totals (called by factory admin for tracking)
    // Uses explicit amount from message body (not context().value) to avoid gas inflation
    // Invariant: totalPool >= totalYes + totalNo (totalPool from deposits, totals from bet records)
    // Any difference = unallocated deposits (user deposited but didn't bet full amount)
    receive(msg: RecordBetOnEscrow) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        throwUnless(7405, !self.resolved);  // Market resolved
        throwUnless(36192, now() < self.bettingClosesAt);  // Betting closed
        throwUnless(61135, msg.amount > 0);  // Amount must be positive
        
        // Enforce invariant: totalYes + totalNo + amount must not exceed totalPool.
        // Hard revert instead of silent failure — a silent failure could cause pool
        // insolvency if the backend issues claim receipts for unrecorded bets.
        throwUnless(50840, self.totalYes + self.totalNo + msg.amount <= self.totalPool);  // Bet exceeds pool
        
        if (msg.outcome == 1) {
            self.totalYes += msg.amount;
        } else if (msg.outcome == 2) {
            self.totalNo += msg.amount;
        } else {
            throwUnless(38283, false);  // Invalid outcome
        }
        // Do NOT cashback: escrow's cashback to factory causes Failed Transfer on Tonscan.
        // Factory may not accept the empty message format; escrow keeps ~0.01 for gas.
    }
    
    // Withdraw accumulated fees (admin only)
    receive(msg: WithdrawFees) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        throwUnless(18221, self.resolved);  // Market not resolved
        throwUnless(26045, self.winningOutcome != 3);  // Market cancelled
        throwUnless(61135, msg.amount > 0);  // Amount must be positive
        
        let fee: Int = (self.totalPool * self.feePercentage) / 100;
        throwUnless(23771, self.feesWithdrawn + msg.amount <= fee);  // Amount exceeds remaining fee
        
        // Keep a minimum balance for storage rent (prevents account deactivation)
        throwUnless(54238, myBalance() - msg.amount >= ton("0.01"));  // Insufficient balance after withdrawal
        
        self.feesWithdrawn += msg.amount;
        
        // Default mode: reverts on failure so feesWithdrawn stays unchanged
        message(MessageParameters{
            to: msg.recipient,
            value: msg.amount,
            bounce: false,
            body: "Fact Market fees".asComment()
        });
        
        // Return unused gas to admin
        cashback(sender());
    }
    
    // Drain remaining balance after market is fully settled (admin only)
    // Recovers deploy funds + gas leftovers. Keeps 0.01 TON for storage rent.
    //
    // Drain is allowed when EITHER:
    //   (A) All payouts settled: totalPaidOut >= expectedPayout
    //       YES/NO: prize pool after fees = totalPool * (100 - fee%) / 100
    //       CANCEL: sum of recorded bets = totalYes + totalNo
    //         (gas overpayments inflate totalPool but are not refunded — using totalPool
    //          would make path A permanently unreachable for cancelled markets)
    //   (B) Claim window expired: now() >= endTime + 90 days
    //       After the window, unclaimed winnings are forfeited — prevents permanent lock
    //       if a user loses their key or never claims.
    //
    // Note: integer division in the YES/NO formula can leave a few nanoton of rounding
    // dust (sum of userShares <= expectedPayout). Path B covers this edge case.
    receive(msg: DrainBalance) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        throwUnless(18221, self.resolved);  // Market not resolved

        // CANCEL: refunds cover recorded bet amounts only; gas overpayments are non-refundable dust
        // YES/NO: prize pool after fees; integer rounding means totalPaidOut may fall short by dust
        let expectedPayout: Int = self.winningOutcome == 3
            ? self.totalYes + self.totalNo
            : (self.totalPool * (100 - self.feePercentage)) / 100;
        let allSettled: Bool = self.totalPaidOut >= expectedPayout;
        let windowExpired: Bool = now() >= self.endTime + 90 * 24 * 3600;
        throwUnless(39281, allSettled || windowExpired);  // Payouts pending and claim window active

        let minKeep: Int = ton("0.01");
        let drainable: Int = myBalance() - minKeep - context().value;  // Exclude gas sent with this msg
        throwUnless(54238, drainable > 0);  // Nothing to drain

        message(MessageParameters{
            to: msg.recipient,
            value: drainable,
            bounce: false,
            body: "Fact Market drain".asComment()
        });
    }

    // Update backend public key (admin only, for key rotation)
    receive(msg: UpdateBackendKey) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        self.backendPubKey = msg.newPubKey;
    }
    
    // Update oracle address (admin only)
    receive(msg: UpdateOracle) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        self.oracle = msg.newOracle;
    }
    
    // Emergency cancel: if oracle never resolves within grace period after endTime,
    // anyone can trigger cancellation so users can get refunds.
    // Grace period: 30 days after endTime.
    receive(msg: EmergencyCancel) {
        throwUnless(31038, !self.resolved);  // Already resolved
        throwUnless(12914, now() >= self.endTime + 30 * 24 * 3600);  // Grace period not expired
        
        self.resolved = true;
        self.winningOutcome = 3; // Cancel
        
        cashback(sender());
        
        emit(MarketResolved{
            outcome: 3,
            totalPool: self.totalPool,
            timestamp: now()
        }.toCell());
    }
    
    // Getter functions
    get fun getQuestion(): String {
        return self.question;
    }
    
    get fun getEndTime(): Int {
        return self.endTime;
    }

    get fun getBettingClosesAt(): Int {
        return self.bettingClosesAt;
    }
    
    get fun getResolved(): Bool {
        return self.resolved;
    }
    
    get fun getWinningOutcome(): Int {
        return self.winningOutcome;
    }
    
    get fun getTotalPool(): Int {
        return self.totalPool;
    }
    
    get fun getTotalYes(): Int {
        return self.totalYes;
    }
    
    get fun getTotalNo(): Int {
        return self.totalNo;
    }
    
    get fun getMinBet(): Int {
        return self.minBet;
    }
    
    get fun getFeePercentage(): Int {
        return self.feePercentage;
    }
    
    get fun getBackendPubKey(): Int {
        return self.backendPubKey;
    }
    
    get fun getOracle(): Address {
        return self.oracle;
    }
    
    get fun getAdmin(): Address {
        return self.admin;
    }

    get fun getCreator(): Address {
        return self.creator;
    }
    
    get fun isNonceClaimed(nonce: Int): Bool {
        let claimed: Bool? = self.claimedNonces.get(nonce);
        if (claimed != null) {
            return claimed!!;
        }
        return false;
    }
    
    get fun getUserDeposit(user: Address): Int {
        let deposit: Int? = self.deposits.get(user);
        if (deposit != null) {
            return deposit!!;
        }
        return 0;
    }
    
    get fun getFeesWithdrawn(): Int {
        return self.feesWithdrawn;
    }

    get fun getTotalPaidOut(): Int {
        return self.totalPaidOut;
    }

    get fun getClaimWindowExpiry(): Int {
        return self.endTime + 90 * 24 * 3600;
    }
    
    // Calculate expected payout for a bet
    get fun calculatePayout(betAmount: Int, outcome: Int): Int {
        if (!self.resolved || self.winningOutcome != outcome) {
            return 0;
        }
        
        let winningTotal: Int = self.winningOutcome == 1 ? self.totalYes : self.totalNo;
        if (winningTotal == 0) {
            return 0;
        }
        
        // Multiply before divide to avoid precision loss: prizePool = totalPool*(100-feePct)/100
        return (betAmount * self.totalPool * (100 - self.feePercentage)) / (100 * winningTotal);
    }
}

