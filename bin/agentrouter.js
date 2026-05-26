#!/usr/bin/env node
import { diagnoseAgentRouter, formatDoctorResult, formatInstallResult, installAgentRouter, installUsage, parseInstallArgs } from "../src/agentrouter-installer.js";

try {
  const options = parseInstallArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(installUsage());
    process.exit(0);
  }
  if (options.doctor) {
    const result = await diagnoseAgentRouter({
      agentRouterUrl: options.agentRouterUrl,
      adnDir: options.adnDir,
      skipNetwork: options.skipNetworkCheck === true
    });
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatDoctorResult(result));
    if (!result.ready) process.exitCode = 1;
  } else {
    const result = await installAgentRouter(options);
    process.stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatInstallResult(result));
    if (!result.ok) process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`AgentRouter install failed: ${error.message}\n\n${installUsage()}`);
  process.exit(1);
}
