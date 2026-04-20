import "@stdlib/deploy";
import "./imports/messages";
import "./MarketEscrow";

// PrivateMarketFactory: Permissionless factory for private prediction markets
// - Anyone can deploy a private market by paying a creation fee
// - Admin manages settings, withdraws accumulated fees
// - Deploys the same MarketEscrow contract with creator = sender()
// - Creator can resolve their market via CreatorResolve on the escrow
contract PrivateMarketFactory with Deployable {
    // Admin address (manages settings, withdraws fees)
    admin: Address;

    // Default settings for new markets
    defaultOracle: Address;
    defaultBackendPubKey: Int as uint256;
    defaultMinBet: Int as coins;
    defaultFeePercentage: Int as uint8;

    // Creation fee for private markets
    creationFee: Int as coins;

    // Two-step admin transfer
    pendingAdmin: Address?;

    // Market tracking
    marketCount: Int as uint32;
    markets: map<Int, Address>;
    escrowAddresses: map<Address, Bool>;

    init(
        oracle: Address,
        backendPubKey: Int,
        minBet: Int,
        feePercentage: Int,
        creationFee: Int
    ) {
        self.admin = sender();
        self.defaultOracle = oracle;
        self.defaultBackendPubKey = backendPubKey;
        self.defaultMinBet = minBet;
        self.defaultFeePercentage = feePercentage;
        self.creationFee = creationFee;
        self.marketCount = 0;
    }

    // Deploy a private market escrow — anyone can call by paying the creation fee
    receive(msg: DeployPrivateMarketEscrow) {
        throwUnless(26966, msg.endTime > now());  // End time must be in future

        // bettingClosesAt: 0 means same as endTime; otherwise must be <= endTime and in future
        let bettingClosesAt: Int = msg.bettingClosesAt > 0 ? msg.bettingClosesAt : msg.endTime;
        throwUnless(26967, bettingClosesAt <= msg.endTime);  // Betting cutoff after end time
        throwUnless(26968, bettingClosesAt > now());  // Betting cutoff must be in future

        let minBet: Int = msg.minBet > 0 ? msg.minBet : self.defaultMinBet;
        let feePercentage: Int = msg.feePercentage > 0 ? msg.feePercentage : self.defaultFeePercentage;
        throwUnless(46136, feePercentage <= 10);  // Fee too high

        // Require creation fee + gas for escrow deployment
        throwUnless(55501, context().value >= self.creationFee + ton("0.05"));

        // Deploy MarketEscrow with creator = sender() (enables CreatorResolve)
        let escrowInit: StateInit = initOf MarketEscrow(
            msg.question,
            msg.endTime,
            bettingClosesAt,
            self.defaultOracle,
            self.defaultBackendPubKey,
            minBet,
            feePercentage,
            myAddress(),    // admin = this factory
            sender()        // creator = the user who paid
        );

        let escrowAddress: Address = contractAddress(escrowInit);

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

        // Creation fee stays in factory balance.
        // Do NOT cashback — that would return the creation fee.
        // Excess above (creationFee + 0.02) is kept as additional gas reserve.
    }

    // Update creation fee (admin only)
    receive(msg: UpdateCreationFee) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        self.creationFee = msg.newFee;
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
        throwUnless(46136, msg.newFeePercentage <= 10);  // Fee too high
        self.defaultFeePercentage = msg.newFeePercentage;
    }

    // Record a bet on an escrow contract (forwards to escrow)
    receive(msg: RecordBet) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        throwUnless(38283, msg.outcome == 1 || msg.outcome == 2);  // Invalid outcome
        throwUnless(61135, msg.amount > 0);  // Amount must be positive

        let isOurs: Bool? = self.escrowAddresses.get(msg.escrowAddress);
        throwUnless(43323, isOurs != null && isOurs!!);  // Unknown escrow

        message(MessageParameters{
            to: msg.escrowAddress,
            value: ton("0.01"),
            bounce: true,
            body: RecordBetOnEscrow{
                outcome: msg.outcome,
                amount: msg.amount
            }.toCell()
        });
    }

    // Accept TON deposits to fund the factory
    receive(msg: FundFactory) {
        // Just accept the TON
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

    // Fallback: accept plain TON transfers and text comments silently
    receive() {}
    receive(msg: String) {}

    // Withdraw accumulated TON from factory (admin only)
    receive(msg: WithdrawFees) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        throwUnless(61135, msg.amount > 0);  // Amount must be positive
        throwUnless(54615, myBalance() - msg.amount > ton("0.01"));  // Insufficient balance

        message(MessageParameters{
            to: msg.recipient,
            value: msg.amount,
            bounce: false,
            body: "private factory withdrawal".asComment()
        });
    }

    // Propose new admin (two-step)
    receive(msg: TransferAdmin) {
        throwUnless(16461, sender() == self.admin);  // Only admin
        self.pendingAdmin = msg.newAdmin;
    }

    // Accept pending admin role
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

    get fun getCreationFee(): Int {
        return self.creationFee;
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
        feePercentage: Int,
        creator: Address
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
            creator
        );
        return contractAddress(escrowInit);
    }
}
