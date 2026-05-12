import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(projectRoot, "build", "index.js");

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...valueParts] = arg.replace(/^--/, "").split("=");
    return [key, valueParts.join("=") || "true"];
  }),
);

const dryRun = args.get("dry-run") === "true";
const clients = (args.get("clients") || "codex,opencode,gemini,qwen")
  .split(",")
  .map((client) => client.trim().toLowerCase())
  .filter(Boolean);
const allowedDirs = args.get("allowed-dir") || process.env.MCP_ALLOWED_DIRS || projectRoot;
const afterFxPath = args.get("afterfx-path") || process.env.AFTERFX_PATH || findAfterEffectsExecutable();

function findAfterEffectsExecutable() {
  if (process.env.AFTER_EFFECTS_PATH && existsSync(process.env.AFTER_EFFECTS_PATH)) {
    return process.env.AFTER_EFFECTS_PATH;
  }

  if (process.platform === "win32") {
    const drives = ["C:", "D:", "E:", "F:"].filter((drive) => existsSync(drive));
    for (const drive of drives) {
      const adobeRoot = join(drive, "Program Files", "Adobe");
      if (!existsSync(adobeRoot)) continue;
      for (const entry of readdirSync(adobeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("Adobe After Effects")) continue;
        const afterfxExe = join(adobeRoot, entry.name, "Support Files", "AfterFX.exe");
        const afterfxCom = join(adobeRoot, entry.name, "Support Files", "afterfx.com");
        if (existsSync(afterfxExe)) return afterfxExe;
        if (existsSync(afterfxCom)) return afterfxCom;
      }
    }
  }

  if (process.platform === "darwin") {
    const appRoot = "/Applications";
    if (!existsSync(appRoot)) return undefined;
    for (const entry of readdirSync(appRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("Adobe After Effects")) continue;
      const appName = entry.name.replace(/\.app$/, "");
      const candidate = join(appRoot, entry.name, "Contents", "MacOS", appName);
      if (existsSync(candidate)) return candidate;
    }
  }

  return undefined;
}

function stripJsonComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function readJsonConfig(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(stripJsonComments(readFileSync(path, "utf8")));
}

function writeConfig(path, content) {
  if (dryRun) {
    console.log(`\n--- ${path} ---\n${redactSensitiveValues(content)}`);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  console.log(`Updated ${path}`);
}

function redactSensitiveValues(content) {
  return content
    .replace(
      /("(?:[^"]*(?:api[_-]?key|token|secret|password)[^"]*)"\s*:\s*")([^"]+)(")/gi,
      "$1<redacted>$3",
    )
    .replace(
      /((?:api[_-]?key|token|secret|password)[A-Z0-9_]*\s*=\s*['"])([^'"]+)(['"])/gi,
      "$1<redacted>$3",
    );
}

function serverEnv() {
  const env = { MCP_ALLOWED_DIRS: allowedDirs };
  if (afterFxPath) env.AFTERFX_PATH = afterFxPath;
  return env;
}

function standardMcpServer() {
  return {
    command: "node",
    args: [serverPath],
    env: serverEnv(),
  };
}

function installJsonMcp(path, serverName) {
  const config = readJsonConfig(path, {});
  config.mcpServers = config.mcpServers || {};
  config.mcpServers[serverName] = standardMcpServer();
  writeConfig(path, `${JSON.stringify(config, null, 2)}\n`);
}

function installCodex() {
  const path = join(os.homedir(), ".codex", "config.toml");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const withoutServer = existing
    .replace(/\n?\[mcp_servers\.after_effects\][\s\S]*?(?=\n\[[^\]]+\]|\s*$)/g, "")
    .replace(/\n?\[mcp_servers\.after_effects\.env\][\s\S]*?(?=\n\[[^\]]+\]|\s*$)/g, "")
    .trimEnd();

  const block = [
    "[mcp_servers.after_effects]",
    'command = "node"',
    `args = ['${serverPath.replaceAll("\\", "\\\\")}']`,
    "enabled = true",
    "",
    "[mcp_servers.after_effects.env]",
    `MCP_ALLOWED_DIRS = '${allowedDirs.replaceAll("'", "\\'")}'`,
    ...(afterFxPath ? [`AFTERFX_PATH = '${afterFxPath.replaceAll("'", "\\'")}'`] : []),
    "",
  ].join("\n");

  writeConfig(path, `${withoutServer}${withoutServer ? "\n\n" : ""}${block}`);
}

function installOpenCode() {
  const path = join(os.homedir(), ".config", "opencode", "opencode.json");
  const config = readJsonConfig(path, { $schema: "https://opencode.ai/config.json" });
  config.$schema = config.$schema || "https://opencode.ai/config.json";
  config.mcp = config.mcp || {};
  config.mcp.after_effects = {
    type: "local",
    command: ["node", serverPath],
    enabled: true,
    environment: serverEnv(),
  };
  writeConfig(path, `${JSON.stringify(config, null, 2)}\n`);
}

function installGemini() {
  installJsonMcp(join(os.homedir(), ".gemini", "settings.json"), "after-effects");
}

function installQwen() {
  installJsonMcp(join(os.homedir(), ".qwen", "settings.json"), "after-effects");
}

const installers = {
  codex: installCodex,
  opencode: installOpenCode,
  gemini: installGemini,
  qwen: installQwen,
};

if (!existsSync(serverPath)) {
  console.warn(`Build output not found: ${serverPath}`);
  console.warn("Run pnpm build before using the installed MCP configuration.");
}

for (const client of clients) {
  const install = installers[client];
  if (!install) {
    console.warn(`Skipping unknown client: ${client}`);
    continue;
  }
  install();
}

console.log("\nDone. Restart the configured clients so they discover after-effect-mcp.");
console.log("ChatGPT Desktop is not configured by this script because ChatGPT requires a remote HTTP/SSE MCP server, not local stdio.");
