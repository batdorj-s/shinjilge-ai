import { getPool, initDataLake, getColumnProfile } from "../db/data-lake.js";
import { getConnection } from "../db/meta-repository.js";
import { fetchAdAccountId, fetchCampaigns, fetchAdSets, fetchAds, MetaApiError } from "./meta-api.js";

const BRONZE_TABLE_CAMPAIGNS = "meta_bronze_campaigns";
const BRONZE_TABLE_ADSETS = "meta_bronze_adsets";
const BRONZE_TABLE_ADS = "meta_bronze_ads";
const BRONZE_TABLE_INSIGHTS = "meta_bronze_insights";
// Silver/Gold table constants removed — transforms are owned by dbt models:
//   int_meta_ad_performance (silver, ephemeral)
//   meta_campaign_kpi     (gold, table)
//   meta_adset_kpi        (gold, table)

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

  // 4. Insights — DISABLED: meta_bronze_insights deprecated by Meta 2026-06-15
  stats.insights = 0;

  return stats;
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
  const tables: [string, string][] = [
    [BRONZE_TABLE_CAMPAIGNS, "Meta Ads Bronze: Campaign level data. Each row is one ad campaign."],
    [BRONZE_TABLE_ADSETS, "Meta Ads Bronze: Ad set level data. Each row is one ad set within a campaign."],
    [BRONZE_TABLE_ADS, "Meta Ads Bronze: Ad level data. Each row is one creative ad within an ad set."],
    // BRONZE_TABLE_INSIGHTS: removed — insights data deprecated by Meta 2026-06-15, table no longer maintained
  ];
  for (const [table, desc] of tables) {
    await registerTableInCatalog(table, ownerId, desc);
  }
}
