export function getX402ProductionPlan() {
  return {
    status: "not_enabled_in_mvp",
    current_mode: process.env.ADN_PAYMENT_MODE || "dev",
    target_packages: [
      "@x402/core",
      "@x402/evm",
      "@x402/fetch"
    ],
    buyer_side: [
      "Replace createWalletPaymentProof with an x402 exact EVM client payment authorization.",
      "Use Alice's local Agent Wallet or a session wallet as the signer.",
      "Keep wallet policy checks before signing any x402 payload.",
      "Send the resulting x402 payment payload in the protocol-defined payment header."
    ],
    seller_side: [
      "Replace verifyDevPaymentProof with facilitator /verify and /settle calls.",
      "Set provider receiving wallet from manifest or ADN_PROVIDER_RECEIVE_ADDRESS.",
      "Return official x402 payment requirements in HTTP 402 responses.",
      "Only serve the resource after facilitator verification/settlement succeeds."
    ],
    facilitator: {
      default_url: process.env.ADN_X402_FACILITATOR_URL || "https://x402.org/facilitator",
      notes: "x402 docs describe facilitator /verify and /settle APIs; CDP and public facilitators can remove the need for providers to run blockchain infrastructure."
    }
  };
}
