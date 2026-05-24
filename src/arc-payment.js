import { createPublicClient, createWalletClient, decodeFunctionData, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const ARC_TESTNET = {
  id: 5042002,
  name: "Arc Testnet",
  network: "arc-testnet",
  caip2: "eip155:5042002",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.ADN_ARC_RPC_URL || "https://rpc.testnet.arc.network"] },
    public: { http: [process.env.ADN_ARC_RPC_URL || "https://rpc.testnet.arc.network"] }
  },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" }
  },
  testnet: true
};

export const ARC_USDC_ADDRESS = "0x3600000000000000000000000000000000000000";
export const ARC_USDC_DECIMALS = 6;

const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" }
    ],
    outputs: [{ name: "", type: "bool" }]
  }
];

export function isArcNetwork(network) {
  const normalized = String(network || "").toLowerCase();
  return normalized === "arc" || normalized === "arc-testnet" || normalized === "eip155:5042002" || normalized === "5042002";
}

export function normalizeArcNetwork(network) {
  return isArcNetwork(network) ? "arc-testnet" : String(network || "arc-testnet");
}

export function arcAmountAtomic(amount) {
  return parseUnits(String(amount), ARC_USDC_DECIMALS);
}

export function isEvmAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ""));
}

export async function sendArcUsdcTransfer({ wallet, payment }) {
  if (!wallet?.private_key_hex) {
    throw new Error("Local EVM wallet is missing private_key_hex for Arc USDC transfer.");
  }
  if (!isEvmAddress(payment?.pay_to)) {
    throw new Error("Provider payment target must be a valid EVM address for Arc settlement.");
  }
  if (process.env.ADN_ARC_TRANSFER_MODE === "mock") {
    const amountAtomic = arcAmountAtomic(payment.amount);
    return {
      tx_hash: `0x${"a".repeat(64)}`,
      chain_id: ARC_TESTNET.id,
      network: "arc-testnet",
      asset: "USDC",
      token_address: ARC_USDC_ADDRESS,
      amount: payment.amount,
      amount_atomic: amountAtomic.toString(),
      payer: wallet.address,
      pay_to: payment.pay_to,
      explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/0x${"a".repeat(64)}`,
      mock: true
    };
  }
  const account = privateKeyToAccount(wallet.private_key_hex);
  const client = createWalletClient({
    account,
    chain: ARC_TESTNET,
    transport: http(ARC_TESTNET.rpcUrls.default.http[0])
  });
  const amountAtomic = arcAmountAtomic(payment.amount);
  const txHash = await client.writeContract({
    address: ARC_USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [payment.pay_to, amountAtomic]
  });
  return {
    tx_hash: txHash,
    chain_id: ARC_TESTNET.id,
    network: "arc-testnet",
    asset: "USDC",
    token_address: ARC_USDC_ADDRESS,
    amount: payment.amount,
    amount_atomic: amountAtomic.toString(),
    payer: account.address,
    pay_to: payment.pay_to,
    explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/${txHash}`
  };
}

export async function verifyArcUsdcTransfer({ txHash, expected }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ""))) {
    return { ok: false, error: "INVALID_ARC_TX_HASH" };
  }
  if (process.env.ADN_ARC_VERIFY_MODE === "mock") {
    return {
      ok: true,
      mock: true,
      tx_hash: txHash,
      chain_id: ARC_TESTNET.id,
      token_address: ARC_USDC_ADDRESS,
      amount_atomic: arcAmountAtomic(expected.amount).toString(),
      pay_to: expected.payTo,
      payer: expected.payer || null
    };
  }

  const client = createPublicClient({
    chain: ARC_TESTNET,
    transport: http(ARC_TESTNET.rpcUrls.default.http[0])
  });
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: txHash }),
    client.getTransactionReceipt({ hash: txHash })
  ]);
  if (receipt.status !== "success") {
    return { ok: false, error: "ARC_TX_NOT_SUCCESS", receipt_status: receipt.status };
  }
  if (tx.to?.toLowerCase() !== ARC_USDC_ADDRESS.toLowerCase()) {
    return { ok: false, error: "ARC_TX_NOT_USDC_TRANSFER", tx_to: tx.to };
  }
  const decoded = decodeFunctionData({ abi: ERC20_ABI, data: tx.input });
  if (decoded.functionName !== "transfer") {
    return { ok: false, error: "ARC_TX_NOT_TRANSFER_CALL", function_name: decoded.functionName };
  }
  const [to, value] = decoded.args;
  const expectedAmount = arcAmountAtomic(expected.amount);
  if (String(to).toLowerCase() !== String(expected.payTo).toLowerCase()) {
    return { ok: false, error: "ARC_PAYMENT_TARGET_MISMATCH", pay_to: to, expected_pay_to: expected.payTo };
  }
  if (value !== expectedAmount) {
    return { ok: false, error: "ARC_PAYMENT_AMOUNT_MISMATCH", amount_atomic: value.toString(), expected_amount_atomic: expectedAmount.toString() };
  }
  if (expected.payer && tx.from.toLowerCase() !== expected.payer.toLowerCase()) {
    return { ok: false, error: "ARC_PAYMENT_PAYER_MISMATCH", payer: tx.from, expected_payer: expected.payer };
  }
  return {
    ok: true,
    tx_hash: txHash,
    chain_id: ARC_TESTNET.id,
    token_address: ARC_USDC_ADDRESS,
    amount_atomic: value.toString(),
    payer: tx.from,
    pay_to: to,
    block_number: receipt.blockNumber.toString(),
    explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/${txHash}`
  };
}
