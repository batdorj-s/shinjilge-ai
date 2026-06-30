import dotenv from "dotenv";
dotenv.config();

const { initDataLake, getPool } = await import("../src/db/data-lake.js");
const { saveConnection } = await import("../src/db/meta-repository.js");
const { decryptWithKeyRotation } = await import("../src/utils/encryption.js");
const { syncInstagramData } = await import("../src/ingestion/meta-instagram.js");
const { registerMetaTablesInCatalog } = await import("../src/ingestion/meta-ads.js");

const OWNER_ID = "user_1782829985723";

await initDataLake();
const pool = getPool();

// Get existing encrypted Facebook token
const fbRow = await pool.query(
  `SELECT * FROM meta_connections WHERE owner_id = $1 AND platform = 'facebook'`,
  [OWNER_ID],
);
if (fbRow.rows.length === 0) {
  console.error("No Facebook connection found. Run OAuth first.");
  process.exit(1);
}

const { plaintext: userToken } = decryptWithKeyRotation(fbRow.rows[0].encrypted_token);
const expiresAt = fbRow.rows[0].token_expires_at;

// Fetch pages with Instagram Business Account info
const url = `https://graph.facebook.com/v22.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${userToken}`;
const resp = await fetch(url);
const data = await resp.json() as any;

if (data.error) {
  console.error("API Error:", data.error.message);
  process.exit(1);
}

console.log(`Found ${data.data?.length || 0} pages`);
for (const page of (data.data || [])) {
  const ig = page.instagram_business_account;
  console.log(`  Page: ${page.id} ${page.name} | IG: ${ig ? ig.id + " (" + ig.username + ")" : "NONE"}`);

  if (ig) {
    // Save Instagram connection
    await saveConnection(
      OWNER_ID,
      "instagram",
      userToken,  // Instagram uses the same User Token
      expiresAt,
      ["instagram_basic"],
      fbRow.rows[0].meta_user_id || undefined,
      page.id,
      ig.id,
    );
    console.log(`  → Instagram connection saved! IG ID: ${ig.id}`);
  }
}

// Test Instagram sync
console.log("\n--- Testing Instagram sync ---");
try {
  const stats = await syncInstagramData(OWNER_ID);
  console.log("Instagram sync result:", JSON.stringify(stats, null, 2));
  await registerMetaTablesInCatalog(OWNER_ID);
  console.log("Catalog updated.");
} catch (err: any) {
  console.error("Instagram sync failed:", err.message);
}

await pool.end();
