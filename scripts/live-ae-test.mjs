import { spawn } from "node:child_process";

const child = spawn("node", ["build/index.js"], {
  cwd: new URL("..", import.meta.url),
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
  },
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

function parseResponses() {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "after-effect-mcp-live-test", version: "0.0.0" },
  },
});

await new Promise((resolve) => setTimeout(resolve, 300));
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: {
    name: "ae_project_summary",
    arguments: { timeoutMs: 30000 },
  },
});

await new Promise((resolve) => setTimeout(resolve, 35000));
child.kill();
await new Promise((resolve) => child.on("close", resolve));

const responses = parseResponses();
const toolResponse = responses.find((response) => response.id === 2);
if (!toolResponse || toolResponse.error) {
  console.error("Live AE test failed.");
  console.error("stdout:");
  console.error(stdout);
  console.error("stderr:");
  console.error(stderr);
  process.exit(1);
}

const text = toolResponse.result?.content?.[0]?.text || "";
if (text.includes("After Effects inspection failed") || text.includes("did not write a result file")) {
  console.error("Live AE test reached MCP, but After Effects did not return a project summary.");
  console.error(text);
  process.exit(1);
}

console.error("Live AE test passed. After Effects returned a project summary through MCP.");
