import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

function parseHexKey(key: string, label: string): Buffer {
  const buf = Buffer.from(key, "hex");
  if (buf.length !== 32) {
    throw new Error(`${label} must be 64 hex characters (32 bytes), got ${key.length} chars`);
  }
  return buf;
}

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_KEY not configured");
  }
  return parseHexKey(key, "ENCRYPTION_KEY");
}

function getPreviousKey(): Buffer | null {
  const key = process.env.ENCRYPTION_KEY_PREVIOUS;
  if (!key) return null;
  return parseHexKey(key, "ENCRYPTION_KEY_PREVIOUS");
}

function keyFingerprint(key: Buffer): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export function requireEncryptionKey(): void {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    if (process.env.NODE_ENV === "production") {
      console.error("\n❌ FATAL: ENCRYPTION_KEY not set in production.");
      process.exit(1);
    }
    console.warn("\n⚠️  WARNING: ENCRYPTION_KEY not set. Meta OAuth token storage will fail on first use.");
    return;
  }
  try {
    parseHexKey(key, "ENCRYPTION_KEY");
  } catch (err: any) {
    console.error(`\n❌ FATAL: ${err.message}`);
    process.exit(1);
  }
  if (process.env.ENCRYPTION_KEY_PREVIOUS) {
    try {
      parseHexKey(process.env.ENCRYPTION_KEY_PREVIOUS, "ENCRYPTION_KEY_PREVIOUS");
    } catch (err: any) {
      console.warn(`\n⚠️  ENCRYPTION_KEY_PREVIOUS invalid: ${err.message}. Key rotation migration disabled.`);
    }
  }
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const fingerprint = keyFingerprint(key);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return `${fingerprint}:${iv.toString("hex")}:${encrypted}:${authTag}`;
}

function tryDecryptWithKey(ciphertext: string, key: Buffer): string | null {
  try {
    const parts = ciphertext.split(":");
    if (parts.length !== 4) return null;
    const [, ivHex, encrypted, authTagHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, "hex", "utf8");
    decrypted += decipher.final("utf8");
    return decrypted;
  } catch {
    return null;
  }
}

export function decrypt(ciphertext: string): string {
  const { plaintext } = decryptWithKeyRotation(ciphertext);
  return plaintext;
}

export function decryptWithKeyRotation(ciphertext: string): { plaintext: string; needsReEncrypt: boolean } {
  const parts = ciphertext.split(":");
  if (parts.length !== 4) {
    throw new Error("Invalid ciphertext format");
  }

  // Try current key first (fast path)
  const currentKey = getKey();
  const result = tryDecryptWithKey(ciphertext, currentKey);
  if (result !== null) {
    return { plaintext: result, needsReEncrypt: false };
  }

  // Fall back to previous key
  const prevKey = getPreviousKey();
  if (prevKey) {
    const prevResult = tryDecryptWithKey(ciphertext, prevKey);
    if (prevResult !== null) {
      return { plaintext: prevResult, needsReEncrypt: true };
    }
  }

  throw new Error(
    "Token decryption failed with all configured keys. " +
    "This may indicate key rotation without ENCRYPTION_KEY_PREVIOUS, or data corruption.",
  );
}
