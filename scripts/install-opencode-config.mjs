import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const targetPath = resolve(process.argv[2] || "opencode.jsonc");
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = resolve(projectRoot, "build/index.js");
const afterFxPath = process.env.AFTERFX_PATH;

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

let config = { $schema: "https://opencode.ai/config.json" };
if (existsSync(targetPath)) {
  try {
    config = JSON.parse(stripJsonComments(readFileSync(targetPath, "utf8")));
  } catch (error) {
    console.error(`Could not parse ${targetPath}: ${error.message}`);
    console.error("Pass a clean JSON/JSONC config path or edit examples/opencode.jsonc manually.");
    process.exit(1);
  }
}

config.$schema = config.$schema || "https://opencode.ai/config.json";
config.mcp = config.mcp || {};
config.mcp.after_effects = {
  type: "local",
  command: ["node", serverPath],
  enabled: true,
  timeout: 10000,
};

if (afterFxPath) {
  config.mcp.after_effects.environment = {
    AFTERFX_PATH: afterFxPath,
  };
}

writeFileSync(targetPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.error(`OpenCode MCP config written to ${targetPath}`);
