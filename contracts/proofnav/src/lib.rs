use near_contract_standards::fungible_token::{
    core::FungibleTokenCore,
    metadata::{FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC},
    FungibleToken, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::{
    env, json_types::U128, near, require, AccountId, PanicOnDefault, PromiseOrValue,
};
use std::collections::HashMap;

const MAX_HISTORY: usize = 500;
const RECONCILED: &str = "MATCHED";

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct NavRecord {
    pub sequence: u64,
    pub valuation_timestamp: u64,
    pub nav_minor_units: U128,
    pub nav_per_share: U128,
    pub share_supply: U128,
    pub currency: String,
    pub merkle_root: String,
    pub snapshot_hash: String,
    pub reconciliation_status: String,
    pub previous_snapshot_hash: Option<String>,
    pub calculation_version: String,
    pub publisher_id: AccountId,
    pub published_at: u64,
}


#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct RedemptionRecord {
    pub investor_id: AccountId,
    pub share_amount: U128,
    pub usdc_amount: U128,
    pub nav_sequence: u64,
    pub request_id: String,
    pub payout_tx_hash: Option<String>,
    pub status: String,
    pub requested_at: u64,
    pub settled_at: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct SubscriptionRecord {
    pub investor_id: AccountId,
    pub usdc_amount: U128,
    pub share_amount: U128,
    pub payment_tx_hash: String,
    pub nav_sequence: u64,
    pub settled_at: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    publisher_id: AccountId,
    approver_id: AccountId,
    fund_id: String,
    token: FungibleToken,
    metadata: FungibleTokenMetadata,
    latest_sequence: u64,
    latest_nav: Option<NavRecord>,
    nav_history: Vec<NavRecord>,
    approved_snapshots: HashMap<u64, String>,
    publication_paused: bool,
    treasury_account: AccountId,
    usdc_token_account: AccountId,
    settlement_operator: AccountId,
    subscriptions: HashMap<String, SubscriptionRecord>,
    redemptions: HashMap<String, RedemptionRecord>,
    redemption_payouts: HashMap<String, String>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner_id: AccountId,
        publisher_id: AccountId,
        approver_id: AccountId,
        fund_id: String,
        treasury_account: AccountId,
        usdc_token_account: AccountId,
        settlement_operator: AccountId,
        initial_holder: AccountId,
        initial_supply: U128,
        metadata: FungibleTokenMetadata,
    ) -> Self {
        require!(!env::state_exists(), "Already initialized");
        require!(metadata.spec == FT_METADATA_SPEC, "Unsupported FT metadata spec");
        require!(metadata.decimals == 8, "ProofNAV share tokens must use 8 decimals");
        require!(initial_supply.0 > 0, "Initial supply must be positive");
        let mut token = FungibleToken::new(b"proofnav_ft".to_vec());
        token.internal_register_account(&initial_holder);
        token.internal_register_account(&env::current_account_id());
        token.internal_deposit(&initial_holder, initial_supply.0);

        Self {
            owner_id,
            publisher_id,
            approver_id,
            fund_id,
            token,
            metadata,
            latest_sequence: 0,
            latest_nav: None,
            nav_history: Vec::new(),
            approved_snapshots: HashMap::new(),
            publication_paused: false,
            treasury_account,
            usdc_token_account,
            settlement_operator,
            subscriptions: HashMap::new(),
            redemptions: HashMap::new(),
            redemption_payouts: HashMap::new(),
        }
    }

    /// Approver authorizes the exact immutable snapshot hash for a sequence.
    pub fn approve_snapshot(&mut self, sequence: u64, snapshot_hash: String) {
        self.assert_approver();
        Self::assert_hash(&snapshot_hash, "snapshot_hash");
        require!(sequence == self.latest_sequence + 1, "Unexpected sequence");
        self.approved_snapshots.insert(sequence, snapshot_hash.clone());
        Self::emit_event("snapshot_approved", &format!(
            r#"{{"fund_id":"{}","sequence":{},"snapshot_hash":"{}","approver_id":"{}"}}"#,
            self.fund_id, sequence, snapshot_hash, env::predecessor_account_id()
        ));
    }

    /// Publisher appends a NAV commitment after matching approval and token supply.
    pub fn publish_nav(
        &mut self,
        sequence: u64,
        valuation_timestamp: u64,
        nav_minor_units: U128,
        nav_per_share: U128,
        expected_share_supply: U128,
        currency: String,
        merkle_root: String,
        snapshot_hash: String,
        reconciliation_status: String,
        calculation_version: String,
    ) {
        self.assert_publisher();
        require!(!self.publication_paused, "NAV publication is paused");
        require!(self.nav_history.len() < MAX_HISTORY, "History limit reached for MVP");
        require!(sequence == self.latest_sequence + 1, "Sequence must increase by one");
        require!(nav_minor_units.0 > 0, "NAV must be positive");
        require!(expected_share_supply.0 == self.token.total_supply, "Share supply mismatch");
        // NAV is expressed in USD cents and shares use 8 token decimals.
        // nav_per_share is USD scaled by 1e8: cents * 1e14 / raw share supply.
        let expected_nav_per_share = nav_minor_units.0
            .checked_mul(100_000_000_000_000)
            .expect("NAV/share scaling overflow") / expected_share_supply.0;
        require!(nav_per_share.0 == expected_nav_per_share, "NAV per share mismatch");
        require!(reconciliation_status == RECONCILED, "Snapshot is not fully reconciled");
        require!(!currency.is_empty() && currency.len() <= 8, "Invalid currency");
        require!(!calculation_version.is_empty(), "Calculation version required");
        Self::assert_hash(&snapshot_hash, "snapshot_hash");
        Self::assert_hash(&merkle_root, "merkle_root");
        require!(
            self.approved_snapshots.get(&sequence) == Some(&snapshot_hash),
            "Snapshot hash has not been approved"
        );
        if let Some(previous) = &self.latest_nav {
            require!(valuation_timestamp >= previous.valuation_timestamp, "Valuation timestamp moved backwards");
        }

        let previous_snapshot_hash = self.latest_nav.as_ref().map(|r| r.snapshot_hash.clone());
        let record = NavRecord {
            sequence,
            valuation_timestamp,
            nav_minor_units,
            nav_per_share,
            share_supply: expected_share_supply,
            currency: currency.clone(),
            merkle_root: merkle_root.clone(),
            snapshot_hash: snapshot_hash.clone(),
            reconciliation_status,
            previous_snapshot_hash,
            calculation_version: calculation_version.clone(),
            publisher_id: env::predecessor_account_id(),
            published_at: env::block_timestamp(),
        };
        self.latest_sequence = sequence;
        self.latest_nav = Some(record.clone());
        self.nav_history.push(record);
        self.approved_snapshots.remove(&sequence);

        Self::emit_event("nav_published", &format!(
            r#"{{"fund_id":"{}","sequence":{},"valuation_timestamp":{},"nav_minor_units":"{}","nav_per_share":"{}","share_supply":"{}","currency":"{}","merkle_root":"{}","snapshot_hash":"{}","reconciliation_status":"MATCHED","calculation_version":"{}"}}"#,
            self.fund_id, sequence, valuation_timestamp, nav_minor_units.0, nav_per_share.0,
            expected_share_supply.0, currency, merkle_root, snapshot_hash, calculation_version
        ));
    }


    /// Settles a subscription only after the trusted settlement operator has
    /// independently verified a finalized NEP-141 USDC transfer to treasury.
    /// The contract enforces role authorization, unique payment hash, NAV-based
    /// share calculation and one-time minting. It cannot independently inspect
    /// another account's historical transaction; the verifier is a trusted oracle.
    pub fn settle_subscription(
        &mut self,
        investor_id: AccountId,
        usdc_amount: U128,
        payment_tx_hash: String,
    ) -> SubscriptionRecord {
        require!(env::predecessor_account_id() == self.settlement_operator, "Settlement operator only");
        require!(usdc_amount.0 > 0, "USDC amount must be positive");
        Self::assert_hash(&payment_tx_hash, "payment_tx_hash");
        require!(!self.subscriptions.contains_key(&payment_tx_hash), "Payment already settled");

        let nav = self.latest_nav.as_ref().expect("NAV must be published before subscriptions");
        require!(nav.currency == "USD", "Subscriptions require USD NAV");
        require!(nav.nav_per_share.0 > 0, "Invalid NAV per share");

        // USDC uses 6 decimals; PNAV uses 8 decimals; NAV/share is USD * 1e8.
        // raw PNAV = raw USDC * 1e10 / NAV-per-share. Rounds down in investor's
        // favour only by leaving the fractional remainder unissued.
        let numerator = usdc_amount.0.checked_mul(10_000_000_000)
            .expect("Subscription share calculation overflow");
        let shares = numerator / nav.nav_per_share.0;
        require!(shares > 0, "Subscription is too small to mint one base share unit");

        if !self.token.accounts.contains_key(&investor_id) {
            self.token.internal_register_account(&investor_id);
        }
        self.token.internal_deposit(&investor_id, shares);

        let record = SubscriptionRecord {
            investor_id: investor_id.clone(),
            usdc_amount,
            share_amount: U128(shares),
            payment_tx_hash: payment_tx_hash.clone(),
            nav_sequence: nav.sequence,
            settled_at: env::block_timestamp(),
        };
        self.subscriptions.insert(payment_tx_hash.clone(), record.clone());
        Self::emit_event("subscription_settled", &format!(
            r#"{{"fund_id":"{}","investor_id":"{}","usdc_amount":"{}","share_amount":"{}","payment_tx_hash":"{}","nav_sequence":{}}}"#,
            self.fund_id, investor_id, usdc_amount.0, shares, payment_tx_hash, nav.sequence
        ));
        record
    }

    pub fn get_subscription(&self, payment_tx_hash: String) -> Option<SubscriptionRecord> {
        self.subscriptions.get(&payment_tx_hash).cloned()
    }

    pub fn get_subscription_count(&self) -> u64 { self.subscriptions.len() as u64 }

    /// Investor escrows PNAV and locks the redemption quote to the latest
    /// published NAV at request time. USDC payout is performed by treasury.
    pub fn request_redemption(&mut self, request_id: String, share_amount: U128) -> RedemptionRecord {
        let investor_id = env::predecessor_account_id();
        require!(request_id.len() >= 8 && request_id.len() <= 128, "Invalid request_id");
        require!(!self.redemptions.contains_key(&request_id), "Redemption request already exists");
        require!(share_amount.0 > 0, "Share amount must be positive");
        let nav = self.latest_nav.as_ref().expect("NAV must be published before redemption");
        require!(nav.currency == "USD", "Redemption requires USD NAV");
        // PNAV raw (1e8) * USD/share raw (1e8) => USDC raw (1e6): divide by 1e10.
        let usdc_amount = share_amount.0.checked_mul(nav.nav_per_share.0)
            .expect("Redemption amount overflow") / 10_000_000_000;
        require!(usdc_amount > 0, "Redemption amount is below one USDC base unit");
        self.token.internal_transfer(&investor_id, &env::current_account_id(), share_amount.0, Some("ProofNAV redemption escrow".to_string()));
        let record = RedemptionRecord {
            investor_id: investor_id.clone(), share_amount, usdc_amount: U128(usdc_amount),
            nav_sequence: nav.sequence, request_id: request_id.clone(), payout_tx_hash: None,
            status: "PENDING_PAYOUT".to_string(), requested_at: env::block_timestamp(), settled_at: None,
        };
        self.redemptions.insert(request_id.clone(), record.clone());
        Self::emit_event("redemption_requested", &format!(
            r#"{{"fund_id":"{}","request_id":"{}","investor_id":"{}","share_amount":"{}","usdc_amount":"{}","nav_sequence":{}}}"#,
            self.fund_id, request_id, investor_id, share_amount.0, usdc_amount, nav.sequence
        ));
        record
    }

    /// Operator may finalize only after independently verifying a finalized
    /// native USDC transfer from the configured treasury to the investor.
    /// The payout transaction hash is globally one-time within this contract.
    pub fn settle_redemption(&mut self, request_id: String, payout_tx_hash: String) -> RedemptionRecord {
        require!(env::predecessor_account_id() == self.settlement_operator, "Settlement operator only");
        Self::assert_hash(&payout_tx_hash, "payout_tx_hash");
        require!(!self.redemption_payouts.contains_key(&payout_tx_hash), "Payout already used");
        let mut record = self.redemptions.get(&request_id).cloned().expect("Unknown redemption request");
        require!(record.status == "PENDING_PAYOUT", "Redemption is not pending");
        self.token.internal_withdraw(&env::current_account_id(), record.share_amount.0);
        record.status = "SETTLED".to_string();
        record.payout_tx_hash = Some(payout_tx_hash.clone());
        record.settled_at = Some(env::block_timestamp());
        self.redemption_payouts.insert(payout_tx_hash.clone(), request_id.clone());
        self.redemptions.insert(request_id.clone(), record.clone());
        Self::emit_event("redemption_settled", &format!(
            r#"{{"fund_id":"{}","request_id":"{}","investor_id":"{}","share_amount":"{}","usdc_amount":"{}","payout_tx_hash":"{}","nav_sequence":{}}}"#,
            self.fund_id, request_id, record.investor_id, record.share_amount.0, record.usdc_amount.0, payout_tx_hash, record.nav_sequence
        ));
        record
    }

    /// Refunds escrowed shares only while no payout has been settled. Intended
    /// for operator-approved failed/expired payout recovery.
    pub fn cancel_redemption(&mut self, request_id: String) -> RedemptionRecord {
        require!(env::predecessor_account_id() == self.settlement_operator, "Settlement operator only");
        let mut record = self.redemptions.get(&request_id).cloned().expect("Unknown redemption request");
        require!(record.status == "PENDING_PAYOUT", "Redemption is not pending");
        self.token.internal_transfer(&env::current_account_id(), &record.investor_id, record.share_amount.0, Some("ProofNAV redemption cancelled".to_string()));
        record.status = "CANCELLED_REFUNDED".to_string();
        self.redemptions.insert(request_id, record.clone());
        Self::emit_event("redemption_cancelled", &format!(
            r#"{{"fund_id":"{}","request_id":"{}","investor_id":"{}","share_amount":"{}"}}"#,
            self.fund_id, record.request_id, record.investor_id, record.share_amount.0
        ));
        record
    }

    pub fn get_redemption(&self, request_id: String) -> Option<RedemptionRecord> {
        self.redemptions.get(&request_id).cloned()
    }

    pub fn get_redemption_count(&self) -> u64 { self.redemptions.len() as u64 }
    pub fn get_treasury_account(&self) -> AccountId { self.treasury_account.clone() }
    pub fn get_usdc_token_account(&self) -> AccountId { self.usdc_token_account.clone() }
    pub fn get_settlement_operator(&self) -> AccountId { self.settlement_operator.clone() }

    pub fn update_settlement_operator(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.settlement_operator = account_id;
    }

    pub fn update_treasury_account(&mut self, account_id: AccountId) {
        self.assert_owner();
        self.treasury_account = account_id;
    }

    pub fn get_latest_nav(&self) -> Option<NavRecord> {
        self.latest_nav.clone()
    }

    pub fn get_nav_by_sequence(&self, sequence: u64) -> Option<NavRecord> {
        self.nav_history.iter().find(|r| r.sequence == sequence).cloned()
    }

    pub fn get_nav_history(&self, from_sequence: Option<u64>, limit: Option<u64>) -> Vec<NavRecord> {
        let from = from_sequence.unwrap_or(1);
        let take = limit.unwrap_or(50).min(100) as usize;
        self.nav_history.iter()
            .filter(|r| r.sequence >= from)
            .take(take)
            .cloned()
            .collect()
    }

    pub fn get_fund_id(&self) -> String { self.fund_id.clone() }
    pub fn get_publisher_id(&self) -> AccountId { self.publisher_id.clone() }
    pub fn get_approver_id(&self) -> AccountId { self.approver_id.clone() }
    pub fn is_publication_paused(&self) -> bool { self.publication_paused }

    pub fn pause_publication(&mut self, paused: bool) {
        self.assert_owner();
        self.publication_paused = paused;
    }

    pub fn update_publisher(&mut self, publisher_id: AccountId) {
        self.assert_owner();
        self.publisher_id = publisher_id;
    }

    pub fn update_approver(&mut self, approver_id: AccountId) {
        self.assert_owner();
        self.approver_id = approver_id;
    }

    fn assert_owner(&self) { require!(env::predecessor_account_id() == self.owner_id, "Owner only"); }
    fn assert_publisher(&self) { require!(env::predecessor_account_id() == self.publisher_id, "Publisher only"); }
    fn assert_approver(&self) { require!(env::predecessor_account_id() == self.approver_id, "Approver only"); }

    fn assert_hash(value: &str, label: &str) {
        require!(value.len() == 64, format!("{} must be 32-byte hex", label));
        require!(value.bytes().all(|b| b.is_ascii_hexdigit()), format!("{} must be hexadecimal", label));
    }

    fn emit_event(event: &str, data: &str) {
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"proofnav\",\"version\":\"1.0.0\",\"event\":\"{}\",\"data\":[{}]}}",
            event, data
        ));
    }
}

