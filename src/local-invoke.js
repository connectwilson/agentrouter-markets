import { createWalletPaymentProof } from "./payment.js";
import { assertPolicyAllows, readWallet, recordPayment } from "./wallet.js";

export async function invokePaidServiceWithLocalWallet({ baseUrl, serviceId, input = {}, budget = { max_amount: "0.05", currency: "USDC" } }) {
  const manifest = await postJson(baseUrl, "/connector/get_manifest", { service_id: serviceId });
  if (budget.max_amount != null && Number(manifest.pricing.amount) > Number(budget.max_amount)) {
    throw new Error(`Service costs ${manifest.pricing.amount} ${manifest.pricing.currency}, above budget ${budget.max_amount} ${budget.currency}.`);
  }

  const firstResponse = await fetch(manifest.endpoint.url, {
    method: manifest.endpoint.method || "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
  if (firstResponse.status !== 402) {
    throw new Error(`Expected HTTP 402 payment challenge, got ${firstResponse.status}.`);
  }

  const challenge = await firstResponse.json();
  const payment = challenge.payment;
  await assertPolicyAllows({
    serviceId,
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    payTo: payment.pay_to,
    providerId: manifest.provider.provider_id,
    manifest,
    challenge: payment
  });
  const wallet = await readWallet();
  const proof = createWalletPaymentProof({
    wallet,
    serviceId,
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    payTo: payment.pay_to,
    challenge: payment
  });

  const paidResponse = await fetch(manifest.endpoint.url, {
    method: manifest.endpoint.method || "POST",
    headers: {
      "content-type": "application/json",
      "x-payment": proof
    },
    body: JSON.stringify(input)
  });
  const result = await paidResponse.json();
  const event = {
    service_id: serviceId,
    provider_id: manifest.provider.provider_id,
    payer: wallet.address,
    payment_tx: decodePaymentTx(proof),
    amount: payment.amount,
    currency: payment.asset,
    network: payment.network,
    pay_to: payment.pay_to,
    challenge_nonce: payment.nonce,
    challenge_expires_at: payment.expires_at,
    status: paidResponse.ok && result.status === "success" ? "success" : "error"
  };
  await recordPayment(event);

  return {
    result,
    local_payment: event
  };
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
    error.payload = payload;
    throw error;
  }
  return payload;
}

function decodePaymentTx(proof) {
  try {
    return JSON.parse(Buffer.from(proof, "base64url").toString("utf8")).tx_hash;
  } catch {
    return null;
  }
}
