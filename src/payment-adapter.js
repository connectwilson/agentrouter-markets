export const PAYMENT_BACKENDS = ["dev", "x402", "omniagentpay", "circle_arc"];

export function currentPaymentBackend() {
  const backend = process.env.ADN_PAYMENT_BACKEND || process.env.ADN_PAYMENT_MODE || "dev";
  if (backend === "real") return "x402";
  return PAYMENT_BACKENDS.includes(backend) ? backend : "dev";
}

export function describePaymentBackend() {
  const backend = currentPaymentBackend();
  return {
    backend,
    mode: backend,
    execution_layer: backend === "dev" ? "local_dev_x402_proof" : backend,
    real_settlement: backend !== "dev",
    supported_backends: PAYMENT_BACKENDS,
    notes: backend === "dev"
      ? "Development mode uses local x402-style payment proofs and simulated settlement receipts."
      : "Production backends should execute real payment authorization, settlement, and ledger recording."
  };
}

export function createPaymentQuote({ manifest, constraints = {}, selectedService }) {
  const maxPrice = constraints.max_price_usdc || constraints.max_price || constraints.max_amount;
  const price = Number(manifest.pricing.amount);
  const max = maxPrice == null || maxPrice === "" ? null : Number(maxPrice);
  const allowed = max == null || price <= max;
  return {
    quote_version: "agent_router_payment_quote_v1",
    payment_backend: describePaymentBackend(),
    service_id: manifest.service_id,
    provider_id: manifest.provider.provider_id,
    selected_service: selectedService || null,
    pricing: manifest.pricing,
    budget: {
      max_price_usdc: maxPrice || null,
      allowed
    },
    guard_result: allowed ? "pass" : "budget_too_low",
    would_pay: allowed,
    reason: allowed
      ? `Service price ${manifest.pricing.amount} ${manifest.pricing.currency} is within budget.`
      : `Service price ${manifest.pricing.amount} ${manifest.pricing.currency} exceeds budget ${maxPrice} USDC.`
  };
}

export function createSettlementReceipt({ manifest, challenge, txHash }) {
  const backend = currentPaymentBackend();
  return {
    receipt_version: "agent_router_settlement_receipt_v1",
    payment_backend: backend,
    mode: backend,
    network: backend === "circle_arc" ? "arc" : manifest.pricing.network,
    protocol: manifest.pricing.protocol || "x402",
    asset: challenge.asset || manifest.pricing.currency,
    amount: challenge.amount || manifest.pricing.amount,
    payer: "consumer_demo_agent",
    pay_to: challenge.pay_to,
    tx_hash: txHash,
    status: backend === "dev" ? "simulated_settled" : "settled",
    created_at: new Date().toISOString()
  };
}
