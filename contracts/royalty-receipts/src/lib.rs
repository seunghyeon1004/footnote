//! Footnote royalty receipts.
//!
//! The settlement agent pays creators with a plain NEAR transfer (which carries no memo), then calls
//! `log_receipt` here with the payout transaction hash. The result is a public, append-only ledger of
//! "answer X paid creator Y this much because of these sources", plus a NEP-297 style event per receipt.
//! Only the account set at `new` (the settlement account) can write. Anyone can read.
use near_sdk::json_types::U128;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, PanicOnDefault};

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Receipt {
    pub id: u64,
    pub payee: AccountId,
    pub answer_id: String,
    pub usd_cents: u64,
    pub yocto_near: U128,
    /// Hash of the NEAR transfer transaction that actually moved the funds.
    pub payout_tx: String,
    /// SHA-256 (hex) of the canonical per-source split, so the off-chain receipt can be verified.
    pub split_hash: String,
    pub timestamp_ns: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Receipts {
    settler: AccountId,
    receipts: Vector<Receipt>,
    total_by_payee: LookupMap<AccountId, u128>,
    total_yocto: u128,
}

#[near]
impl Receipts {
    #[init]
    pub fn new(settler: AccountId) -> Self {
        Self { settler, receipts: Vector::new(b"r"), total_by_payee: LookupMap::new(b"p"), total_yocto: 0 }
    }

    /// Settlement account only. Returns the receipt id.
    pub fn log_receipt(&mut self, payee: AccountId, answer_id: String, usd_cents: u64, yocto_near: U128, payout_tx: String, split_hash: String) -> u64 {
        require!(env::predecessor_account_id() == self.settler, "only the settlement account may log receipts");
        require!(answer_id.len() <= 256 && payout_tx.len() <= 64 && split_hash.len() <= 64, "field too long");
        let id = self.receipts.len() as u64;
        let r = Receipt { id, payee: payee.clone(), answer_id, usd_cents, yocto_near, payout_tx, split_hash, timestamp_ns: env::block_timestamp() };
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"footnote_royalty\",\"version\":\"1.0.0\",\"event\":\"royalty_paid\",\"data\":[{{\"id\":{},\"payee\":\"{}\",\"answer_id\":\"{}\",\"usd_cents\":{},\"yocto_near\":\"{}\",\"payout_tx\":\"{}\"}}]}}",
            r.id, r.payee, r.answer_id, r.usd_cents, r.yocto_near.0, r.payout_tx
        ));
        let prev = self.total_by_payee.get(&payee).copied().unwrap_or(0);
        self.total_by_payee.insert(payee, prev + yocto_near.0);
        self.total_yocto += yocto_near.0;
        self.receipts.push(r);
        id
    }

    pub fn settler(&self) -> AccountId { self.settler.clone() }
    pub fn count(&self) -> u64 { self.receipts.len() as u64 }
    pub fn total_yocto_near(&self) -> U128 { U128(self.total_yocto) }
    pub fn total_for(&self, payee: AccountId) -> U128 { U128(self.total_by_payee.get(&payee).copied().unwrap_or(0)) }
    pub fn get_receipt(&self, id: u64) -> Option<Receipt> { self.receipts.get(id as u32).cloned() }
    pub fn recent(&self, limit: Option<u64>) -> Vec<Receipt> {
        let n = self.receipts.len() as u64;
        let lim = limit.unwrap_or(10).min(50);
        let start = n.saturating_sub(lim);
        (start..n).filter_map(|i| self.receipts.get(i as u32).cloned()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn acct(s: &str) -> AccountId { s.parse().unwrap() }
    fn ctx(pred: &str) { testing_env!(VMContextBuilder::new().predecessor_account_id(acct(pred)).build()); }

    #[test]
    fn settler_logs_and_totals() {
        ctx("settler.testnet");
        let mut c = Receipts::new(acct("settler.testnet"));
        let id = c.log_receipt(acct("alice.testnet"), "ans_1".into(), 25, U128(10), "tx1".into(), "h1".into());
        c.log_receipt(acct("alice.testnet"), "ans_2".into(), 25, U128(5), "tx2".into(), "h2".into());
        assert_eq!(id, 0);
        assert_eq!(c.count(), 2);
        assert_eq!(c.total_for(acct("alice.testnet")).0, 15);
        assert_eq!(c.total_yocto_near().0, 15);
        assert_eq!(c.recent(Some(1))[0].answer_id, "ans_2");
    }

    #[test]
    #[should_panic(expected = "only the settlement account")]
    fn others_cannot_log() {
        ctx("settler.testnet");
        let mut c = Receipts::new(acct("settler.testnet"));
        ctx("mallory.testnet");
        c.log_receipt(acct("alice.testnet"), "a".into(), 1, U128(1), "t".into(), "h".into());
    }
}
