import { db } from "./db";
import { FUND_ID } from "./config";

export function seedDemoFund() {
  if (db.prepare("SELECT id FROM funds WHERE id=?").get(FUND_ID)) return;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO funds(id,name,currency,created_at) VALUES(?,?,?,?)")
    .run(FUND_ID, "ProofNAV Demonstration Fund", "USD", now);
  const asset = db.prepare(`INSERT INTO assets(id,fund_id,symbol,asset_type,valuation_method,max_price_age_seconds) VALUES(?,?,?,?,?,?)`);
  asset.run("bond-usd", FUND_ID, "TBOND", "BOND", "QUANTITY_TIMES_PRICE_PLUS_ACCRUAL", 172800);
  asset.run("usdc", FUND_ID, "USDC", "CASH", "QUANTITY_TIMES_PRICE", 86400);
  asset.run("eth", FUND_ID, "ETH", "CRYPTO", "QUANTITY_TIMES_PRICE", 3600);
  const pos = db.prepare(`INSERT INTO positions(id,fund_id,asset_id,quantity,accrued_income,as_of) VALUES(?,?,?,?,?,?)`);
  pos.run("pos-bond", FUND_ID, "bond-usd", "4000000", "1250000", now);
  pos.run("pos-usdc", FUND_ID, "usdc", "3000000", "0", now);
  pos.run("pos-eth", FUND_ID, "eth", "1000", "0", now);
  const price = db.prepare(`INSERT INTO price_observations(id,asset_id,price,currency,source,observed_at,approved) VALUES(?,?,?,?,?,?,1)`);
  price.run("price-bond", "bond-usd", "1", "USD", "DEMO_ADMINISTRATOR", now);
  price.run("price-usdc", "usdc", "1", "USD", "DEMO_CUSTODIAN", now);
  price.run("price-eth", "eth", "2000", "USD", "DEMO_PRICE_FEED", now);
  db.prepare("INSERT INTO liabilities(id,fund_id,description,amount,as_of) VALUES(?,?,?,?,?)")
    .run("liab-fees", FUND_ID, "Accrued fund expenses", "250000", now);
  const custody = db.prepare(`INSERT INTO custody_balances(id,fund_id,asset_id,quantity,source,as_of) VALUES(?,?,?,?,?,?)`);
  custody.run("custody-bond", FUND_ID, "bond-usd", "4000000", "DEMO_CUSTODIAN", now);
  custody.run("custody-usdc", FUND_ID, "usdc", "3000000", "DEMO_CUSTODIAN", now);
  custody.run("custody-eth", FUND_ID, "eth", "1000", "DEMO_CUSTODIAN", now);
  db.prepare("INSERT INTO fund_controls(fund_id,eligible_shares,onchain_total_supply) VALUES(?,?,?)")
    .run(FUND_ID, "1000000", "1000000");
}

if (require.main === module) {
  seedDemoFund();
  console.log("Seeded demo fund.");
}
