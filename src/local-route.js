import { DiscoveryConnector } from "./connector.js";
import { invokePaidServiceWithLocalWallet } from "./local-invoke.js";
import { verifyServiceResult } from "./verifier.js";

export async function routeTaskWithLocalWallet({ baseUrl, task, constraints = {}, budget = {} }) {
  const connector = new DiscoveryConnector({ baseUrl });
  const resolved = await connector.resolveRoute({ task, constraints });
  if (resolved.status === "needs_clarification" || resolved.status === "no_match") {
    return resolved;
  }

  const invocation = await invokePaidServiceWithLocalWallet({
    baseUrl,
    serviceId: resolved.selected_service.service_id,
    input: resolved.input,
    budget: {
      max_amount: constraints.max_price_usdc || budget.max_amount || "0.05",
      currency: budget.currency || "USDC"
    }
  });
  const manifest = await connector.getManifest(resolved.selected_service.service_id);
  const verification = verifyServiceResult({
    result: invocation.result,
    manifest,
    intent: resolved.intent,
    constraints
  });

  return {
    ...resolved,
    result: invocation.result,
    local_payment: invocation.local_payment,
    evidence_recording: invocation.evidence_recording,
    consumer_feedback_request: invocation.evidence_recording?.consumer_feedback_request || null,
    verification,
    routing_event: {
      event_version: "agent_route_event_v1",
      task,
      normalized_intent: resolved.intent,
      service_id: resolved.selected_service.service_id,
      provider_id: resolved.selected_service.provider_id,
      verification,
      score: resolved.selected_service.routing_score,
      created_at: new Date().toISOString()
    }
  };
}
