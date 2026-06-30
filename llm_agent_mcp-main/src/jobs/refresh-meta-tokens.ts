import dotenv from "dotenv";
dotenv.config();

import { refreshToken } from "../db/meta-repository.js";

const APP_ID = process.env.META_APP_ID || "";
const APP_SECRET = process.env.META_APP_SECRET || "";

const REFRESH_WINDOW_DAYS = 7;

export async function refreshExpiringTokens(): Promise<{ refreshed: number; errors: number }> {
  if (!APP_ID || !APP_SECRET) {
    console.warn("[Token Refresh] META_APP_ID or META_APP_SECRET not configured");
    return { refreshed: 0, errors: 0 };
  }

  const now = new Date();
  const windowEnd = new Date(now.getTime() + REFRESH_WINDOW_DAYS * 86400000);

  // Get distinct owner_ids who have facebook connections
  // We need to iterate by owner since getAllConnections is scoped to a user.
  // For simplicity, query all connections — but getAllConnections requires ownerId.
  // Instead, use a pool query directly to find all expiring tokens.
  const { getPool, initDataLake } = await import("../db/data-lake.js");
  await initDataLake();
  const pool = getPool();

  const result = await pool.query(
    `SELECT * FROM meta_connections WHERE platform = 'facebook' AND token_expires_at < $1 AND token_expires_at > NOW()`,
    [windowEnd.toISOString()],
  );

  let refreshed = 0;
  let errors = 0;

  for (const row of result.rows as any[]) {
    try {
      const { decryptWithKeyRotation } = await import("../utils/encryption.js");
      const { plaintext: currentToken } = decryptWithKeyRotation(row.encrypted_token);

      const url = new URL("https://graph.facebook.com/v22.0/oauth/access_token");
      url.searchParams.set("grant_type", "fb_exchange_token");
      url.searchParams.set("client_id", APP_ID);
      url.searchParams.set("client_secret", APP_SECRET);
      url.searchParams.set("fb_exchange_token", currentToken);

      const resp = await fetch(url.toString());
      const data = await resp.json() as any;

      if (!data.access_token) {
        console.error(`[Token Refresh] Failed for ${row.owner_id} (${row.platform}):`, data.error?.message || "unknown");
        errors++;
        continue;
      }

      const newExpiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString();
      await refreshToken(row.owner_id, row.platform, data.access_token, newExpiresAt);
      console.log(`[Token Refresh] Refreshed ${row.platform} token for ${row.owner_id}, expires ${newExpiresAt}`);
      refreshed++;
    } catch (err: any) {
      console.error(`[Token Refresh] Error for ${row.owner_id}:`, err.message);
      errors++;
    }
  }

  return { refreshed, errors };
}

// Run directly: npx tsx src/jobs/refresh-meta-tokens.ts
const isDirectRun = process.argv[1]?.includes("refresh-meta-tokens");
if (isDirectRun) {
  const result = await refreshExpiringTokens();
  console.log(`[Token Refresh] Done: ${result.refreshed} refreshed, ${result.errors} errors`);
  process.exit(result.errors > 0 ? 1 : 0);
}
