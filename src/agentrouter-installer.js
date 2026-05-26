import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDir, "..");

export const DEFAULT_AGENT_ROUTER_URL = "https://agentrouter.network";
export const DEFAULT_PACKAGE_SPEC = "github:connectwilson/agentrouter-markets#main";
export const DEFAULT_ARC_RPC_URL = "https://rpc.testnet.arc.network";

export async function installAgentRouter(options = {}) {
  const home = options.home || os.homedir();
  const agentRouterUrl = trimTrailingSlash(options.agentRouterUrl || process.env.AGENT_ROUTER_URL || DEFAULT_AGENT_ROUTER_URL);
  const maxPrice = String(options.maxPrice || process.env.AGENT_ROUTER_MAX_PRICE || "0.05");
  const arcRpcUrl = options.arcRpcUrl || process.env.ADN_ARC_RPC_URL || DEFAULT_ARC_RPC_URL;
  const packageSpec = options.packageSpec || process.env.AGENTROUTER_MCP_PACKAGE || DEFAULT_PACKAGE_SPEC;
  const adnDir = path.resolve(options.adnDir || process.env.AGENTROUTER_ADN_DIR || path.join(home, ".agentrouter", "adn"));
  const clients = normalizeClients(options.clients || parseClients(process.env.AGENTROUTER_CLIENT));
  const result = {
    ok: true,
    agent_router_url: agentRouterUrl,
    skill_paths: [],
    configured_clients: [],
    skipped_clients: [],
    wallet: null,
    next_steps: []
  };

  if (options.installSkill !== false) {
    const skillText = await loadSkillMarkdown({
      skillText: options.skillText,
      skillUrl: options.skillUrl || `${agentRouterUrl}/skills/AgentRouter/SKILL.md`
    });
    const skillDirs = resolveSkillDirs({ home, value: options.skillDirs || process.env.AGENTROUTER_SKILL_DIRS });
    for (const skillDir of skillDirs) {
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, "SKILL.md"), skillText);
      result.skill_paths.push(skillDir);
    }
  }

  const mcpServer = createMcpServerConfig({ agentRouterUrl, maxPrice, arcRpcUrl, adnDir, packageSpec });
  const claudeConfig = options.claudeConfig || process.env.CLAUDE_DESKTOP_CONFIG || path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  const cursorConfig = options.cursorConfig || process.env.CURSOR_MCP_CONFIG || path.join(home, ".cursor", "mcp.json");

  if (await shouldConfigureClient({ client: "claude-desktop", clients, configPath: claudeConfig, forceEnv: process.env.AGENTROUTER_CONFIGURE_CLAUDE_DESKTOP })) {
    await writeMcpConfig(claudeConfig, mcpServer);
    result.configured_clients.push({ name: "Claude Desktop", config_path: claudeConfig });
  } else {
    result.skipped_clients.push({ name: "Claude Desktop", reason: "config directory not found" });
  }

  if (await shouldConfigureClient({ client: "cursor", clients, configPath: cursorConfig, forceEnv: process.env.AGENTROUTER_CONFIGURE_CURSOR })) {
    await writeMcpConfig(cursorConfig, mcpServer);
    result.configured_clients.push({ name: "Cursor", config_path: cursorConfig });
  } else {
    result.skipped_clients.push({ name: "Cursor", reason: "config directory not found" });
  }

  if (options.createWallet !== false) {
    result.wallet = await createLocalWallet({ adnDir, cwd: options.cwd || repoRoot });
  }

  if (result.configured_clients.length) {
    result.next_steps.push("Restart or reload the configured AI client to activate AgentRouter MCP tools.");
  } else {
    result.next_steps.push("No desktop MCP config was changed. Rerun with --client cursor, --client claude-desktop, or --client all to force a client config.");
  }
  if (result.wallet?.address) {
    result.next_steps.push(`Fund ${result.wallet.address} with Arc Testnet USDC before the first paid data call.`);
  } else {
    result.next_steps.push("After MCP starts, call agentrouter_wallet_status to see the funding address.");
  }
  result.next_steps.push("Then ask a normal data/API question; AgentRouter is available as the routing tool.");

  return result;
}

export function formatInstallResult(result) {
  const lines = [];
  lines.push("AgentRouter installed.");
  if (result.skill_paths?.length) {
    lines.push(`Skill installed: ${result.skill_paths.join(", ")}`);
  }
  if (result.configured_clients?.length) {
    for (const client of result.configured_clients) {
      lines.push(`${client.name} MCP configured: ${client.config_path}`);
    }
  }
  if (result.wallet?.address) {
    lines.push("AgentRouter local payment wallet ready.");
    lines.push(`Fund address: ${result.wallet.address}`);
    lines.push("Network: Arc Testnet");
    lines.push("Token: USDC");
    lines.push("Suggested first top-up: 0.05 USDC");
  } else if (result.wallet?.error) {
    lines.push(`Wallet was not created automatically: ${result.wallet.error}`);
  }
  for (const nextStep of result.next_steps || []) {
    lines.push(nextStep);
  }
  lines.push(`Remote MCP: ${trimTrailingSlash(result.agent_router_url)}/mcp`);
  return `${lines.join("\n")}\n`;
}

