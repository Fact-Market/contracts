import "@stdlib/deploy";
import "./imports/messages";
import "./MarketEscrow";

// MarketFactory: Deploys and manages MarketEscrow contracts
// - Stores backend and oracle public keys
// - Deploys new escrow contracts for each market
// - Tracks all deployed markets
// - Admin can update global settings
contract MarketFactory with Deployable {
    // Admin address (can deploy markets, update settings)
    admin: Address;
    
    // Default settings for new markets
    defaultOracle: Address;
    defaultBackendPubKey: Int as uint256;
    defaultMinBet: Int as coins;
    defaultFeePercentage: Int as uint8;
    
    // Two-step admin transfer
    pendingAdmin: Address?;
    
    // Market tracking
    marketCount: Int as uint32;
    // Market tracking (no .del in MVP; UnboundMap: growth bounded by number of deployed markets)
    markets: map<Int, Address>;  // marketId -> escrow contract address
    escrowAddresses: map<Address, Bool>;  // reverse lookup for escrow validation
    
    init(
        oracle: Address,
        backendPubKey: Int,
        minBet: Int,
        feePercentage: Int
    ) {
        self.admin = sender();
        self.defaultOracle = oracle;
        self.defaultBackendPubKey = backendPubKey;
        self.defaultMinBet = minBet;
        self.defaultFeePercentage = feePercentage;
        self.marketCount = 0;
    }
    
    // Deploy a new market escrow contract
    receive(msg: DeployMarketEscrow) {
        throwUnless(63259, sender() == self.admin);  // Only admin can deploy markets
        throwUnless(26966, msg.endTime > now());  // End time must be in future

        // bettingClosesAt: 0 means same as endTime; otherwise must be <= endTime and in future
        let bettingClosesAt: Int = msg.bettingClosesAt > 0 ? msg.bettingClosesAt : msg.endTime;
        throwUnless(26967, bettingClosesAt <= msg.endTime);  // Betting cutoff after end time
        throwUnless(26968, bettingClosesAt > now());  // Betting cutoff must be in future

        // Use provided values or defaults
        let minBet: Int = msg.minBet > 0 ? msg.minBet : self.defaultMinBet;
        let feePercentage: Int = msg.feePercentage > 0 ? msg.feePercentage : self.defaultFeePercentage;
        throwUnless(46136, feePercentage <= 10);  // Fee too high

        // Deploy new escrow contract (pass myAddress() as admin so factory can manage it)
        // creator = myAddress() → public market sentinel (no CreatorResolve privileges)
        let escrowInit: StateInit = initOf MarketEscrow(
            msg.question,
            msg.endTime,
            bettingClosesAt,
            self.defaultOracle,
            self.defaultBackendPubKey,
            minBet,
            feePercentage,
            myAddress(),
            myAddress()
        );
        
        let escrowAddress: Address = contractAddress(escrowInit);
        
        // Deploy escrow contract with some TON for gas
        // Must send Deploy message (not comment) — MarketEscrow has custom receive(deploy) that accepts Deploy body and keeps funds for gas
        deploy(DeployParameters{
            init: escrowInit,
            value: ton("0.05"),
            bounce: false,
            body: Deploy{queryId: 0}.toCell()
        });
        
        // Track the market
        let marketId: Int = self.marketCount;
        self.markets.set(marketId, escrowAddress);
        self.escrowAddresses.set(escrowAddress, true);
        self.marketCount = marketId + 1;
        
        // Return excess TON to admin
        cashback(sender());
    }
    
    // Update default backend public key
    receive(msg: UpdateBackendKey) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        self.defaultBackendPubKey = msg.newPubKey;
    }
    
    // Forward backend key rotation to a specific deployed escrow
    receive(msg: UpdateEscrowBackendKey) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        let isOurs: Bool? = self.escrowAddresses.get(msg.escrowAddress);
        throwUnless(43323, isOurs != null && isOurs!!);  // Unknown escrow
        message(MessageParameters{
            to: msg.escrowAddress,
            value: ton("0.01"),
            bounce: true,
            body: UpdateBackendKey{ newPubKey: msg.newPubKey }.toCell()
        });
        // Do NOT cashback: same as RecordBet — SendRemainingValue does not account for message() above
    }
    
    // Update default oracle address
    receive(msg: UpdateOracle) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        self.defaultOracle = msg.newOracle;
    }
    
    // Forward oracle rotation to a specific deployed escrow
    receive(msg: UpdateEscrowOracle) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        let isOurs: Bool? = self.escrowAddresses.get(msg.escrowAddress);
        throwUnless(43323, isOurs != null && isOurs!!);  // Unknown escrow
        message(MessageParameters{
            to: msg.escrowAddress,
            value: ton("0.01"),
            bounce: true,
            body: UpdateOracle{ newOracle: msg.newOracle }.toCell()
        });
        // Do NOT cashback: same as RecordBet — SendRemainingValue does not account for message() above
    }
    
    // Update default minimum bet
    receive(msg: UpdateMinBet) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        throwUnless(18417, msg.newMinBet > 0);  // Min bet must be positive
        self.defaultMinBet = msg.newMinBet;
    }
    
    // Update default fee percentage
    receive(msg: UpdateFeePercentage) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        throwUnless(46136, msg.newFeePercentage <= 10);  // Fee too high  // Max 10%
        self.defaultFeePercentage = msg.newFeePercentage;
    }
    
    // Record a bet on an escrow contract (forwards RecordBetOnEscrow with explicit amount)
    // The factory is the escrow admin, so only it can call these
    receive(msg: RecordBet) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        throwUnless(38283, msg.outcome == 1 || msg.outcome == 2);  // Invalid outcome
        throwUnless(61135, msg.amount > 0);  // Amount must be positive
        
        // Validate escrow belongs to this factory
        let isOurs: Bool? = self.escrowAddresses.get(msg.escrowAddress);
        throwUnless(43323, isOurs != null && isOurs!!);  // Unknown escrow
        
        // Forward typed message with explicit amount (send only gas, not bet value)
        message(MessageParameters{
            to: msg.escrowAddress,
            value: ton("0.01"),
            bounce: true,
            body: RecordBetOnEscrow{
                outcome: msg.outcome,
                amount: msg.amount
            }.toCell()
        });
        // Do NOT cashback: cashback uses SendRemainingValue (full inbound) and does not
        // account for the message() above. That caused "Failed Transfer" on Tonscan.
        // Factory keeps ~0.01 per bet for future operations; admin funds via FundFactory.
    }
    
    // Accept TON deposits to fund the factory (anyone can fund, only admin can withdraw)
    receive(msg: FundFactory) {
        // Just accept the TON, no action needed
    }

    // Forward WithdrawFees to escrow (factory is the escrow admin)
    receive(msg: ForwardWithdrawFees) {
        throwUnless(16461, sender() == self.admin);
        let isOurs: Bool? = self.escrowAddresses.get(msg.escrowAddress);
        throwUnless(43323, isOurs != null && isOurs!!);

        message(MessageParameters{
            to: msg.escrowAddress,
            value: ton("0.02"),
            bounce: true,
            body: WithdrawFees{ amount: msg.amount, recipient: msg.recipient }.toCell()
        });
    }

    // Forward DrainBalance to escrow (factory is the escrow admin)
    receive(msg: ForwardDrainBalance) {
        throwUnless(16461, sender() == self.admin);
        let isOurs: Bool? = self.escrowAddresses.get(msg.escrowAddress);
        throwUnless(43323, isOurs != null && isOurs!!);

        message(MessageParameters{
            to: msg.escrowAddress,
            value: ton("0.02"),
            bounce: true,
            body: DrainBalance{ recipient: msg.recipient }.toCell()
        });
    }

    // Fallback: accept plain TON transfers and text comments silently (faucets, withdrawals, etc.)
    receive() {}
    receive(msg: String) {}
    
    // Withdraw accumulated TON from factory (admin only)
    receive(msg: WithdrawFees) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        throwUnless(61135, msg.amount > 0);  // Amount must be positive
        // Keep minimum balance for contract storage rent
        throwUnless(54615, myBalance() - msg.amount > ton("0.01"));  // Insufficient balance
        
        message(MessageParameters{
            to: msg.recipient,
            value: msg.amount,
            bounce: false,
            body: "factory withdrawal".asComment()
        });
    }
    
    // Propose new admin (two-step: propose then accept)
    receive(msg: TransferAdmin) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        self.pendingAdmin = msg.newAdmin;
    }
    
    // Accept pending admin role (must be called by the proposed admin)
    receive(msg: AcceptAdmin) {
        throwUnless(46769, self.pendingAdmin != null);  // No pending admin
        throwUnless(23755, sender() == self.pendingAdmin!!);  // Only pending admin
        self.admin = self.pendingAdmin!!;
        self.pendingAdmin = null;
    }
    
    // Getter functions
    get fun getAdmin(): Address {
        return self.admin;
    }
    
    get fun getPendingAdmin(): Address? {
        return self.pendingAdmin;
    }
    
    get fun getDefaultOracle(): Address {
        return self.defaultOracle;
    }
    
    get fun getDefaultBackendPubKey(): Int {
        return self.defaultBackendPubKey;
    }
    
    get fun getDefaultMinBet(): Int {
        return self.defaultMinBet;
    }
    
    get fun getDefaultFeePercentage(): Int {
        return self.defaultFeePercentage;
    }
    
    get fun getMarketCount(): Int {
        return self.marketCount;
    }
    
    get fun getMarket(marketId: Int): Address? {
        return self.markets.get(marketId);
    }
    
    // Compute escrow address before deployment (for frontend)
    get fun computeEscrowAddress(
        question: String,
        endTime: Int,
        bettingClosesAt: Int,
        minBet: Int,
        feePercentage: Int
    ): Address {
        let escrowInit: StateInit = initOf MarketEscrow(
            question,
            endTime,
            bettingClosesAt > 0 ? bettingClosesAt : endTime,
            self.defaultOracle,
            self.defaultBackendPubKey,
            minBet > 0 ? minBet : self.defaultMinBet,
            feePercentage > 0 ? feePercentage : self.defaultFeePercentage,
            myAddress(),
            myAddress()
        );
        return contractAddress(escrowInit);
    }
}

