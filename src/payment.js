import crypto from "node:crypto";
import { ARC_TESTNET, ARC_USDC_ADDRESS, isArcNetwork } from "./arc-payment.js";
import { deriveAddress } from "./wallet.js";

export const PAYMENT_MODE = process.env.ADN_PAYMENT_MODE || "dev";
export const DEFAULT_FACILITATOR_URL = process.env.ADN_X402_FACILITATOR_URL || "https://x402.org/facilitator";
export const DEV_PAYMENT_SECRET = "adn-dev-x402-secret";

export function createPaymentRequirements({ serviceId, amount, currency = "USDC", network = "base", payTo }) {
  const issuedAt = new Date();
  const expiresInSeconds = 300;
  const expiresAt = new Date(issuedAt.getTime() + expiresInSeconds * 1000).toISOString();
  const resolvedPayTo = payTo || process.env.ADN_PROVIDER_RECEIVE_ADDRESS || "0xProviderDemoWallet000000000000000000000000";
  const arc = isArcNetwork(network);
  return {
    x402_version: PAYMENT_MODE === "real" ? "x402-v1" : "dev-x402-v1",
    payment_mode: PAYMENT_MODE,
    scheme: "exact",
    network: arc ? "arc-testnet" : network,
    caip2: arc ? ARC_TESTNET.caip2 : undefined,
    chain_id: arc ? ARC_TESTNET.id : undefined,
    asset: currency,
    token_address: arc ? ARC_USDC_ADDRESS : undefined,
    amount,
    pay_to: resolvedPayTo,
    resource: serviceId,
    service_id: serviceId,
    nonce: `nonce_${crypto.randomBytes(16).toString("hex")}`,
    issued_at: issuedAt.toISOString(),
    expires_at: expiresAt,
    resource_hash: hashResource({ serviceId, amount, currency, network: arc ? "arc-testnet" : network, payTo: resolvedPayTo }),
    facilitator_url: DEFAULT_FACILITATOR_URL,
    settlement_model: arc ? "direct_provider_wallet" : "provider_challenge",
    expires_in_seconds: expiresInSeconds
  };
}

export function createDevPaymentProof({ serviceId, amount, currency = "USDC", network = "base", payer = "consumer-demo-agent", challenge }) {
  const issuedAt = new Date().toISOString();
  const payload = {
    x402_version: "dev-x402-v1",
    service_id: serviceId,
    amount,
    currency,
    network,
    pay_to: challenge?.pay_to,
    challenge_nonce: challenge?.nonce,
    challenge_expires_at: challenge?.expires_at,
    resource_hash: challenge?.resource_hash,
    payer,
    issued_at: issuedAt,
    tx_hash: `0x${crypto.randomBytes(32).toString("hex")}`
  };
  const signature = signPayload(payload);
  return Buffer.from(JSON.stringify({ ...payload, signature })).toString("base64url");
}

export function createWalletPaymentProof({ wallet, serviceId, amount, currency = "USDC", network = "base", payTo, challenge }) {
  const issuedAt = new Date().toISOString();
  const payload = {
    x402_version: "dev-x402-v1",
    payment_kind: "wallet_signed",
    service_id: serviceId,
    amount,
    currency,
    network,
    pay_to: payTo,
    challenge_nonce: challenge?.nonce,
    challenge_expires_at: challenge?.expires_at,
    resource_hash: challenge?.resource_hash,
    payer: wallet.address,
    public_key_pem: wallet.public_key_pem,
    issued_at: issuedAt,
    tx_hash: `0x${crypto.randomBytes(32).toString("hex")}`
  };
  const signature = crypto.createSign("SHA256").update(canonicalPayload(payload)).end().sign(wallet.private_key_pem, "hex");
  return Buffer.from(JSON.stringify({ ...payload, signature })).toString("base64url");
}

export function createArcPaymentProof({ wallet, serviceId, amount, currency = "USDC", network = "arc-testnet", payTo, challenge, tx }) {
  const issuedAt = new Date().toISOString();
  const payload = {
    x402_version: "arc-x402-v1",
    payment_kind: "arc_usdc_transfer",
    service_id: serviceId,
    amount,
    currency,
    network,
    caip2: challenge?.caip2 || ARC_TESTNET.caip2,
    chain_id: challenge?.chain_id || ARC_TESTNET.id,
    token_address: challenge?.token_address || ARC_USDC_ADDRESS,
    pay_to: payTo,
    challenge_nonce: challenge?.nonce,
    challenge_expires_at: challenge?.expires_at,
    resource_hash: challenge?.resource_hash,
    payer: wallet.address,
    public_key_pem: wallet.public_key_pem,
    issued_at: issuedAt,
    tx_hash: tx.tx_hash,
    amount_atomic: tx.amount_atomic,
    explorer_url: tx.explorer_url
  };
  const signature = crypto.createSign("SHA256").update(canonicalPayload(payload)).end().sign(wallet.private_key_pem, "hex");
  return Buffer.from(JSON.stringify({ ...payload, signature })).toString("base64url");
}

