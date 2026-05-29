#!/usr/bin/env node
import { readPaymentLog } from "../src/wallet.js";
import { getArcUsdcBalance, verifyArcUsdcTransfer } from "../src/arc-payment.js";

const args = parseArgs(process.argv.slice(2));
const target = String(args.address || process.env.ADN_PROVIDER_RECEIVE_ADDRESS || "0x2c4d600a04c0d3bbb1e3cc8a13e54e21c2b6c0bb").toLowerCase();
const limit = Number(args.limit || 20);

if (!/^0x[0-9a-f]{40}$/.test(target)) {
  console.error("Provider address must be a valid EVM address.");
  process.exit(1);
}

const events = await readPaymentLog();
const matching = events
  .filter((event) => String(event.pay_to || "").toLowerCase() === target)
  .slice(-Math.max(1, Math.min(100, limit)));
const balance = await getArcUsdcBalance(target);
const audited = [];

for (const event of matching) {
  const isMock = event.arc_transfer?.mock || event.balance_before_payment?.mock || event.payment_tx === `0x${"a".repeat(64)}`;
  let chain_verification = null;
  if (!isMock && /^0x[0-9a-fA-F]{64}$/.test(String(event.payment_tx || ""))) {
    try {
      chain_verification = await verifyArcUsdcTransfer({
        txHash: event.payment_tx,
        expected: {
          amount: event.amount,
          payTo: event.pay_to,
          payer: event.payer
        }
      });
    } catch (error) {
      chain_verification = { ok: false, error: error.message };
    }
  }
  audited.push({
    created_at: event.created_at,
    service_id: event.service_id,
    status: event.status,
    amount: event.amount,
    currency: event.currency,
    payer: event.payer,
    pay_to: event.pay_to,
    payment_tx: event.payment_tx,
    explorer_url: event.arc_transfer?.explorer_url || null,
    local_event_is_mock: Boolean(isMock),
    chain_verification
  });
}

const realSettled = audited.filter((event) => event.chain_verification?.ok);
const mockOnly = audited.filter((event) => event.local_event_is_mock);

console.log(JSON.stringify({
  ok: true,
  audit_version: "agentrouter_payment_audit_v1",
  provider_address: target,
  arc_usdc_balance: balance,
  payment_log_events: events.length,
  matching_events: matching.length,
  real_verified_transfers: realSettled.length,
  mock_only_events: mockOnly.length,
  audited
}, null, 2));

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--address") parsed.address = argv[++i];
    else if (arg === "--limit") parsed.limit = argv[++i];
  }
  return parsed;
}
