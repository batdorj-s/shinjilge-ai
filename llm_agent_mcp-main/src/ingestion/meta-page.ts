import { getPool, getColumnProfile } from "../db/data-lake.js";
import { getConnection } from "../db/meta-repository.js";
import { fetchPagePosts } from "./meta-api.js";

const BRONZE_TABLE_POSTS = "meta_bronze_page_posts";
const GOLD_TABLE_PAGE_ENGAGEMENT = "meta_gold_page_engagement";

export async function syncPageData(ownerId: string): Promise<{ posts: number }> {
  const connection = await getConnection(ownerId, "page");
  if (!connection || !connection.page_id) {
    throw new Error("No Page connection found");
  }

  const accessToken = connection.access_token;
  const pageId = connection.page_id;
  const pool = getPool();

  const posts = await fetchPagePosts(pageId, accessToken);

  if (posts.length > 0) {
    await pool.query(`DROP TABLE IF EXISTS "${BRONZE_TABLE_POSTS}" CASCADE`);
    await pool.query(`
      CREATE TABLE "${BRONZE_TABLE_POSTS}" (
        id TEXT PRIMARY KEY,
        message TEXT,
        created_time TIMESTAMPTZ,
        permalink_url TEXT,
        post_impressions BIGINT,
        post_engaged_users BIGINT,
        post_reactions BIGINT,
        post_comments BIGINT,
        post_shares BIGINT,
        raw_insights JSONB,
        fetched_at TIMESTAMPTZ DEFAULT NOW(),
        owner_id TEXT
      )
    `);

    for (const post of posts) {
      const insights = post.insights?.data || [];
      const metrics: Record<string, any> = {};
      for (const metric of insights) {
        const values = metric.values || [];
        if (values.length > 0) {
          metrics[metric.name] = values[0].value;
        }
      }

      // Sum individual reaction types (split from post_reactions_by_type_total which was deprecated)
      const totalReactions =
        (metrics.post_reactions_like_total || 0) +
        (metrics.post_reactions_love_total || 0) +
        (metrics.post_reactions_wow_total || 0) +
        (metrics.post_reactions_haha_total || 0) +
        (metrics.post_reactions_sorry_total || 0) +
        (metrics.post_reactions_anger_total || 0);

      // post_impressions & post_engaged_users were deprecated 2026-06-15 — default to 0
      await pool.query(
        `INSERT INTO "${BRONZE_TABLE_POSTS}" (id, message, created_time, permalink_url, post_impressions, post_engaged_users, post_reactions, post_comments, post_shares, raw_insights, owner_id)
         VALUES ($1, $2, $3::timestamptz, $4, $5::bigint, $6::bigint, $7::bigint, $8::bigint, $9::bigint, $10::jsonb, $11)
         ON CONFLICT (id) DO UPDATE SET message=EXCLUDED.message, fetched_at=NOW()`,
        [post.id, post.message || null, post.created_time || null, post.permalink_url || null,
         metrics.post_impressions || 0, metrics.post_engaged_users || 0,
         totalReactions, metrics.post_comments || 0, metrics.post_shares || 0,
         JSON.stringify(insights), ownerId],
      );
    }
  }

  // Build gold layer
  await pool.query(`DROP TABLE IF EXISTS "${GOLD_TABLE_PAGE_ENGAGEMENT}" CASCADE`);
  await pool.query(`
    CREATE TABLE "${GOLD_TABLE_PAGE_ENGAGEMENT}" AS
    SELECT
      owner_id,
      COUNT(*) AS total_posts,
      SUM(post_impressions) AS total_impressions,
      SUM(post_engaged_users) AS total_engaged_users,
      SUM(post_reactions) AS total_reactions,
      SUM(post_comments) AS total_comments,
      SUM(post_shares) AS total_shares,
      ROUND(AVG(post_impressions)) AS avg_impressions_per_post,
      ROUND(AVG(post_engaged_users)) AS avg_engagement_per_post,
      MIN(created_time) AS first_post_date,
      MAX(created_time) AS last_post_date
    FROM "${BRONZE_TABLE_POSTS}"
    WHERE owner_id = $1
    GROUP BY owner_id
  `, [ownerId]);

  // Register in catalog
  await registerPageTables(ownerId);

  console.log(`[Meta Page] Synced ${posts.length} posts`);
  return { posts: posts.length };
}

async function registerPageTables(ownerId: string): Promise<void> {
  const pool = getPool();
  for (const [table, desc] of [
    [BRONZE_TABLE_POSTS, "Meta Page Bronze: Raw Facebook page posts with engagement metrics."],
    [GOLD_TABLE_PAGE_ENGAGEMENT, "Meta Page Gold: Aggregated page engagement KPIs."],
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
      console.warn(`[Meta Page] Catalog registration failed for ${table}:`, (err as Error).message);
    }
  }
}
