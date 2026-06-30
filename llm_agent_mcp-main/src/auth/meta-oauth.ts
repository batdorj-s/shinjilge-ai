import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { verifyBearerHeader } from "../auth.js";
import { saveConnection, type MetaConnection } from "../db/meta-repository.js";

// In-memory nonce store for OAuth CSRF protection
// Key: nonce, Value: { userId, role, expiresAt }
const oauthNonces = new Map<string, { userId: string; role: string; expiresAt: number }>();

function generateNonce(userId: string, role: string): string {
  const nonce = crypto.randomBytes(32).toString("hex");
  oauthNonces.set(nonce, { userId, role, expiresAt: Date.now() + 600_000 }); // 10 min expiry
  return nonce;
}

function consumeNonce(nonce: string): { userId: string; role: string } | null {
  const entry = oauthNonces.get(nonce);
  if (!entry) return null;
  oauthNonces.delete(nonce);
  if (Date.now() > entry.expiresAt) return null;
  return { userId: entry.userId, role: entry.role };
}

// Periodic cleanup of expired nonces (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of oauthNonces) {
    if (now > val.expiresAt) oauthNonces.delete(key);
  }
}, 300_000);

const router = Router();

const META_APP_ID = process.env.META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";
const META_REDIRECT_URI = process.env.META_REDIRECT_URI || "http://localhost:3001/api/meta/callback";

const REQUIRED_SCOPES = [
  "ads_read",
  "ads_management",
  "pages_read_engagement",
  "instagram_basic",
  "instagram_content_publish",
  "pages_show_list",
  "business_management",
].join(",");

// GET /api/meta/auth — redirect user to Meta OAuth dialog
router.get("/api/meta/auth", (req: Request, res: Response) => {
  const auth = verifyBearerHeader(req.headers.authorization);
  if (!auth.success || !auth.payload) {
    return res.status(401).json({ error: auth.error });
  }

  if (!META_APP_ID) {
    return res.status(500).json({ error: "META_APP_ID not configured" });
  }

  // Generate CSRF nonce — server-validated, single-use, 10min expiry
  const nonce = generateNonce(auth.payload.userId, auth.payload.role);
  const state = Buffer.from(JSON.stringify({ nonce })).toString("base64url");

  const authUrl = new URL("https://www.facebook.com/v22.0/dialog/oauth");
  authUrl.searchParams.set("client_id", META_APP_ID);
  authUrl.searchParams.set("redirect_uri", META_REDIRECT_URI);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("scope", REQUIRED_SCOPES);
  authUrl.searchParams.set("response_type", "code");

  res.json({ redirectUrl: authUrl.toString() });
});

