import { getPool, getColumnProfile } from "../db/data-lake.js";
import { getConnection } from "../db/meta-repository.js";
import { fetchInstagramMedia } from "./meta-api.js";

const BRONZE_TABLE_MEDIA = "meta_bronze_instagram_media";
const GOLD_TABLE_INSTAGRAM_KPI = "meta_gold_instagram_kpi";

export async function syncInstagramData(ownerId: string): Promise<{ media: number }> {
  const connection = await getConnection(ownerId, "instagram");
  if (!connection || !connection.instagram_id) {
    throw new Error("No Instagram connection found");
  }

  const accessToken = connection.access_token;
  const instagramId = connection.instagram_id;
  const pool = getPool();

  const media = await fetchInstagramMedia(instagramId, accessToken);

  if (media.length > 0) {
    await pool.query(`DROP TABLE IF EXISTS "${BRONZE_TABLE_MEDIA}" CASCADE`);
    await pool.query(`
      CREATE TABLE "${BRONZE_TABLE_MEDIA}" (
        id TEXT PRIMARY KEY,
        caption TEXT,
        media_type TEXT,
        media_url TEXT,
        permalink TEXT,
        like_count BIGINT DEFAULT 0,
        comments_count BIGINT DEFAULT 0,
        impressions BIGINT DEFAULT 0,
        reach BIGINT DEFAULT 0,
        likes BIGINT DEFAULT 0,
        comments BIGINT DEFAULT 0,
        saved BIGINT DEFAULT 0,
        raw_insights JSONB,
        fetched_at TIMESTAMPTZ DEFAULT NOW(),
        owner_id TEXT
      )
    `);

    for (const m of media) {
      const insights = m.insights?.data || [];
      const metrics: Record<string, number> = {};
      for (const metric of insights) {
        const values = metric.values || [];
        if (values.length > 0) {
          metrics[metric.name] = values[0].value || 0;
        }
      }

      await pool.query(
        `INSERT INTO "${BRONZE_TABLE_MEDIA}" (id, caption, media_type, media_url, permalink, like_count, comments_count, impressions, reach, likes, comments, saved, raw_insights, owner_id)
         VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8::bigint, $9::bigint, $10::bigint, $11::bigint, $12::bigint, $13::jsonb, $14)
         ON CONFLICT (id) DO UPDATE SET caption=EXCLUDED.caption, fetched_at=NOW()`,
        [m.id, m.caption || null, m.media_type || null, m.media_url || null, m.permalink || null,
         m.like_count || 0, m.comments_count || 0,
         metrics.impressions || 0, metrics.reach || 0, metrics.likes || 0, metrics.comments || 0, metrics.saved || 0,
         JSON.stringify(insights), ownerId],
      );
    }
  }

  // Build gold layer
  await pool.query(`DROP TABLE IF EXISTS "${GOLD_TABLE_INSTAGRAM_KPI}" CASCADE`);
  await pool.query(`
    CREATE TABLE "${GOLD_TABLE_INSTAGRAM_KPI}" AS
    SELECT
      owner_id,
      COUNT(*) AS total_media,
      SUM(like_count) AS total_likes,
      SUM(comments_count) AS total_comments,
      SUM(impressions) AS total_impressions,
      SUM(reach) AS total_reach,
      SUM(saved) AS total_saved,
      ROUND(AVG(like_count), 1) AS avg_likes_per_post,
      ROUND(AVG(comments_count), 1) AS avg_comments_per_post,
      ROUND(AVG(impressions), 1) AS avg_impressions_per_post,
      ROUND(AVG(reach), 1) AS avg_reach_per_post,
      ROUND(AVG(saved), 1) AS avg_saved_per_post
    FROM "${BRONZE_TABLE_MEDIA}"
    WHERE owner_id = $1
    GROUP BY owner_id
  `, [ownerId]);

  // Register in catalog
  await registerInstagramTables(ownerId);

  console.log(`[Meta Instagram] Synced ${media.length} media items`);
  return { media: media.length };
}

async function registerInstagramTables(ownerId: string): Promise<void> {
  const pool = getPool();
  for (const [table, desc] of [
    [BRONZE_TABLE_MEDIA, "Meta Instagram Bronze: Raw Instagram media items with engagement metrics."],
    [GOLD_TABLE_INSTAGRAM_KPI, "Meta Instagram Gold: Aggregated Instagram KPIs per user."],
  ] as const) {
    try {
      const cols = (await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [table],
      )).rows.map((r: any) => r.column_name);
      await pool.query(
        `INSERT INTO data_lake_catalog (table_name, created_by, owner_id, visibility, columns_info, description)
         VALUES ($1, 'meta_sync', $2, 'private', $3, $4)
         ON CONFLICT (table_name) DO UPDATE SET columns_info=EXCLUDED.columns_info, description=EXCLUDED.description, created_at=NOW()`,
        [table, ownerId, JSON.stringify(cols), desc],
      );
      const profile = await getColumnProfile(table, cols);
      await pool.query(`UPDATE data_lake_catalog SET column_profiles = $1 WHERE table_name = $2`,
        [JSON.stringify(profile), table]);
    } catch (err) {
      console.warn(`[Meta Instagram] Catalog registration failed for ${table}:`, (err as Error).message);
    }
  }
}
