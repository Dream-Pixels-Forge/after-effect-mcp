import { spawn } from "node:child_process";

const child = spawn("node", ["build/index.js"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";

child.stdout.on("data", (chunk) => {
  stdout += chunk.toString("utf8");
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "after-effect-mcp-smoke-test", version: "0.0.0" },
  },
});

await new Promise((resolve) => setTimeout(resolve, 300));
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

await new Promise((resolve) => setTimeout(resolve, 1000));
child.kill();

await new Promise((resolve) => child.on("close", resolve));

const requiredTools = [
  "ae_eval",
  "ae_project_summary",
  "ae_list_comps",
  "ae_add_text_layer",
  "ae_add_solid",
  "ae_save_project",
  "ae_open_project",
  "ae_queue_render",
];
const toolListSeen = requiredTools.every((name) => stdout.includes(`"name":"${name}"`));
if (!toolListSeen) {
  console.error("Smoke test failed. stdout:");
  console.error(stdout);
  console.error("stderr:");
  console.error(stderr);
  process.exit(1);
}

console.error("Smoke test passed. MCP tools are discoverable.");
