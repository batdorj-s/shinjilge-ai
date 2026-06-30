import { getPool, initDataLake } from "./src/db/data-lake.js";
await initDataLake();
const pool = getPool();

// Check campaigns
const camps = await pool.query("SELECT id, name, status, objective, daily_budget, lifetime_budget, created_time FROM meta_bronze_campaigns");
console.log("=== Campaigns ===");
for (const c of camps.rows) console.log(c.id, "|", c.name, "|", c.status, "|", c.objective, "| budget:", c.daily_budget || c.lifetime_budget);

// Check adsets
const adsets = await pool.query("SELECT id, name, campaign_id, status FROM meta_bronze_adsets");
console.log("=== Ad Sets ===");
for (const a of adsets.rows) console.log(a.id, "|", a.name, "|", a.campaign_id, "|", a.status);

// Check ads
const ads = await pool.query("SELECT id, name, adset_id, campaign_id, status FROM meta_bronze_ads");
console.log("=== Ads ===");
for (const a of ads.rows) console.log(a.id, "|", a.name, "|", a.adset_id, "|", a.status);

// Check insights
const ins = await pool.query("SELECT id, campaign_id, date_start, date_stop, spend, impressions, clicks FROM meta_bronze_insights LIMIT 5");
console.log("=== Insights ===");
for (const i of ins.rows) console.log(i.id, "|", i.campaign_id, "|", i.date_start, "|", i.date_stop, "| spend:", i.spend);

// Check catalog
const cat = await pool.query("SELECT table_name, columns_info FROM data_lake_catalog WHERE table_name LIKE 'meta_%' ORDER BY table_name");
console.log("=== Catalog ===");
for (const r of cat.rows) console.log(r.table_name, "→ columns:", JSON.parse(r.columns_info||"[]").length);
