import { describe, it, expect, beforeAll } from "vitest";
import crypto from "crypto";

const TEST_KEY = crypto.randomBytes(32).toString("hex");
const TEST_KEY_OLD = crypto.randomBytes(32).toString("hex");

describe("encryption — AES-256-GCM round-trip", () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
  });

  it("encrypts and decrypts a simple string", async () => {
    const { encrypt, decrypt } = await import("../utils/encryption.js");
    const plaintext = "my-secret-token-123";
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted.split(":").length).toBe(4);
    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", async () => {
    const { encrypt } = await import("../utils/encryption.js");
    const plaintext = "same-value";
    const a = encrypt(plaintext);
    const b = encrypt(plaintext);
    expect(a).not.toBe(b);
  });

  it("throws on invalid ciphertext format", async () => {
    const { decrypt } = await import("../utils/encryption.js");
    expect(() => decrypt("invalid-format")).toThrow("Invalid ciphertext format");
  });

  it("throws on corrupted ciphertext", async () => {
    const { encrypt, decrypt } = await import("../utils/encryption.js");
    const encrypted = encrypt("test");
    const parts = encrypted.split(":");
    const corrupted = [parts[0], parts[1], "deadbeef", parts[3]].join(":");
    expect(() => decrypt(corrupted)).toThrow();
  });
});

describe("encryption — key rotation", () => {
  beforeAll(() => {
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
  });

  it("decrypts with previous key when ENCRYPTION_KEY_PREVIOUS is set", async () => {
    process.env.ENCRYPTION_KEY = TEST_KEY_OLD;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    const { encrypt } = await import("../utils/encryption.js");
    const plaintext = "rotated-token";
    const oldEncrypted = encrypt(plaintext);

    process.env.ENCRYPTION_KEY = TEST_KEY;
    process.env.ENCRYPTION_KEY_PREVIOUS = TEST_KEY_OLD;

    const { decryptWithKeyRotation } = await import("../utils/encryption.js");
    const result = decryptWithKeyRotation(oldEncrypted);
    expect(result.plaintext).toBe(plaintext);
    expect(result.needsReEncrypt).toBe(true);
  });

  it("flags needsReEncrypt=false for current-key tokens", async () => {
    process.env.ENCRYPTION_KEY = TEST_KEY;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
    const { encrypt, decryptWithKeyRotation } = await import("../utils/encryption.js");
    const encrypted = encrypt("current-key-token");
    const result = decryptWithKeyRotation(encrypted);
    expect(result.plaintext).toBe("current-key-token");
    expect(result.needsReEncrypt).toBe(false);
  });
});

describe("encryption — requireEncryptionKey", () => {
  it("passes when ENCRYPTION_KEY is valid hex", async () => {
    process.env.ENCRYPTION_KEY = TEST_KEY;
    const { requireEncryptionKey } = await import("../utils/encryption.js");
    expect(() => requireEncryptionKey()).not.toThrow();
  });
});
