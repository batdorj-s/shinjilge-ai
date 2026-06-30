/**
 * refresh-meta-tokens.ts — Long-lived Meta token refresher
 *
 * LIFECYCLE
 * ──────────
 * In production this runs as a standalone CRON JOB (systemd timer, k8s CronJob, etc.):
 *   npm run refresh-tokens
 *
 * It is NOT embedded in the API server process (no setInterval). Reasons:
 *   1. Server restarts (deploys, crashes) reset in-process intervals, risking missed refreshes
 *   2. If the server is down for extended periods, tokens may expire before the interval fires
 *   3. A dedicated cron job is observable, alertable, and survives deployments
 *
 * SCHEDULE
 * ────────
 * Recommended: run once per day. The job checks for tokens expiring within 7 days.
 *
 * FAILURE BEHAVIOR
 * ────────────────
 * - On refresh failure, the error is logged to console and the DB column `last_error`
 *   is updated on the connection row, so /api/meta/status surfaces it to the UI.
 * - On expiry (no cron or cron missed), the next /api/meta/sync call throws
 *   "Meta token expired. Please reconnect your Meta account." — the user must re-auth.
 * - There is no email/push notification (future improvement).
 */

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

  const { getPool, initDataLake } = await import("../db/data-lake.js");
  await initDataLake();
  const pool = getPool();

  // Ensure error tracking columns exist (safe repeated run)
  await pool.query(`
    ALTER TABLE meta_connections
    ADD COLUMN IF NOT EXISTS last_error TEXT,
    ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ
  `).catch(() => {});

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
        const errMsg = data.error?.message || "unknown error";
        console.error(`[Token Refresh] Failed for ${row.owner_id} (${row.platform}): ${errMsg}`);
        await pool.query(
          `UPDATE meta_connections SET last_error = $1, last_error_at = NOW() WHERE id = $2`,
          [`Refresh failed: ${errMsg}`, row.id],
        );
        errors++;
        continue;
      }

      const newExpiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString();
      await refreshToken(row.owner_id, row.platform, data.access_token, newExpiresAt);
      // Clear any previous error on success
      await pool.query(
        `UPDATE meta_connections SET last_error = NULL, last_error_at = NULL WHERE id = $1`,
        [row.id],
      );
      console.log(`[Token Refresh] Refreshed ${row.platform} token for ${row.owner_id}, expires ${newExpiresAt}`);
      refreshed++;
    } catch (err: any) {
      console.error(`[Token Refresh] Error for ${row.owner_id}:`, err.message);
      try {
        await pool.query(
          `UPDATE meta_connections SET last_error = $1, last_error_at = NOW() WHERE id = $2`,
          [`Refresh error: ${err.message}`, row.id],
        );
      } catch {}
      errors++;
    }
  }

  return { refreshed, errors };
}

// Direct run: npx tsx src/jobs/refresh-meta-tokens.ts
const isDirectRun = process.argv[1]?.includes("refresh-meta-tokens");
if (isDirectRun) {
  const result = await refreshExpiringTokens();
  console.log(`[Token Refresh] Done: ${result.refreshed} refreshed, ${result.errors} errors`);
  process.exit(result.errors > 0 ? 1 : 0);
}
