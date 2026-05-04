import { existsSync, readdirSync, copyFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import os from "node:os";

/**
 * Shared setup logic that can be called from CLI or as a module.
 */
export async function runSetup() {
  // Use import.meta.url to find project root when running as a module in build/
  const currentFile = fileURLToPath(import.meta.url);
  const projectRoot = resolve(dirname(dirname(currentFile)));
  
  const panels = ["mcp-connection-panel.jsx", "mcp-http-bridge.jsx"];

  function findAfterEffectsSupportDir() {
    if (process.platform === "win32") {
      const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean) as string[];
      for (const root of roots) {
        const adobeRoot = join(root, "Adobe");
        if (!existsSync(adobeRoot)) continue;
        for (const entry of readdirSync(adobeRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("Adobe After Effects")) continue;
          const supportDir = join(adobeRoot, entry.name, "Support Files");
          if (existsSync(supportDir)) return supportDir;
        }
      }
    }

    if (process.platform === "darwin") {
      const appRoot = "/Applications";
      if (existsSync(appRoot)) {
        for (const entry of readdirSync(appRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("Adobe After Effects")) continue;
          return join(appRoot, entry.name);
        }
      }
    }
    return null;
  }

  function getClaudeConfigPath() {
    if (process.platform === "win32") {
      return join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json");
    }
    if (process.platform === "darwin") {
      return join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    }
    return null;
  }

  console.log("🚀 Starting After Effects MCP Auto-Setup...");

  // 1. Copy Panels
  const aeSupportDir = findAfterEffectsSupportDir();
  if (aeSupportDir) {
    const scriptUiDir = join(aeSupportDir, "Scripts", "ScriptUI Panels");
    if (!existsSync(scriptUiDir)) {
      console.log(`📂 Creating ScriptUI Panels directory: ${scriptUiDir}`);
      mkdirSync(scriptUiDir, { recursive: true });
    }

    for (const panel of panels) {
      const src = join(projectRoot, panel);
      const dest = join(scriptUiDir, panel);
      try {
        if (existsSync(src)) {
          copyFileSync(src, dest);
          console.log(`✅ Copied ${panel} to AE ScriptUI Panels.`);
        }
      } catch (e) {
        console.warn(`⚠️ Could not copy ${panel} to AE. (Permission issue?)`);
      }
    }
  } else {
    console.warn("⚠️ Could not find After Effects installation to copy ScriptUI panels.");
  }

  // 2. Update Claude Config
  const claudePath = getClaudeConfigPath();
  if (claudePath && existsSync(dirname(claudePath))) {
    let config: any = { mcpServers: {} };
    if (existsSync(claudePath)) {
      try {
        config = JSON.parse(readFileSync(claudePath, "utf8"));
      } catch (e) {
        console.error(`⚠️ Could not parse Claude config at ${claudePath}. Skipping auto-injection.`);
      }
    }

    config.mcpServers = config.mcpServers || {};
    config.mcpServers["after-effects"] = {
      command: "node",
      args: [join(projectRoot, "build", "index.js")],
      env: {
        MCP_ALLOWED_DIRS: projectRoot
      }
    };

    try {
      writeFileSync(claudePath, JSON.stringify(config, null, 2), "utf8");
      console.log(`✅ Updated Claude Desktop configuration at ${claudePath}`);
    } catch (e) {
      console.error(`⚠️ Could not write to Claude config at ${claudePath}.`);
    }
  } else {
    console.log("ℹ️ Claude Desktop not found. Skipping config injection.");
  }

  console.log("\n🎉 Setup complete! Restart After Effects and Claude Desktop to begin.");
  console.log("👉 Don't forget to enable 'Allow Scripts to Write Files and Access Network' in AE Preferences.");
}

/**
 * Reverts changes made by runSetup.
 */
export async function runUninstall() {
  const currentFile = fileURLToPath(import.meta.url);
  const projectRoot = resolve(dirname(dirname(currentFile)));
  const panels = ["mcp-connection-panel.jsx", "mcp-http-bridge.jsx"];

  function findAfterEffectsSupportDir() {
    if (process.platform === "win32") {
      const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean) as string[];
      for (const root of roots) {
        const adobeRoot = join(root, "Adobe");
        if (!existsSync(adobeRoot)) continue;
        for (const entry of readdirSync(adobeRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("Adobe After Effects")) continue;
          const supportDir = join(adobeRoot, entry.name, "Support Files");
          if (existsSync(supportDir)) return supportDir;
        }
      }
    }
    if (process.platform === "darwin") {
      const appRoot = "/Applications";
      if (existsSync(appRoot)) {
        for (const entry of readdirSync(appRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("Adobe After Effects")) continue;
          return join(appRoot, entry.name);
        }
      }
    }
    return null;
  }

  function getClaudeConfigPath() {
    if (process.platform === "win32") {
      return join(process.env.APPDATA || "", "Claude", "claude_desktop_config.json");
    }
    if (process.platform === "darwin") {
      return join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
    }
    return null;
  }

  console.log("🗑️ Starting After Effects MCP Uninstall...");

  // 1. Remove Panels
  const aeSupportDir = findAfterEffectsSupportDir();
  if (aeSupportDir) {
    const scriptUiDir = join(aeSupportDir, "Scripts", "ScriptUI Panels");
    for (const panel of panels) {
      const dest = join(scriptUiDir, panel);
      if (existsSync(dest)) {
        try {
          import("node:fs").then(fs => fs.unlinkSync(dest));
          console.log(`✅ Removed ${panel} from AE ScriptUI Panels.`);
        } catch (e) {
          console.warn(`⚠️ Could not remove ${panel} from AE.`);
        }
      }
    }
  }

  // 2. Remove from Claude Config
  const claudePath = getClaudeConfigPath();
  if (claudePath && existsSync(claudePath)) {
    try {
      const config = JSON.parse(readFileSync(claudePath, "utf8"));
      if (config.mcpServers && config.mcpServers["after-effects"]) {
        delete config.mcpServers["after-effects"];
        writeFileSync(claudePath, JSON.stringify(config, null, 2), "utf8");
        console.log(`✅ Removed 'after-effects' from Claude Desktop configuration.`);
      }
    } catch (e) {
      console.error(`⚠️ Could not update Claude config at ${claudePath}.`);
    }
  }

  console.log("\n✨ Uninstall complete. You can now safely delete the project folder.");
}
