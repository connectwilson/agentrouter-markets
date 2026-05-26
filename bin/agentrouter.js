#!/usr/bin/env node
import { formatInstallResult, installAgentRouter, installUsage, parseInstallArgs } from "../src/agentrouter-installer.js";

try {
  const options = parseInstallArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(installUsage());
    process.exit(0);
  }
  const result = await installAgentRouter(options);
  process.stdout.write(formatInstallResult(result));
} catch (error) {
  process.stderr.write(`AgentRouter install failed: ${error.message}\n\n${installUsage()}`);
  process.exit(1);
}