#[near]
impl FungibleTokenCore for Contract {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self, receiver_id: AccountId, amount: U128,
        memo: Option<String>, msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 { self.token.ft_total_supply() }
    fn ft_balance_of(&self, account_id: AccountId) -> U128 { self.token.ft_balance_of(account_id) }
}

#[near]
impl FungibleTokenResolver for Contract {
    #[private]
    fn ft_resolve_transfer(&mut self, sender_id: AccountId, receiver_id: AccountId, amount: U128) -> U128 {
        self.token.ft_resolve_transfer(sender_id, receiver_id, amount)
    }
}

#[near]
impl StorageManagement for Contract {
    #[payable]
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<near_sdk::NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for Contract {
    fn ft_metadata(&self) -> FungibleTokenMetadata { self.metadata.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env, NearToken};

    fn account(s: &str) -> AccountId { s.parse().unwrap() }

    fn context(predecessor: &str) {
        let mut builder = VMContextBuilder::new();
        builder.predecessor_account_id(account(predecessor));
        builder.attached_deposit(NearToken::from_yoctonear(0));
        testing_env!(builder.build());
    }

    fn metadata() -> FungibleTokenMetadata {
        FungibleTokenMetadata {
            spec: FT_METADATA_SPEC.to_string(),
            name: "ProofNAV Fund Share".to_string(),
            symbol: "PNAV".to_string(),
            icon: None,
            reference: None,
            reference_hash: None,
            decimals: 8,
        }
    }

    fn contract() -> Contract {
        context("owner.testnet");
        Contract::new(
            account("owner.testnet"), account("publisher.testnet"),
            account("approver.testnet"), "demo-fund".to_string(),
            account("treasury.testnet"), account("usdc.testnet"), account("settler.testnet"),
            account("treasury.testnet"), U128(100_000_000_000_000),
            metadata(),
        )
    }

    #[test]
    fn initializes_token_supply() {
        let c = contract();
        assert_eq!(c.ft_total_supply(), U128(100_000_000_000_000));
        assert_eq!(c.ft_balance_of(account("treasury.testnet")), U128(100_000_000_000_000));
    }

    #[test]
    fn settles_unique_subscription_at_latest_nav() {
        let mut c = contract();
        let hash = "b".repeat(64);
        context("approver.testnet");
        c.approve_snapshot(1, hash.clone());
        context("publisher.testnet");
        // $10,000,000 NAV / 1,000,000 shares = $10/share.
        c.publish_nav(1, 1, U128(1_000_000_000), U128(1_000_000_000),
            U128(100_000_000_000_000), "USD".to_string(), "a".repeat(64), hash,
            "MATCHED".to_string(), "v1".to_string());
        context("settler.testnet");
        let record = c.settle_subscription(account("investor.testnet"), U128(1_000_000), "c".repeat(64));
        assert_eq!(record.share_amount, U128(10_000_000)); // 1 USDC at $10/share = 0.1 PNAV
        assert_eq!(c.ft_balance_of(account("investor.testnet")), U128(10_000_000));
        assert_eq!(c.get_subscription_count(), 1);
    }

    #[test]
    #[should_panic(expected = "Payment already settled")]
    fn rejects_duplicate_payment_hash() {
        let mut c = contract();
        let hash = "b".repeat(64);
        context("approver.testnet"); c.approve_snapshot(1, hash.clone());
        context("publisher.testnet"); c.publish_nav(1, 1, U128(1_000_000_000), U128(1_000_000_000),
            U128(100_000_000_000_000), "USD".to_string(), "a".repeat(64), hash,
            "MATCHED".to_string(), "v1".to_string());
        context("settler.testnet");
        c.settle_subscription(account("investor.testnet"), U128(1_000_000), "c".repeat(64));
        c.settle_subscription(account("investor.testnet"), U128(1_000_000), "c".repeat(64));
    }

    #[test]
    #[should_panic(expected = "Snapshot hash has not been approved")]
    fn cannot_publish_without_approval() {
        let mut c = contract();
        context("publisher.testnet");
        c.publish_nav(1, 1, U128(1_000_000), U128(1_000_000), U128(100_000_000_000_000),
            "USD".to_string(), "a".repeat(64), "b".repeat(64), "MATCHED".to_string(), "v1".to_string());
    }

    #[test]
    fn requires_approval_then_appends_nav() {
        let mut c = contract();
        let hash = "b".repeat(64);
        context("approver.testnet");
        c.approve_snapshot(1, hash.clone());
        context("publisher.testnet");
        c.publish_nav(1, 1, U128(1_000_000), U128(1_000_000), U128(100_000_000_000_000),
            "USD".to_string(), "a".repeat(64), hash, "MATCHED".to_string(), "v1".to_string());
        assert_eq!(c.get_latest_nav().unwrap().sequence, 1);
    }

    #[test]
    #[should_panic(expected = "Share supply mismatch")]
    fn rejects_supply_mismatch() {
        let mut c = contract();
        let hash = "b".repeat(64);
        context("approver.testnet");
        c.approve_snapshot(1, hash.clone());
        context("publisher.testnet");
        c.publish_nav(1, 1, U128(1_000_000), U128(100_000_000), U128(1),
            "USD".to_string(), "a".repeat(64), hash, "MATCHED".to_string(), "v1".to_string());
    }

    #[test]
    #[should_panic(expected = "Approver only")]
    fn rejects_approval_from_wrong_account() {
        let mut c = contract();
        context("publisher.testnet");
        c.approve_snapshot(1, "b".repeat(64));
    }

    #[test]
    #[should_panic(expected = "Snapshot is not fully reconciled")]
    fn rejects_unreconciled_snapshot() {
        let mut c = contract();
        let hash = "b".repeat(64);
        context("approver.testnet");
        c.approve_snapshot(1, hash.clone());
        context("publisher.testnet");
        c.publish_nav(1, 1, U128(1_000_000), U128(1_000_000), U128(100_000_000_000_000),
            "USD".to_string(), "a".repeat(64), hash, "INCOMPLETE".to_string(), "v1".to_string());
    }

    #[test]
    #[should_panic(expected = "NAV per share mismatch")]
    fn rejects_inconsistent_nav_per_share() {
        let mut c = contract();
        let hash = "b".repeat(64);
        context("approver.testnet");
        c.approve_snapshot(1, hash.clone());
        context("publisher.testnet");
        c.publish_nav(1, 1, U128(1_000_000), U128(100_000_000), U128(100_000_000_000_000),
            "USD".to_string(), "a".repeat(64), hash, "MATCHED".to_string(), "v1".to_string());
    }

    #[test]
    #[should_panic(expected = "NAV publication is paused")]
    fn owner_can_pause_publication() {
        let mut c = contract();
        context("owner.testnet");
        c.pause_publication(true);
        let hash = "b".repeat(64);
        context("approver.testnet");
        c.approve_snapshot(1, hash.clone());
        context("publisher.testnet");
        c.publish_nav(1, 1, U128(1_000_000), U128(1_000_000), U128(100_000_000_000_000),
            "USD".to_string(), "a".repeat(64), hash, "MATCHED".to_string(), "v1".to_string());
    }

}
