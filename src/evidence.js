import { createHash } from "node:crypto";

export function createEvidenceEnvelope({
  request,
  input,
  selectedService,
  manifest,
  quote,
  result,
  feedback,
  verification,
  routeType = "structured_capability_request"
}) {
  const resultHash = hashJson(result);
  const inputHash = hashJson(input);
  const verificationHash = hashJson(verification);
  const tracePayload = {
    route_type: routeType,
    request,
    request_id: result?.request_id || feedback?.request_id || null,
    service_id: manifest.service_id,
    provider_id: manifest.provider.provider_id,
    input_hash: inputHash,
    result_hash: resultHash,
    verification_hash: verificationHash,
    payment_tx: feedback?.payment_tx || null,
    settlement_receipt: feedback?.settlement_receipt || null
  };
  const traceHash = hashJson(tracePayload);
  const createdAt = new Date().toISOString();

  return {
    evidence_version: "agent_router_evidence_v1",
    route_type: routeType,
    request_id: result?.request_id || feedback?.request_id || null,
    service_id: manifest.service_id,
    provider_id: manifest.provider.provider_id,
    selected_service: selectedService,
    request,
    input,
    result_hash: resultHash,
    input_hash: inputHash,
    verification_hash: verificationHash,
    trace_hash: traceHash,
    trace_payload_hash: traceHash,
    payment: {
      quote,
      settlement_receipt: feedback?.settlement_receipt || null,
      payment_tx: feedback?.payment_tx || null
    },
    payment_tx: feedback?.payment_tx || null,
    verification,
    arc_anchor: {
      anchor_version: "agent_router_arc_anchor_v1",
      network: "arc-testnet",
      caip2: "eip155:5042002",
      chain_id: 5042002,
      status: "not_configured",
      event_type: "AgentRouterEvidence",
      storage_model: "full_evidence_offchain_hashes_on_arc",
      request_id: result?.request_id || feedback?.request_id || null,
      trace_hash: traceHash,
      result_hash: resultHash,
      verification_hash: verificationHash,
      created_at: createdAt
    },
    created_at: createdAt
  };
}

export function hashJson(value) {
  return `0x${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
