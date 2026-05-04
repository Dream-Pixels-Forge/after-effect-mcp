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
  
  // CEP extension files (no ScriptUI panels anymore)
  const cepFiles = ["manifest.json", "main.js", "index.html"];

  function findAfterEffectsSupportDir() {
    // First: Try to find from running After Effects process
    if (process.platform === "win32") {
      try {
        const ps = execSync(
          'powershell -Command "Get-Process -Name afterfx,AfterFX -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path"',
          { encoding: "utf8", timeout: 5000 }
        ).trim();
        if (ps && existsSync(ps)) {
          const supportDir = dirname(ps);
          const scriptUiDir = join(supportDir, "Scripts", "ScriptUI Panels");
          // Return Support Files directory
          if (existsSync(join(supportDir, "Scripts"))) {
            console.log(`📍 Detected running After Effects at: ${supportDir}`);
            return supportDir;
          }
        }
      } catch {
        // Fall through to standard search
      }
    }

    // Second: Search Program Files for AE installation
    if (process.platform === "win32") {
      // Search all drives A-Z for Adobe folder (slower but comprehensive)
      const driveLetters = "DEFGHIJKLMNOPQRSTUVWXYZ".split("");
      
      // First check common Program Files locations
      const commonRoots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean) as string[];
      for (const root of commonRoots) {
        const supportDir = findAdobeInFolder(root);
        if (supportDir) return supportDir;
      }
      
      // Then check other drives
      for (const drive of driveLetters) {
        if (drive === "C") continue; // Already checked
        const supportDir = findAdobeInFolder(`${drive}:\\Program Files`);
        if (supportDir) return supportDir;
        const supportDirX86 = findAdobeInFolder(`${drive}:\\Program Files (x86)`);
        if (supportDirX86) return supportDirX86;
      }
    }
    
    function findAdobeInFolder(basePath: string): string | null {
      const adobeRoot = join(basePath, "Adobe");
      if (!existsSync(adobeRoot)) return null;
      try {
        for (const entry of readdirSync(adobeRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("Adobe After Effects")) continue;
          const supportDir = join(adobeRoot, entry.name, "Support Files");
          if (existsSync(supportDir)) return supportDir;
        }
      } catch {
        // Skip inaccessible folders
      }
      return null;
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

  // 1. Copy CEP Extension
  const aeSupportDir = findAfterEffectsSupportDir();
  const cepDir = findCEPExtDir();
  if (aeSupportDir && cepDir) {
    const cepDestDir = join(cepDir, "AE-MCP-Bridge");
    if (!existsSync(cepDestDir)) {
      mkdirSync(cepDestDir, { recursive: true });
    }
    
    for (const file of cepFiles) {
      const src = join(projectRoot, "cep-extension", file);
      const dest = join(cepDestDir, file);
      try {
        if (existsSync(src)) {
          copyFileSync(src, dest);
          console.log(`✅ Copied CEP ${file} to AE CEP Extensions.`);
        }
      } catch (e) {
        console.warn(`⚠️ Could not copy CEP ${file}. (Permission issue?)`);
      }
    }
  }

  function findCEPExtDir() {
    if (!aeSupportDir) return null;
    
    // CEP extensions go in the CEPPlugIns folder
    const cepPlugIns = join(aeSupportDir, "CEPPlugIns");
    return cepPlugIns;
  }

  // 3. Update MCP Client Configurations
  const configs = [
    {
      name: "Claude Desktop",
      path: getClaudeConfigPath(),
      type: "mcpServers"
    },
    {
      name: "VSCode Cline",
      path: process.platform === "win32" 
        ? join(process.env.APPDATA || "", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
        : join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      type: "mcpServers"
    },
    {
      name: "VSCode Roo Code",
      path: process.platform === "win32" 
        ? join(process.env.APPDATA || "", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json")
        : join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json"),
      type: "mcpServers"
    },
    {
      name: "OpenCode Global",
      path: join(os.homedir(), ".config", "opencode", "opencode.json"),
      type: "mcp"
    },
    {
      name: "OpenCode Local",
      path: join(process.cwd(), "opencode.jsonc"),
      type: "mcp"
    }
  ];

  const isNpx = currentFile.includes("npx") || currentFile.includes(".npm");

  for (const configInfo of configs) {
    const configPath = configInfo.path;
    if (!configPath) continue;

    // For OpenCode Global, we always create it if it doesn't exist
    const shouldCreate = configInfo.name === "OpenCode Global";
    
    if (existsSync(configPath) || shouldCreate) {
      if (!existsSync(dirname(configPath))) {
        if (shouldCreate) mkdirSync(dirname(configPath), { recursive: true });
        else continue;
      }

      let config: any = {};
      if (configInfo.type === "mcpServers") {
        config = { mcpServers: {} };
      } else {
        config = { mcp: {} };
      }

      if (existsSync(configPath)) {
        try {
          const content = readFileSync(configPath, "utf8");
          // Simple JSONC handling (remove comments for parsing)
          const cleanJson = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
          config = JSON.parse(cleanJson);
        } catch (e) {
          console.error(`⚠️ Could not parse ${configInfo.name} config at ${configPath}. Skipping.`);
          continue;
        }
      }

      const mcpKey = configInfo.type;
      config[mcpKey] = config[mcpKey] || {};
      
      if (configInfo.type === "mcpServers") {
        if (isNpx) {
          config.mcpServers["after-effects"] = {
            command: "npx",
            args: ["-y", "after-effect-mcp"],
            env: { MCP_ALLOWED_DIRS: process.cwd() }
          };
        } else {
          config.mcpServers["after-effects"] = {
            command: "node",
            args: [join(projectRoot, "build", "index.js")],
            env: { MCP_ALLOWED_DIRS: projectRoot }
          };
        }
      } else {
        // OpenCode/Codex format
        if (isNpx) {
          config.mcp.after_effects = {
            type: "local",
            command: ["npx", "-y", "after-effect-mcp"],
            enabled: true,
            environment: { MCP_ALLOWED_DIRS: process.cwd() }
          };
        } else {
          config.mcp.after_effects = {
            type: "local",
            command: ["node", join(projectRoot, "build", "index.js")],
            enabled: true,
            environment: { MCP_ALLOWED_DIRS: projectRoot }
          };
        }
      }

      try {
        writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
        console.log(`✅ Updated ${configInfo.name} configuration at ${configPath}`);
      } catch (e) {
        console.error(`⚠️ Could not write to ${configInfo.name} config at ${configPath}.`);
      }
    } else {
      // Quietly skip if the client isn't installed
    }
  }

  console.log("\n🎉 Setup complete! Restart your MCP clients and After Effects to begin.");
  console.log("👉 Don't forget to enable 'Allow Scripts to Write Files and Access Network' in AE Preferences.");
}

/**
 * Reverts changes made by runSetup.
 */
export async function runUninstall() {
  const currentFile = fileURLToPath(import.meta.url);
  const projectRoot = resolve(dirname(dirname(currentFile)));
  const cepFiles = ["manifest.json", "main.js", "index.html"];

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

  // 1. Remove CEP Extension
  const aeSupportDir = findAfterEffectsSupportDir();
  if (aeSupportDir) {
    const cepDir = join(aeSupportDir, "CEPPlugIns", "AE-MCP-Bridge");
    if (existsSync(cepDir)) {
      try {
        const fs = require("node:fs");
        const files = fs.readdirSync(cepDir);
        for (const file of files) {
          fs.unlinkSync(join(cepDir, file));
        }
        fs.rmdirSync(cepDir);
        console.log("✅ Removed AE-MCP-Bridge from CEPPlugIns.");
      } catch (e) {
        console.warn("⚠️ Could not remove CEP extension from AE.");
      }
    }
  }

  // 2. Remove Config from Clients
  const configs = [
    {
      name: "Claude Desktop",
      path: getClaudeConfigPath(),
      type: "mcpServers"
    },
    {
      name: "VSCode Cline",
      path: process.platform === "win32" 
        ? join(process.env.APPDATA || "", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json")
        : join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json"),
      type: "mcpServers"
    },
    {
      name: "VSCode Roo Code",
      path: process.platform === "win32" 
        ? join(process.env.APPDATA || "", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json")
        : join(os.homedir(), "Library", "Application Support", "Code", "User", "globalStorage", "rooveterinaryinc.roo-cline", "settings", "cline_mcp_settings.json"),
      type: "mcpServers"
    },
    {
      name: "OpenCode Global",
      path: join(os.homedir(), ".config", "opencode", "opencode.json"),
      type: "mcp"
    },
    {
      name: "OpenCode Local",
      path: join(process.cwd(), "opencode.jsonc"),
      type: "mcp"
    }
  ];

  for (const configInfo of configs) {
    const configPath = configInfo.path;
    if (configPath && existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf8");
        // Simple JSONC handling (remove comments for parsing)
        const cleanJson = content.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
        const config = JSON.parse(cleanJson);
        
        const mcpKey = configInfo.type;
        if (config[mcpKey]) {
          const keyToDelete = configInfo.type === "mcpServers" ? "after-effects" : "after_effects";
          if (config[mcpKey][keyToDelete]) {
            delete config[mcpKey][keyToDelete];
            writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
            console.log(`✅ Removed After Effects MCP from ${configInfo.name} config.`);
          }
        }
      } catch (e) {
        console.error(`⚠️ Could not update ${configInfo.name} config at ${configPath}.`);
      }
    }
  }

  console.log("\n✨ Uninstall complete. You can now safely delete the project folder.");
}
