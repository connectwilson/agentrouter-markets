export function createMemoryStore() {
  return {
    providers: new Map(),
    services: new Map(),
    validationRuns: [],
    invocationLogs: [],
    feedbackEvents: [],
    evidenceEvents: []
  };
}

export function publicServiceRecord(record) {
  return {
    service_id: record.manifest.service_id,
    title: record.manifest.title,
    description_for_agent: record.manifest.description_for_agent,
    capabilities: record.manifest.capabilities,
    pricing: record.manifest.pricing,
    verification_status: record.verification_status,
    trust: summarizeTrust(record),
    sample_response: record.manifest.sample_response
  };
}

export function summarizeTrust(record) {
  const events = record.feedback_events || [];
  const successful = events.filter((event) => event.status === "success").length;
  const schemaValid = events.filter((event) => event.schema_valid).length;
  const successRate = events.length ? successful / events.length : null;
  const schemaValidRate = events.length ? schemaValid / events.length : null;
  const latencyEvents = events.filter((event) => typeof event.latency_ms === "number");
  const averageLatencyMs = latencyEvents.length
    ? latencyEvents.reduce((sum, event) => sum + event.latency_ms, 0) / latencyEvents.length
    : null;
  const verificationScore = record.verification_status === "verified" ? 1 : 0.2;
  const trustScore = events.length
    ? (
        (successRate ?? 0) * 0.4 +
        (schemaValidRate ?? 0) * 0.35 +
        latencyScore(averageLatencyMs) * 0.15 +
        verificationScore * 0.1
      )
    : verificationScore * 0.7;
  return {
    provider_id: record.manifest.provider.provider_id,
    feedback_count: events.length,
    success_rate: successRate,
    schema_valid_rate: schemaValidRate,
    average_latency_ms: averageLatencyMs == null ? null : Number(averageLatencyMs.toFixed(2)),
    verification_status: record.verification_status,
    trust_score: Number(trustScore.toFixed(4))
  };
}

function latencyScore(averageLatencyMs) {
  if (averageLatencyMs == null) return 0.8;
  if (averageLatencyMs <= 250) return 1;
  if (averageLatencyMs <= 1000) return 0.75;
  if (averageLatencyMs <= 3000) return 0.45;
  return 0.2;
}
