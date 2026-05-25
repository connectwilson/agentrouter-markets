#!/usr/bin/env node
import fs from "node:fs";
import solc from "solc";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ARC_TESTNET } from "../src/arc-payment.js";

const privateKey = process.env.ADN_ARC_ANCHOR_PRIVATE_KEY || process.env.ADN_ERC8004_OWNER_PRIVATE_KEY || process.env.ADN_ERC8004_PRIVATE_KEY;
if (!privateKey) {
  throw new Error("Set ADN_ARC_ANCHOR_PRIVATE_KEY or ADN_ERC8004_OWNER_PRIVATE_KEY.");
}

const sourcePath = new URL("../contracts/AgentRouterEvidenceAnchor.sol", import.meta.url);
const source = fs.readFileSync(sourcePath, "utf8");
const input = {
  language: "Solidity",
  sources: {
    "AgentRouterEvidenceAnchor.sol": { content: source }
  },
  settings: {
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object"]
      }
    }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((item) => item.severity === "error");
if (errors.length) {
  throw new Error(errors.map((item) => item.formattedMessage).join("\n"));
}

const contract = output.contracts["AgentRouterEvidenceAnchor.sol"].AgentRouterEvidenceAnchor;
const bytecode = `0x${contract.evm.bytecode.object}`;
const account = privateKeyToAccount(normalizePrivateKey(privateKey));
const publicClient = createPublicClient({
  chain: ARC_TESTNET,
  transport: http(ARC_TESTNET.rpcUrls.default.http[0])
});
const walletClient = createWalletClient({
  account,
  chain: ARC_TESTNET,
  transport: http(ARC_TESTNET.rpcUrls.default.http[0])
});

const hash = await walletClient.deployContract({
  abi: contract.abi,
  bytecode
});
const receipt = await publicClient.waitForTransactionReceipt({
  hash,
  confirmations: 1,
  timeout: Number(process.env.ADN_ARC_RECEIPT_TIMEOUT_MS || 60000)
});

console.log(JSON.stringify({
  ok: true,
  network: "arc-testnet",
  chain_id: ARC_TESTNET.id,
  deployer: account.address,
  tx_hash: hash,
  contract_address: receipt.contractAddress,
  block_number: receipt.blockNumber?.toString?.(),
  explorer_url: `${ARC_TESTNET.blockExplorers.default.url}/tx/${hash}`
}, null, 2));

function normalizePrivateKey(value) {
  const trimmed = String(value || "").trim();
  return trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
}