export function verifyDevPaymentProof(proof, expected) {
  if (!proof || typeof proof !== "string") {
    return { ok: false, error: "MISSING_PAYMENT_PROOF" };
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(proof, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "INVALID_PAYMENT_PROOF" };
  }

  const { signature, ...payload } = decoded;
  if (payload.payment_kind === "arc_usdc_transfer") {
    return verifyArcPaymentPayload({ payload, signature, expected, decoded });
  }
  if (payload.payment_kind === "wallet_signed") {
    return verifyWalletPaymentPayload({ payload, signature, expected, decoded });
  }

  if (!signature || signature !== signPayload(payload)) {
    return { ok: false, error: "INVALID_PAYMENT_SIGNATURE" };
  }

  if (payload.service_id !== expected.serviceId) {
    return { ok: false, error: "PAYMENT_SERVICE_MISMATCH" };
  }

  if (String(payload.amount) !== String(expected.amount) || payload.currency !== expected.currency || payload.network !== expected.network) {
    return { ok: false, error: "PAYMENT_AMOUNT_MISMATCH" };
  }

  if (expected.payTo && payload.pay_to !== expected.payTo) {
    return { ok: false, error: "PAYMENT_TARGET_MISMATCH" };
  }

  if (expected.nonce && payload.challenge_nonce !== expected.nonce) {
    return { ok: false, error: "PAYMENT_CHALLENGE_NONCE_MISMATCH" };
  }

  if (expected.resourceHash && payload.resource_hash !== expected.resourceHash) {
    return { ok: false, error: "PAYMENT_RESOURCE_HASH_MISMATCH" };
  }

  return { ok: true, payment: decoded };
}

function verifyArcPaymentPayload({ payload, signature, expected, decoded }) {
  const walletCheck = verifyWalletPaymentPayload({ payload, signature, expected, decoded });
  if (!walletCheck.ok) return walletCheck;
  if (!isArcNetwork(payload.network)) {
    return { ok: false, error: "PAYMENT_NETWORK_NOT_ARC" };
  }
  if (payload.currency !== "USDC" || payload.token_address?.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase()) {
    return { ok: false, error: "PAYMENT_ASSET_NOT_ARC_USDC" };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(payload.tx_hash || ""))) {
    return { ok: false, error: "INVALID_ARC_TX_HASH" };
  }
  return { ok: true, payment: decoded };
}

function signPayload(payload) {
  return crypto.createHmac("sha256", DEV_PAYMENT_SECRET).update(JSON.stringify(payload)).digest("hex");
}

function verifyWalletPaymentPayload({ payload, signature, expected, decoded }) {
  if (!signature || !payload.public_key_pem || !payload.payer) {
    return { ok: false, error: "INVALID_WALLET_PAYMENT_PAYLOAD" };
  }

  if (payload.service_id !== expected.serviceId) {
    return { ok: false, error: "PAYMENT_SERVICE_MISMATCH" };
  }

  if (String(payload.amount) !== String(expected.amount) || payload.currency !== expected.currency || payload.network !== expected.network) {
    return { ok: false, error: "PAYMENT_AMOUNT_MISMATCH" };
  }

  if (expected.payTo && payload.pay_to !== expected.payTo) {
    return { ok: false, error: "PAYMENT_TARGET_MISMATCH" };
  }

  if (expected.nonce && payload.challenge_nonce !== expected.nonce) {
    return { ok: false, error: "PAYMENT_CHALLENGE_NONCE_MISMATCH" };
  }

  if (expected.resourceHash && payload.resource_hash !== expected.resourceHash) {
    return { ok: false, error: "PAYMENT_RESOURCE_HASH_MISMATCH" };
  }

  if (payload.challenge_expires_at && Date.parse(payload.challenge_expires_at) < Date.now()) {
    return { ok: false, error: "PAYMENT_CHALLENGE_EXPIRED" };
  }

  const valid = crypto.createVerify("SHA256").update(canonicalPayload(payload)).end().verify(payload.public_key_pem, signature, "hex");
  if (!valid) {
    return { ok: false, error: "INVALID_WALLET_PAYMENT_SIGNATURE" };
  }

  const derived = deriveAddress(payload.public_key_pem);
  if (derived !== payload.payer) {
    return { ok: false, error: "PAYER_ADDRESS_MISMATCH" };
  }

  return { ok: true, payment: decoded };
}

function canonicalPayload(payload) {
  return JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))));
}

function hashResource({ serviceId, amount, currency, network, payTo }) {
  return `0x${crypto.createHash("sha256").update(JSON.stringify({ serviceId, amount, currency, network, payTo })).digest("hex")}`;
}
