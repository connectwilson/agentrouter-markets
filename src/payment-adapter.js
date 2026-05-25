export const PAYMENT_BACKENDS = ["x402", "omniagentpay", "circle_arc"];

export function currentPaymentBackend() {
  const backend = process.env.ADN_PAYMENT_BACKEND || process.env.ADN_PAYMENT_MODE || "circle_arc";
  if (backend === "real") return "x402";
  return PAYMENT_BACKENDS.includes(backend) ? backend : "circle_arc";
}

export function describePaymentBackend() {
  const backend = currentPaymentBackend();
  return {
    backend,
    mode: backend,
    execution_layer: backend,
    real_settlement: true,
    supported_backends: PAYMENT_BACKENDS,
    notes: backend === "circle_arc"
        ? "Circle Arc mode uses an x402-style HTTP 402 challenge, then verifies a real Arc Testnet USDC transfer to the provider wallet before returning data."
        : "Production backends should execute real payment authorization, settlement, and ledger recording."
  };
}

export function createPaymentQuote({ manifest, constraints = {}, selectedService }) {
  const maxPrice = constraints.max_price_usdc || constraints.max_price || constraints.max_amount;
  const pricing = effectivePricing(manifest);
  const price = Number(pricing.amount);
  const max = maxPrice == null || maxPrice === "" ? null : Number(maxPrice);
  const allowed = max == null || price <= max;
  return {
    quote_version: "agent_router_payment_quote_v1",
    payment_backend: describePaymentBackend(),
    service_id: manifest.service_id,
    provider_id: manifest.provider.provider_id,
    selected_service: selectedService || null,
    pricing,
    budget: {
      max_price_usdc: maxPrice || null,
      allowed
    },
    guard_result: allowed ? "pass" : "budget_too_low",
    would_pay: allowed,
    reason: allowed
      ? `Service price ${pricing.amount} ${pricing.currency} is within budget.`
      : `Service price ${pricing.amount} ${pricing.currency} exceeds budget ${maxPrice} USDC.`
  };
}

export function effectivePricing(manifest = {}) {
  const pricing = manifest.pricing || {};
  if (currentPaymentBackend() !== "circle_arc") return pricing;
  return {
    ...pricing,
    network: "arc-testnet",
    caip2: "eip155:5042002",
    chain_id: 5042002,
    protocol: pricing.protocol || "x402",
    settlement_model: pricing.settlement_model || "direct_provider_wallet",
    pay_to: pricing.pay_to || manifest.provider?.payout_address || process.env.ADN_PROVIDER_RECEIVE_ADDRESS || null
  };
}

export function createSettlementReceipt({ manifest, challenge, txHash }) {
  const backend = currentPaymentBackend();
  return {
    receipt_version: "agent_router_settlement_receipt_v1",
    payment_backend: backend,
    mode: backend,
    network: backend === "circle_arc" ? "arc-testnet" : manifest.pricing.network,
    caip2: challenge.caip2 || (backend === "circle_arc" ? "eip155:5042002" : undefined),
    chain_id: challenge.chain_id || (backend === "circle_arc" ? 5042002 : undefined),
    protocol: manifest.pricing.protocol || "x402",
    asset: challenge.asset || manifest.pricing.currency,
    token_address: challenge.token_address || manifest.pricing.token_address || undefined,
    amount: challenge.amount || manifest.pricing.amount,
    payer: challenge.payer || "agentrouter_consumer",
    pay_to: challenge.pay_to,
    tx_hash: txHash,
    settlement_model: challenge.settlement_model || manifest.pricing.settlement_model || null,
    status: "settled",
    created_at: new Date().toISOString()
  };
}
