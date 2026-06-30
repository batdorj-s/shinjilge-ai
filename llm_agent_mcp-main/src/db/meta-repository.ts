import { getPool, isPgAvailable, initDataLake } from "./data-lake.js";
import { encrypt, decryptWithKeyRotation } from "../utils/encryption.js";

export interface MetaConnection {
  id: string;
  owner_id: string;
  platform: "facebook" | "instagram" | "page";
  access_token: string;
  token_expires_at: string;
  scopes: string[];
  meta_user_id?: string;
  page_id?: string;
  instagram_id?: string;
  last_error?: string | null;
  last_error_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetaConnectionRow {
  id: string;
  owner_id: string;
  platform: string;
  encrypted_token: string;
  token_expires_at: string;
  scopes: string;
  meta_user_id: string | null;
  page_id: string | null;
  instagram_id: string | null;
  last_error: string | null;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
}

async function rowToConnection(row: MetaConnectionRow): Promise<MetaConnection> {
  const { plaintext: accessToken, needsReEncrypt } = decryptWithKeyRotation(row.encrypted_token);
  if (needsReEncrypt) {
    await reEncryptToken(row.id, accessToken);
  }
  return {
    id: row.id,
    owner_id: row.owner_id,
    platform: row.platform as MetaConnection["platform"],
    access_token: accessToken,
    token_expires_at: row.token_expires_at,
    scopes: JSON.parse(row.scopes),
    meta_user_id: row.meta_user_id ?? undefined,
    page_id: row.page_id ?? undefined,
    instagram_id: row.instagram_id ?? undefined,
    last_error: row.last_error,
    last_error_at: row.last_error_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function reEncryptToken(connectionId: string, plaintextToken: string): Promise<void> {
  const pool = getPool();
  const newEncrypted = encrypt(plaintextToken);
  await pool.query(
    `UPDATE meta_connections SET encrypted_token = $1, updated_at = NOW() WHERE id = $2`,
    [newEncrypted, connectionId],
  );
  console.log(`[Meta Repository] Re-encrypted connection ${connectionId} with current key`);
}

export async function saveConnection(
  ownerId: string,
  platform: MetaConnection["platform"],
  accessToken: string,
  tokenExpiresAt: string,
  scopes: string[],
  metaUserId?: string,
  pageId?: string,
  instagramId?: string,
): Promise<string> {
  await initDataLake();
  const pool = getPool();
  const id = `meta_${platform}_${ownerId}_${Date.now()}`;
  const encryptedToken = encrypt(accessToken);
  const scopesJson = JSON.stringify(scopes);

  await pool.query(
    `INSERT INTO meta_connections
      (id, owner_id, platform, encrypted_token, token_expires_at, scopes, meta_user_id, page_id, instagram_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (owner_id, platform) DO UPDATE SET
      encrypted_token = EXCLUDED.encrypted_token,
      token_expires_at = EXCLUDED.token_expires_at,
      scopes = EXCLUDED.scopes,
      meta_user_id = EXCLUDED.meta_user_id,
      page_id = EXCLUDED.page_id,
      instagram_id = EXCLUDED.instagram_id,
      updated_at = NOW()`,
    [id, ownerId, platform, encryptedToken, tokenExpiresAt, scopesJson, metaUserId ?? null, pageId ?? null, instagramId ?? null],
  );

  return id;
}

export async function getConnection(ownerId: string, platform: MetaConnection["platform"]): Promise<MetaConnection | null> {
  await initDataLake();
  if (!isPgAvailable()) return null;
  const pool = getPool();

  const result = await pool.query(
    `SELECT * FROM meta_connections WHERE owner_id = $1 AND platform = $2 ORDER BY updated_at DESC LIMIT 1`,
    [ownerId, platform],
  );

  if (result.rows.length === 0) return null;
  return await rowToConnection(result.rows[0] as MetaConnectionRow);
}

export async function getAllConnections(ownerId: string): Promise<MetaConnection[]> {
  await initDataLake();
  if (!isPgAvailable()) return [];
  const pool = getPool();

  const result = await pool.query(
    `SELECT * FROM meta_connections WHERE owner_id = $1 ORDER BY platform`,
    [ownerId],
  );

  const rows = result.rows as MetaConnectionRow[];
  return Promise.all(rows.map(r => rowToConnection(r)));
}

export async function deleteConnection(ownerId: string, platform: MetaConnection["platform"]): Promise<void> {
  await initDataLake();
  const pool = getPool();
  await pool.query(
    `DELETE FROM meta_connections WHERE owner_id = $1 AND platform = $2`,
    [ownerId, platform],
  );
}

export async function refreshToken(
  ownerId: string,
  platform: MetaConnection["platform"],
  newAccessToken: string,
  newExpiresAt: string,
): Promise<void> {
  await initDataLake();
  const pool = getPool();
  const encryptedToken = encrypt(newAccessToken);

  await pool.query(
    `UPDATE meta_connections
     SET encrypted_token = $1, token_expires_at = $2, updated_at = NOW()
     WHERE owner_id = $3 AND platform = $4`,
    [encryptedToken, newExpiresAt, ownerId, platform],
  );
}

export async function getConnectionByPageId(ownerId: string, pageId: string): Promise<MetaConnection | null> {
  await initDataLake();
  if (!isPgAvailable()) return null;
  const pool = getPool();

  const result = await pool.query(
    `SELECT * FROM meta_connections WHERE owner_id = $1 AND page_id = $2 ORDER BY updated_at DESC LIMIT 1`,
    [ownerId, pageId],
  );

  if (result.rows.length === 0) return null;
  return await rowToConnection(result.rows[0] as MetaConnectionRow);
}