export function parseInstallArgs(argv) {
  const options = { clients: [] };
  const args = [...argv];
  if (args[0] === "install") args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--client") {
      options.clients.push(requireValue(args[++i], "--client"));
    } else if (arg.startsWith("--client=")) {
      options.clients.push(arg.slice("--client=".length));
    } else if (arg === "--url") {
      options.agentRouterUrl = requireValue(args[++i], "--url");
    } else if (arg.startsWith("--url=")) {
      options.agentRouterUrl = arg.slice("--url=".length);
    } else if (arg === "--max-price") {
      options.maxPrice = requireValue(args[++i], "--max-price");
    } else if (arg.startsWith("--max-price=")) {
      options.maxPrice = arg.slice("--max-price=".length);
    } else if (arg === "--adn-dir") {
      options.adnDir = requireValue(args[++i], "--adn-dir");
    } else if (arg.startsWith("--adn-dir=")) {
      options.adnDir = arg.slice("--adn-dir=".length);
    } else if (arg === "--skill-url") {
      options.skillUrl = requireValue(args[++i], "--skill-url");
    } else if (arg.startsWith("--skill-url=")) {
      options.skillUrl = arg.slice("--skill-url=".length);
    } else if (arg === "--no-wallet") {
      options.createWallet = false;
    } else if (arg === "--no-skill") {
      options.installSkill = false;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

export function installUsage() {
  return `Usage:
  agentrouter
  agentrouter install
  agentrouter install --client cursor
  agentrouter install --client claude-desktop
  agentrouter install --client all

Options:
  --url <url>        AgentRouter server URL. Default: https://agentrouter.network
  --max-price <n>   Default max price per data call in USDC. Default: 0.05
  --adn-dir <path>  Local AgentRouter wallet/payment directory.
  --no-wallet       Install skill/config only.
  --no-skill        Configure MCP/wallet only.
`;
}

async function loadSkillMarkdown({ skillText, skillUrl }) {
  if (skillText) return skillText;
  try {
    const response = await fetch(skillUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    const fallbackPath = path.join(repoRoot, "claude-skills", "agent-router", "SKILL.md");
    try {
      return await fs.readFile(fallbackPath, "utf8");
    } catch {
      throw new Error(`Unable to fetch AgentRouter Skill from ${skillUrl}: ${error.message}`);
    }
  }
}

function resolveSkillDirs({ home, value }) {
  if (value) {
    return value.split(path.delimiter).map((item) => item.trim()).filter(Boolean).map((item) => expandHome(item, home));
  }
  return [
    path.join(home, ".agents", "skills", "agentrouter"),
    path.join(home, ".claude", "skills", "agentrouter"),
    path.join(home, ".codex", "skills", "agentrouter")
  ];
}

function createMcpServerConfig({ agentRouterUrl, maxPrice, arcRpcUrl, adnDir, packageSpec }) {
  return {
    command: "npx",
    args: ["-y", "--package", packageSpec, "agent-router-mcp"],
    env: {
      AGENT_ROUTER_URL: agentRouterUrl,
      AGENT_ROUTER_MAX_PRICE: maxPrice,
      ADN_PAYMENT_BACKEND: "circle_arc",
      ADN_ARC_RPC_URL: arcRpcUrl,
      ADN_DIR: adnDir
    }
  };
}

async function shouldConfigureClient({ client, clients, configPath, forceEnv }) {
  if (forceEnv === "1" || forceEnv === "true") return true;
  if (forceEnv === "0" || forceEnv === "false") return false;
  if (clients.has("all") || clients.has(client)) return true;
  return directoryExists(path.dirname(configPath));
}

async function writeMcpConfig(configPath, serverConfig) {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  let config = {};
  if (await fileExists(configPath)) {
    try {
      config = JSON.parse(await fs.readFile(configPath, "utf8") || "{}");
      await fs.copyFile(configPath, `${configPath}.bak.${timestamp()}`);
    } catch {
      await fs.copyFile(configPath, `${configPath}.invalid.${Date.now()}`);
      config = {};
    }
  }
  config.mcpServers = config.mcpServers && typeof config.mcpServers === "object" ? config.mcpServers : {};
  config.mcpServers.AgentRouter = serverConfig;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

async function createLocalWallet({ adnDir, cwd }) {
  const adnBin = path.join(repoRoot, "bin", "adn.js");
  try {
    const { stdout } = await execFileAsync(process.execPath, [adnBin, "wallet", "create-session"], {
      cwd,
      env: { ...process.env, ADN_DIR: adnDir },
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    const payload = JSON.parse(stdout || "{}");
    return {
      ok: true,
      address: payload.address,
      network: "Arc Testnet",
      token: "USDC",
      wallet_path: path.join(adnDir, "wallet.json")
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      network: "Arc Testnet",
      token: "USDC"
    };
  }
}

function parseClients(value) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeClients(value) {
  const rawItems = Array.isArray(value) ? value : [value].filter(Boolean);
  const normalized = new Set();
  for (const rawItem of rawItems.flatMap((item) => String(item).split(","))) {
    const item = rawItem.trim().toLowerCase();
    if (!item) continue;
    if (["claude", "claude-desktop", "claude_desktop"].includes(item)) normalized.add("claude-desktop");
    else if (["cursor"].includes(item)) normalized.add("cursor");
    else if (item === "all") normalized.add("all");
    else normalized.add(item);
  }
  return normalized;
}

async function directoryExists(dirPath) {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function expandHome(value, home) {
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function trimTrailingSlash(value) {
  return String(value || "").replace(/\/$/, "");
}

function timestamp() {
  return new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
}

function requireValue(value, name) {
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}
