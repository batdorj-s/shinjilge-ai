import { getPool, initDataLake, isPgAvailable, getColumnSamples, getColumnProfile } from "../db/data-lake.js";
import { getConnection } from "../db/meta-repository.js";
import { fetchAdAccountId, fetchCampaigns, fetchAdSets, fetchAds, fetchAdInsights, MetaApiError } from "./meta-api.js";

const BRONZE_TABLE_CAMPAIGNS = "meta_bronze_campaigns";
const BRONZE_TABLE_ADSETS = "meta_bronze_adsets";
const BRONZE_TABLE_ADS = "meta_bronze_ads";
const BRONZE_TABLE_INSIGHTS = "meta_bronze_insights";
const SILVER_TABLE_AD_PERFORMANCE = "meta_silver_ad_performance";
const GOLD_TABLE_CAMPAIGN_KPI = "meta_gold_campaign_kpi";

function ensureDateStr(date: Date = new Date()): string {
  return date.toISOString().split("T")[0];
}

function ensureBronzeTables(): Promise<void> {
  return initDataLake();
}

export async function syncAdsData(
  ownerId: string,
  sinceDays?: number,
): Promise<{ campaigns: number; adsets: number; ads: number; insights: number }> {
  const connection = await getConnection(ownerId, "facebook");
  if (!connection) {
    throw new Error(`No Facebook connection found for user ${ownerId}`);
  }

  const accessToken = connection.access_token;
  const pool = getPool();

  // Ensure bronze tables exist
  await ensureBronzeTables();

  // Get ad account ID
  let adAccountId: string;
  try {
    adAccountId = await fetchAdAccountId(accessToken);
  } catch (err) {
    if (err instanceof MetaApiError && err.message.includes("Token expired")) {
      throw new Error("Meta token expired. Please reconnect your Meta account.");
    }
    throw err;
  }

  const since = sinceDays
    ? ensureDateStr(new Date(Date.now() - sinceDays * 86400000))
    : undefined;

  const stats = { campaigns: 0, adsets: 0, ads: 0, insights: 0 };

  // 1. Fetch and store campaigns
  const campaigns = await fetchCampaigns(adAccountId, accessToken);
  if (campaigns.length > 0) {
    await pool.query(`DROP TABLE IF EXISTS "${BRONZE_TABLE_CAMPAIGNS}" CASCADE`);
    await pool.query(`
      CREATE TABLE "${BRONZE_TABLE_CAMPAIGNS}" (
        id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT,
        objective TEXT,
        daily_budget NUMERIC,
        lifetime_budget NUMERIC,
        created_time TIMESTAMPTZ,
        fetched_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    for (const c of campaigns) {
      await pool.query(
        `INSERT INTO "${BRONZE_TABLE_CAMPAIGNS}" (id, name, status, objective, daily_budget, lifetime_budget, created_time)
         VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::timestamptz)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status, fetched_at=NOW()`,
        [c.id, c.name, c.status, c.objective || null, c.daily_budget || null, c.lifetime_budget || null, c.created_time || null],
      );
    }
    stats.campaigns = campaigns.length;
    console.log(`[Meta Ads] Stored ${campaigns.length} campaigns`);
  }

  // 2. Fetch and store ad sets
  const adsets = await fetchAdSets(adAccountId, accessToken);
  if (adsets.length > 0) {
    await pool.query(`DROP TABLE IF EXISTS "${BRONZE_TABLE_ADSETS}" CASCADE`);
    await pool.query(`
      CREATE TABLE "${BRONZE_TABLE_ADSETS}" (
        id TEXT PRIMARY KEY,
        name TEXT,
        campaign_id TEXT,
        status TEXT,
        daily_budget NUMERIC,
        lifetime_budget NUMERIC,
        start_time TIMESTAMPTZ,
        end_time TIMESTAMPTZ,
        created_time TIMESTAMPTZ,
        fetched_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    for (const a of adsets) {
      await pool.query(
        `INSERT INTO "${BRONZE_TABLE_ADSETS}" (id, name, campaign_id, status, daily_budget, lifetime_budget, start_time, end_time, created_time)
         VALUES ($1, $2, $3, $4, $5::numeric, $6::numeric, $7::timestamptz, $8::timestamptz, $9::timestamptz)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status, fetched_at=NOW()`,
        [a.id, a.name, a.campaign_id, a.status, a.daily_budget || null, a.lifetime_budget || null, a.start_time || null, a.end_time || null, a.created_time || null],
      );
    }
    stats.adsets = adsets.length;
    console.log(`[Meta Ads] Stored ${adsets.length} ad sets`);
  }

  // 3. Fetch and store ads
  const ads = await fetchAds(adAccountId, accessToken);
  if (ads.length > 0) {
    await pool.query(`DROP TABLE IF EXISTS "${BRONZE_TABLE_ADS}" CASCADE`);
    await pool.query(`
      CREATE TABLE "${BRONZE_TABLE_ADS}" (
        id TEXT PRIMARY KEY,
        name TEXT,
        adset_id TEXT,
        campaign_id TEXT,
        status TEXT,
        creative_id TEXT,
        created_time TIMESTAMPTZ,
        fetched_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    for (const ad of ads) {
      await pool.query(
        `INSERT INTO "${BRONZE_TABLE_ADS}" (id, name, adset_id, campaign_id, status, creative_id, created_time)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz)
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, status=EXCLUDED.status, fetched_at=NOW()`,
        [ad.id, ad.name, ad.adset_id, ad.campaign_id, ad.status, ad.creative?.id || null, ad.created_time || null],
      );
    }
    stats.ads = ads.length;
    console.log(`[Meta Ads] Stored ${ads.length} ads`);
  }

  // 4. Fetch and store insights
  const insights = await fetchAdInsights(adAccountId, accessToken, since);
  if (insights.length > 0) {
    await pool.query(`DROP TABLE IF EXISTS "${BRONZE_TABLE_INSIGHTS}" CASCADE`);
    await pool.query(`
      CREATE TABLE "${BRONZE_TABLE_INSIGHTS}" (
        id SERIAL PRIMARY KEY,
        campaign_id TEXT,
        campaign_name TEXT,
        adset_id TEXT,
        adset_name TEXT,
        ad_id TEXT,
        ad_name TEXT,
        date_start DATE,
        date_stop DATE,
        impressions BIGINT,
        clicks BIGINT,
        spend NUMERIC,
        ctr NUMERIC,
        cpc NUMERIC,
        cpm NUMERIC,
        reach BIGINT,
        frequency NUMERIC,
        actions JSONB,
        cost_per_action_type JSONB,
        action_values JSONB,
        purchase_roas JSONB,
        fetched_at TIMESTAMPTZ DEFAULT NOW(),
        owner_id TEXT
      )
    `);
    for (const ins of insights) {
      await pool.query(
        `INSERT INTO "${BRONZE_TABLE_INSIGHTS}" (campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name, date_start, date_stop, impressions, clicks, spend, ctr, cpc, cpm, reach, frequency, actions, cost_per_action_type, action_values, purchase_roas, owner_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::date, $9::bigint, $10::bigint, $11::numeric, $12::numeric, $13::numeric, $14::numeric, $15::bigint, $16::numeric, $17::jsonb, $18::jsonb, $19::jsonb, $20::jsonb, $21)`,
        [ins.campaign_id, ins.campaign_name, ins.adset_id, ins.adset_name, ins.ad_id, ins.ad_name, ins.date_start, ins.date_stop,
         ins.impressions || "0", ins.clicks || "0", ins.spend || "0", ins.ctr || "0", ins.cpc || "0", ins.cpm || "0",
         ins.reach || "0", ins.frequency || "0",
         JSON.stringify(ins.actions || []), JSON.stringify(ins.cost_per_action_type || []),
         JSON.stringify(ins.action_values || []), JSON.stringify(ins.purchase_roas || []),
         ownerId],
      );
    }
    stats.insights = insights.length;
    console.log(`[Meta Ads] Stored ${insights.length} insights`);
  }

  return stats;
}

export async function buildSilverLayer(ownerId: string): Promise<void> {
  const pool = getPool();
  if (!isPgAvailable()) return;

  await pool.query(`DROP TABLE IF EXISTS "${SILVER_TABLE_AD_PERFORMANCE}" CASCADE`);
  await pool.query(`
    CREATE TABLE "${SILVER_TABLE_AD_PERFORMANCE}" AS
    SELECT
      i.id AS insight_id,
      i.campaign_id,
      i.campaign_name,
      i.adset_id,
      i.adset_name,
      i.ad_id,
      i.ad_name,
      i.date_start,
      i.date_stop,
      i.impressions,
      i.clicks,
      i.spend,
      i.ctr,
      i.cpc,
      i.cpm,
      i.reach,
      i.frequency,
      COALESCE(c.status, 'UNKNOWN') AS campaign_status,
      COALESCE(a.status, 'UNKNOWN') AS ad_status,
      c.objective,
      i.owner_id,
      COALESCE((SELECT (elem->>'value')::numeric FROM jsonb_array_elements(i.actions) AS elem WHERE elem->>'action_type' = 'purchase' LIMIT 1), 0) AS conversions,
      COALESCE((SELECT (elem->>'value')::numeric FROM jsonb_array_elements(i.actions) AS elem WHERE elem->>'action_type' = 'lead' LIMIT 1), 0) AS leads,
      COALESCE((SELECT (elem->>'value')::numeric FROM jsonb_array_elements(i.actions) AS elem WHERE elem->>'action_type' = 'add_to_cart' LIMIT 1), 0) AS add_to_cart,
      COALESCE((SELECT (elem->>'value')::numeric FROM jsonb_array_elements(i.actions) AS elem WHERE elem->>'action_type' = 'view_content' LIMIT 1), 0) AS view_content,
      COALESCE((SELECT (elem->>'value')::numeric FROM jsonb_array_elements(i.cost_per_action_type) AS elem WHERE elem->>'action_type' = 'purchase' LIMIT 1), 0) AS cost_per_conversion,
      COALESCE((SELECT (elem->>'value')::numeric FROM jsonb_array_elements(i.cost_per_action_type) AS elem WHERE elem->>'action_type' = 'lead' LIMIT 1), 0) AS cost_per_lead,
      COALESCE((SELECT (elem->>'value')::numeric FROM jsonb_array_elements(i.purchase_roas) AS elem WHERE elem->>'action_type' = 'purchase' LIMIT 1), 0) AS purchase_roas,
      COALESCE((SELECT (elem->>'value')::numeric FROM jsonb_array_elements(i.action_values) AS elem WHERE elem->>'action_type' = 'purchase' LIMIT 1), 0) AS conversion_value
    FROM "${BRONZE_TABLE_INSIGHTS}" i
    LEFT JOIN "${BRONZE_TABLE_CAMPAIGNS}" c ON i.campaign_id = c.id
    LEFT JOIN "${BRONZE_TABLE_ADS}" a ON i.ad_id = a.id
    WHERE i.owner_id = $1
  `, [ownerId]);

  console.log(`[Meta Ads] Silver layer built: ${SILVER_TABLE_AD_PERFORMANCE}`);
}

export async function buildGoldLayer(ownerId: string): Promise<void> {
  const pool = getPool();
  if (!isPgAvailable()) return;

  await pool.query(`DROP TABLE IF EXISTS "${GOLD_TABLE_CAMPAIGN_KPI}" CASCADE`);
  await pool.query(`
    CREATE TABLE "${GOLD_TABLE_CAMPAIGN_KPI}" AS
    SELECT
      campaign_id,
      campaign_name,
      objective,
      MIN(date_start) AS first_impression_date,
      MAX(date_stop) AS last_impression_date,
      SUM(impressions) AS total_impressions,
      SUM(clicks) AS total_clicks,
      SUM(spend) AS total_spend,
      CASE WHEN SUM(clicks) > 0 THEN ROUND(SUM(clicks)::numeric / NULLIF(SUM(impressions), 0) * 100, 2) ELSE 0 END AS avg_ctr,
      CASE WHEN SUM(clicks) > 0 THEN ROUND(SUM(spend) / NULLIF(SUM(clicks), 0), 2) ELSE 0 END AS avg_cpc,
      CASE WHEN SUM(impressions) > 0 THEN ROUND(SUM(spend) / NULLIF(SUM(impressions), 0) * 1000, 2) ELSE 0 END AS avg_cpm,
      SUM(reach) AS total_reach,
      ROUND(AVG(frequency), 2) AS avg_frequency,
      COUNT(DISTINCT ad_id) AS unique_ads,
      SUM(conversions) AS total_conversions,
      SUM(leads) AS total_leads,
      CASE WHEN SUM(conversions) > 0 THEN ROUND(SUM(spend) / NULLIF(SUM(conversions), 0), 2) ELSE 0 END AS avg_cost_per_conversion,
      SUM(conversion_value) AS total_conversion_value,
      CASE WHEN SUM(spend) > 0 THEN ROUND(SUM(conversion_value) / NULLIF(SUM(spend), 0), 2) ELSE 0 END AS avg_roas,
      owner_id
    FROM "${SILVER_TABLE_AD_PERFORMANCE}"
    WHERE owner_id = $1
    GROUP BY campaign_id, campaign_name, objective, owner_id
  `, [ownerId]);

  console.log(`[Meta Ads] Gold layer built: ${GOLD_TABLE_CAMPAIGN_KPI}`);
}

async function registerTableInCatalog(
  tableName: string,
  ownerId: string,
  description: string,
): Promise<void> {
  const pool = getPool();
  try {
    const columnsResult = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
      [tableName],
    );
    const columns = columnsResult.rows.map((r: any) => r.column_name);
    const columnsInfo = JSON.stringify(columns);

    const ownerField = ownerId === "system" ? null : ownerId;
    const visibility = ownerId === "system" ? "shared" : "private";

    await pool.query(
      `INSERT INTO data_lake_catalog (table_name, created_by, owner_id, visibility, columns_info, description)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (table_name) DO UPDATE SET
         columns_info = EXCLUDED.columns_info,
         description = EXCLUDED.description,
         column_profiles = '{}',
         created_at = NOW()`,
      [tableName, "meta_sync", ownerField, visibility, columnsInfo, description],
    );

    // Profile columns
    const profile = await getColumnProfile(tableName, columns);
    await pool.query(
      `UPDATE data_lake_catalog SET column_profiles = $1 WHERE table_name = $2`,
      [JSON.stringify(profile), tableName],
    );
  } catch (err) {
    console.warn(`[Meta Ads] Failed to register ${tableName} in catalog:`, (err as Error).message);
  }
}

export async function registerMetaTablesInCatalog(ownerId: string): Promise<void> {
  await registerTableInCatalog(
    SILVER_TABLE_AD_PERFORMANCE,
    ownerId,
    "Meta Ads Silver: Ad-level performance with campaign/ad status enrichment. One row per ad per day.",
  );
  await registerTableInCatalog(
    GOLD_TABLE_CAMPAIGN_KPI,
    ownerId,
    "Meta Ads Gold: Campaign-level aggregated KPIs (impressions, clicks, spend, CTR, CPC, CPM, reach, frequency, conversions, leads, ROAS, conversion value). One row per campaign.",
  );
  await registerTableInCatalog(
    BRONZE_TABLE_INSIGHTS,
    ownerId,
    "Meta Ads Bronze: Raw daily ad insights from Meta Graph API. One row per ad per day.",
  );
}