// GET /api/meta/callback — Meta redirects here after user authorization
router.get("/api/meta/callback", async (req: Request, res: Response) => {
  const oauthError = req.query.error as string | undefined;
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;

  if (oauthError) {
    console.error("[Meta OAuth] Error from Meta:", oauthError);
    return res.redirect(`${process.env.CORS_ORIGIN || "http://localhost:3000"}/settings?meta=error&reason=${oauthError}`);
  }

  if (!code || !state) {
    return res.redirect(`${process.env.CORS_ORIGIN || "http://localhost:3000"}/settings?meta=error&reason=missing_params`);
  }

  let userId: string;
  try {
    const statePayload = JSON.parse(Buffer.from(state, "base64url").toString());
    const nonceData = consumeNonce(statePayload.nonce);
    if (!nonceData) {
      return res.redirect(`${process.env.CORS_ORIGIN || "http://localhost:3000"}/settings?meta=error&reason=invalid_or_expired_state`);
    }
    userId = nonceData.userId;
  } catch {
    return res.redirect(`${process.env.CORS_ORIGIN || "http://localhost:3000"}/settings?meta=error&reason=invalid_state`);
  }

  try {
    // Step 1: Exchange code for short-lived access token
    const tokenUrl = new URL("https://graph.facebook.com/v22.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id", META_APP_ID);
    tokenUrl.searchParams.set("client_secret", META_APP_SECRET);
    tokenUrl.searchParams.set("redirect_uri", META_REDIRECT_URI);
    tokenUrl.searchParams.set("code", code as string);

    const tokenResponse = await fetch(tokenUrl.toString());
    const tokenData = await tokenResponse.json() as any;

    if (!tokenData.access_token) {
      console.error("[Meta OAuth] Token exchange failed:", tokenData);
      return res.redirect(`${process.env.CORS_ORIGIN || "http://localhost:3000"}/settings?meta=error&reason=token_exchange_failed`);
    }

    const shortLivedToken = tokenData.access_token;

    // Step 2: Exchange short-lived token for long-lived token (60 days)
    const longLivedUrl = new URL("https://graph.facebook.com/v22.0/oauth/access_token");
    longLivedUrl.searchParams.set("grant_type", "fb_exchange_token");
    longLivedUrl.searchParams.set("client_id", META_APP_ID);
    longLivedUrl.searchParams.set("client_secret", META_APP_SECRET);
    longLivedUrl.searchParams.set("fb_exchange_token", shortLivedToken);

    const longLivedResponse = await fetch(longLivedUrl.toString());
    const longLivedData = await longLivedResponse.json() as any;

    if (!longLivedData.access_token) {
      console.error("[Meta OAuth] Long-lived token exchange failed:", longLivedData);
      return res.redirect(`${process.env.CORS_ORIGIN || "http://localhost:3000"}/settings?meta=error&reason=long_lived_failed`);
    }

    const accessToken = longLivedData.access_token;
    const expiresIn = longLivedData.expires_in || 5184000; // default 60 days in seconds
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Step 3: Get Meta user info (to get page IDs, etc.)
    const meUrl = new URL("https://graph.facebook.com/v22.0/me");
    meUrl.searchParams.set("access_token", accessToken);
    meUrl.searchParams.set("fields", "id,name,accounts{id,name,access_token,instagram_business_account{id,username}}");

    const meResponse = await fetch(meUrl.toString());
    const meData = await meResponse.json() as any;

    const metaUserId = meData.id;

    // Step 4: Store connections
    // Store Facebook Ads connection
    await saveConnection(userId, "facebook", accessToken, expiresAt, REQUIRED_SCOPES.split(","), metaUserId);

    // Store Page connections if available
    const accounts = meData.accounts?.data || [];
    for (const page of accounts) {
      const pageScopes = ["pages_read_engagement", "pages_show_list"];
      await saveConnection(userId, "page", page.access_token || accessToken, expiresAt, pageScopes, metaUserId, page.id);

      // Store Instagram connection if linked to page
      if (page.instagram_business_account?.id) {
        const igScopes = ["instagram_basic", "instagram_content_publish"];
        await saveConnection(userId, "instagram", accessToken, expiresAt, igScopes, metaUserId, page.id, page.instagram_business_account.id);
      }
    }

    console.log(`[Meta OAuth] Successfully connected user ${userId} (Meta ID: ${metaUserId}), ${accounts.length} pages`);

    res.redirect(`${process.env.CORS_ORIGIN || "http://localhost:3000"}/settings?meta=success`);
  } catch (err: any) {
    console.error("[Meta OAuth] Callback error:", err);
    res.redirect(`${process.env.CORS_ORIGIN || "http://localhost:3000"}/settings?meta=error&reason=${encodeURIComponent(err.message)}`);
  }
});

// GET /api/meta/status — check connection status for authenticated user
router.get("/api/meta/status", async (req: Request, res: Response) => {
  const auth = verifyBearerHeader(req.headers.authorization);
  if (!auth.success || !auth.payload) {
    return res.status(401).json({ error: auth.error });
  }

  const { getAllConnections } = await import("../db/meta-repository.js");
  const connections = await getAllConnections(auth.payload.userId);

  const status = connections.map((c) => ({
    platform: c.platform,
    connected: true,
    expiresAt: c.token_expires_at,
    metaUserId: c.meta_user_id,
    pageId: c.page_id,
    instagramId: c.instagram_id,
    lastError: c.last_error || null,
    lastErrorAt: c.last_error_at || null,
  }));

  res.json({
    connected: status.length > 0,
    connections: status,
  });
});

// DELETE /api/meta/disconnect — revoke connection
router.delete("/api/meta/disconnect/:platform", async (req: Request, res: Response) => {
  const auth = verifyBearerHeader(req.headers.authorization);
  if (!auth.success || !auth.payload) {
    return res.status(401).json({ error: auth.error });
  }

  const platform = req.params.platform as string;
  if (!["facebook", "instagram", "page"].includes(platform)) {
    return res.status(400).json({ error: `Invalid platform: ${platform}` });
  }

  const { deleteConnection } = await import("../db/meta-repository.js");
  await deleteConnection(auth.payload.userId, platform as MetaConnection["platform"]);

  res.json({ success: true, message: `Disconnected ${platform}` });
});

export { router as metaOAuthRouter };
