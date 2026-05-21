import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ADN_DIR, ensureAdnDir } from "./wallet.js";
import { deletePersistentProviderSecret, readPersistentProviderSecret, writePersistentProviderSecret } from "./persistence.js";

export const PROVIDER_SECRETS_PATH = path.join(ADN_DIR, "provider-secrets.json");
export const PROVIDER_SECRET_KEY_PATH = path.join(ADN_DIR, "provider-secret.key");

export async function writeProviderSecret({ serviceId, secretName, secretValue }) {
  if (!secretValue) return null;
  await ensureAdnDir();
  const secrets = await readSecretStoreRaw();
  const secretRef = `${serviceId}:${secretName}`;
  const encrypted = encryptSecret(secretValue, await getProviderSecretPassphrase());
  secrets[secretRef] = encrypted;
  await writePersistentProviderSecret(secretRef, encrypted);
  await fs.writeFile(PROVIDER_SECRETS_PATH, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  return secretRef;
}

export async function readProviderSecret(secretRef) {
  if (!secretRef) return "";
  const secrets = await readSecretStoreRaw();
  const encrypted = await readPersistentProviderSecret(secretRef) || secrets[secretRef];
  if (!encrypted) {
    throw new Error(`Provider secret ${secretRef} was not found in local secret store.`);
  }
  return decryptSecret(encrypted, await getProviderSecretPassphrase());
}

export async function deleteProviderSecret(secretRef) {
  if (!secretRef) return false;
  const secrets = await readSecretStoreRaw();
  delete secrets[secretRef];
  await deletePersistentProviderSecret(secretRef);
  await ensureAdnDir();
  await fs.writeFile(PROVIDER_SECRETS_PATH, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  return true;
}

async function readSecretStoreRaw() {
  try {
    return JSON.parse(await fs.readFile(PROVIDER_SECRETS_PATH, "utf8"));
  } catch {
    return {};
  }
}

async function getProviderSecretPassphrase() {
  const passphrase = process.env.ADN_PROVIDER_SECRET_PASSPHRASE || process.env.ADN_WALLET_PASSPHRASE;
  if (passphrase && passphrase.length < 8) {
    throw new Error("Provider Secret passphrase must be at least 8 characters.");
  }
  return passphrase || readOrCreateLocalProviderSecretKey();
}

async function readOrCreateLocalProviderSecretKey() {
  await ensureAdnDir();
  try {
    const existing = (await fs.readFile(PROVIDER_SECRET_KEY_PATH, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // Create a local runtime key below.
  }
  const generated = crypto.randomBytes(32).toString("base64url");
  await fs.writeFile(PROVIDER_SECRET_KEY_PATH, `${generated}\n`, { mode: 0o600 });
  return generated;
}

function encryptSecret(secretValue, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secretValue, "utf8"), cipher.final()]);
  return {
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decryptSecret(encrypted, passphrase) {
  const salt = Buffer.from(encrypted.salt, "base64");
  const iv = Buffer.from(encrypted.iv, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
