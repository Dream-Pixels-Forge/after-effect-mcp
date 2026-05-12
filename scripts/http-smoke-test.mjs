import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const port = process.env.AE_MCP_HTTP_PORT || "3929";
const url = new URL(`http://127.0.0.1:${port}/mcp`);

const child = spawn("node", ["build/http-bridge.js"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, AE_MCP_HTTP_PORT: port },
  stdio: ["ignore", "ignore", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

try {
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const client = new Client({
    name: "after-effect-mcp-http-smoke-test",
    version: "0.0.0",
  });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);

  const tools = await client.listTools();
  const toolNames = tools.tools.map((tool) => tool.name);
  const requiredTools = ["ae_eval", "ae_project_summary", "ae_list_comps", "ae_add_text_layer"];
  const missing = requiredTools.filter((name) => !toolNames.includes(name));
  await client.close();

  if (missing.length > 0) {
    console.error(`HTTP smoke test failed. Missing tools: ${missing.join(", ")}`);
    console.error(stderr);
    process.exit(1);
  }

  console.error("HTTP smoke test passed. MCP tools are discoverable over Streamable HTTP.");
} finally {
  child.kill();
  await new Promise((resolve) => child.on("close", resolve));
}
