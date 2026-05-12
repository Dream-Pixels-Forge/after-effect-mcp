#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { checkAuth } from "./security.js";
import { createAfterEffectsMcpServer } from "./mcp-server.js";

async function main() {
  // Support 'npx after-effect-mcp setup'
  if (process.argv.includes("setup")) {
    console.log("🛠️ Starting After Effects MCP Setup...");
    try {
      const { runSetup } = await import("./setup-helper.js");
      await runSetup();
      return;
    } catch (e) {
      console.error("❌ Setup failed:", e);
      process.exit(1);
    }
  }

  // Support 'npx after-effect-mcp uninstall'
  if (process.argv.includes("uninstall")) {
    console.log("🗑️ Starting After Effects MCP Uninstall...");
    try {
      const { runUninstall } = await import("./setup-helper.js");
      await runUninstall();
      return;
    } catch (e) {
      console.error("❌ Uninstall failed:", e);
      process.exit(1);
    }
  }

  // Support 'npx after-effect-mcp http'
  if (process.argv.includes("http") || process.argv.includes("start:http")) {
    await import("./http-bridge.js");
    return;
  }

  // Security: Validate auth token if configured (CVE-011 fix)
  if (!checkAuth()) {
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  const server = createAfterEffectsMcpServer();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("after-effect-mcp failed:", error);
  process.exit(1);
});
