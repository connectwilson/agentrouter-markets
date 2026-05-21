export class DiscoveryConnector {
  constructor({ baseUrl }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async searchServices({ query, capabilities = [], max_price: maxPrice, verified_only: verifiedOnly = true } = {}) {
    return this.#post("/connector/search_services", {
      query,
      capabilities,
      max_price: maxPrice,
      verified_only: verifiedOnly
    });
  }

  async getManifest(serviceId) {
    return this.#post("/connector/get_manifest", { service_id: serviceId });
  }

  async previewService(serviceId, input = {}) {
    return this.#post("/connector/preview_service", { service_id: serviceId, input });
  }

  async invokePaidService(serviceId, input = {}, budget = { max_amount: "0.05", currency: "USDC" }) {
    return this.#post("/connector/invoke_paid_service", {
      service_id: serviceId,
      input,
      budget
    });
  }

  async getFeedback(serviceId) {
    return this.#post("/connector/get_feedback", { service_id: serviceId });
  }

  async submitConsumerFeedback({ service_id: serviceId, request_id: requestId, consumer_id: consumerId, feedback }) {
    return this.#post("/agent-router/feedback", {
      service_id: serviceId,
      request_id: requestId,
      consumer_id: consumerId,
      feedback
    });
  }

  async routeTask({ task, intent, constraints = {}, budget = {} }) {
    return this.#post("/router/route", {
      task,
      intent,
      constraints,
      budget
    });
  }

  async resolveRoute({ task, intent, constraints = {} }) {
    return this.#post("/router/resolve", {
      task,
      intent,
      constraints
    });
  }

  async #post(path, body) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload?.error?.message || payload?.error?.code || `HTTP ${response.status}`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }
}

export async function runConsumerDemo({ baseUrl, query = "Base 7d fund flow" }) {
  const connector = new DiscoveryConnector({ baseUrl });
  const services = await connector.searchServices({
    query,
    capabilities: ["onchain_data", "fund_flow"],
    max_price: "0.05",
    verified_only: true
  });

  if (!services.length) {
    throw new Error("No matching services found.");
  }

  const selected = services[0];
  const manifest = await connector.getManifest(selected.service_id);
  const preview = await connector.previewService(selected.service_id, manifest.sample_request);
  const invocation = await connector.invokePaidService(
    selected.service_id,
    { chain: "base", days: 7 },
    { max_amount: "0.05", currency: "USDC" }
  );
  const feedback = await connector.getFeedback(selected.service_id);
  const result = invocation.result;

  return {
    selected_service: selected,
    manifest_title: manifest.title,
    preview_sample_type: preview.sample_type,
    paid_result: result,
    feedback_event: invocation.feedback,
    feedback_count: feedback.length,
    analysis: buildAnalysis(result)
  };
}

export function buildAnalysis(envelope) {
  const metrics = envelope.data.metrics;
  const direction = metrics.net_flow_usd >= 0 ? "net inflow" : "net outflow";
  const topSource = envelope.data.breakdowns.top_sources[0]?.label || "unknown source";
  const topDestination = envelope.data.breakdowns.top_destinations[0]?.label || "unknown destination";
  return [
    `Base shows a 7-day ${direction} of $${formatUsd(Math.abs(metrics.net_flow_usd))}.`,
    `Inflows were $${formatUsd(metrics.inflow_usd)} versus outflows of $${formatUsd(metrics.outflow_usd)}.`,
    `Stablecoin net flow was $${formatUsd(metrics.stablecoin_net_flow_usd)}, with major source "${topSource}" and destination "${topDestination}".`,
    `Caveat: ${envelope.metadata.limitations.join(" ")}`
  ].join(" ");
}

function formatUsd(value) {
  return Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 });
}
