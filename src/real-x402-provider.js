import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { currentPaymentBackend } from "./payment-adapter.js";

const providerServers = new Map();

export function isRealX402ProviderEnabled() {
  return currentPaymentBackend() === "x402";
}

export async function processProviderX402Payment({ req, serviceId, amount, network, description = "", mimeType = "application/json" }) {
  const resourceServer = await getProviderServer({ serviceId, amount, network, description, mimeType });
  const context = buildHttpContext({ req, serviceId });
  const processed = await resourceServer.processHTTPRequest(context);
  if (processed.type === "payment-error") {
    return {
      ok: false,
      response: processed.response
    };
  }
  if (processed.type !== "payment-verified") {
    return {
      ok: true,
      required: false
    };
  }
  return {
    ok: true,
    required: true,
    resourceServer,
    paymentPayload: processed.paymentPayload,
    paymentRequirements: processed.paymentRequirements,
    declaredExtensions: processed.declaredExtensions,
    transportContext: {
      request: context
    }
  };
}

export async function settleProviderX402Payment(paymentContext, responseBody, responseHeaders = {}) {
  if (!paymentContext?.required) {
    return {
      headers: {},
      settlement: null
    };
  }
  const settlement = await paymentContext.resourceServer.processSettlement(
    paymentContext.paymentPayload,
    paymentContext.paymentRequirements,
    paymentContext.declaredExtensions,
    {
      ...paymentContext.transportContext,
      responseBody: Buffer.from(JSON.stringify(responseBody || {})),
      responseHeaders
    }
  );
  if (!settlement.success) {
    return {
      failed: true,
      response: settlement.response,
      settlement
    };
  }
  return {
    headers: settlement.headers || {},
    settlement
  };
}

export function sendX402Response(res, instructions) {
  const headers = normalizeHeaders(instructions.headers || {});
  res.writeHead(instructions.status, headers);
  if (instructions.body === undefined) {
    res.end();
    return;
  }
  res.end(typeof instructions.body === "string" ? instructions.body : JSON.stringify(instructions.body));
}

async function getProviderServer({ serviceId, amount, network, description, mimeType }) {
  const routePattern = `POST /provider/x402/${serviceId}`;
  const key = JSON.stringify({
    serviceId,
    amount,
    network: normalizeX402Network(network),
    payTo: providerReceiveAddress(),
    facilitator: facilitatorUrl()
  });
  if (providerServers.has(key)) return providerServers.get(key);

  const facilitator = new HTTPFacilitatorClient({ url: facilitatorUrl() });
  const server = new x402ResourceServer(facilitator);
  registerExactEvmScheme(server, {});
  const httpServer = new x402HTTPResourceServer(server, {
    [routePattern]: {
      accepts: {
        scheme: "exact",
        price: formatX402Price(amount),
        network: normalizeX402Network(network),
        payTo: providerReceiveAddress()
      },
      resource: `agentrouter://${serviceId}`,
      description,
      mimeType,
      unpaidResponseBody: () => ({
        contentType: "application/json",
        body: {
          error: "Payment Required",
          service_id: serviceId,
          payment_backend: "x402"
        }
      })
    }
  });
  await httpServer.initialize();
  providerServers.set(key, httpServer);
  return httpServer;
}

function buildHttpContext({ req, serviceId }) {
  const host = req.headers.host || "127.0.0.1";
  const protocol = req.socket?.encrypted ? "https" : "http";
  const url = new URL(req.url || `/provider/custom/${serviceId}`, `${protocol}://${host}`);
  const adapter = {
    getHeader(name) {
      return req.headers[String(name).toLowerCase()];
    },
    getMethod() {
      return "POST";
    },
    getPath() {
      return `/provider/x402/${serviceId}`;
    },
    getUrl() {
      return `${protocol}://${host}${req.url || ""}`;
    },
    getAcceptHeader() {
      return req.headers.accept || "application/json";
    },
    getUserAgent() {
      return req.headers["user-agent"] || "";
    },
    getQueryParams() {
      return Object.fromEntries(url.searchParams.entries());
    },
    getQueryParam(name) {
      return url.searchParams.get(name) || undefined;
    }
  };
  return {
    adapter,
    path: `/provider/x402/${serviceId}`,
    method: "POST"
  };
}

function facilitatorUrl() {
  return process.env.ADN_X402_FACILITATOR_URL || "https://x402.org/facilitator";
}

function providerReceiveAddress() {
  return process.env.ADN_PROVIDER_RECEIVE_ADDRESS || process.env.ADN_X402_PAY_TO || "0xProviderDemoWallet000000000000000000000000";
}

function normalizeX402Network(network) {
  if (/^eip155:/i.test(String(network))) return String(network);
  if (String(network).toLowerCase() === "base") return "eip155:8453";
  if (String(network).toLowerCase() === "base-sepolia") return "eip155:84532";
  return String(network || "eip155:8453");
}

function formatX402Price(amount) {
  if (typeof amount === "string" && amount.trim().startsWith("$")) return amount.trim();
  return `$${amount}`;
}

function normalizeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, String(value)]));
}
