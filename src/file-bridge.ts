#!/usr/bin/env node
/*
AE MCP Server - File Bridge Mode
Uses file-based communication instead of stdio for more reliable execution.
Requires CEP extension to be installed in After Effects.

Usage:
  AE_USE_FILE_BRIDGE=true node build/file-bridge.js

Environment:
  AE_USE_FILE_BRIDGE=true  - Use file bridge instead of stdio
  AE_WATCH_DIR            - Custom watch folder (optional)
*/

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, watch } from "node:fs";
import { join, dirname, resolve, normalize } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

// Security: Rate limiting
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 60000;

const WATCH_DIR = process.env.AE_WATCH_DIR || join(process.env.APPDATA || "", "Adobe", "After Effects", "AE-MCP", "commands");
const RESULTS_DIR = process.env.AE_RESULTS_DIR || join(process.env.APPDATA || "", "Adobe", "After Effects", "AE-MCP", "results");

function checkRateLimit(identifier: string): boolean {
  const now = Date.now();
  const record = requestCounts.get(identifier);
  if (!record || now > record.resetTime) {
    requestCounts.set(identifier, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (record.count >= RATE_LIMIT_MAX) return false;
  record.count++;
  return true;
}

// Security: Input sanitization
function sanitizeInput(input: string, maxLength: number = 10000): string {
  let sanitized = input.substring(0, maxLength);
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return sanitized;
}

// Security: Forbidden ExtendScript patterns
const FORBIDDEN_PATTERNS = [
  /app\.(?:system|exit)/i,
  /File\.(?:write|copy|save|remove|rename)/i,
  /Folder\.(?:create|remove|rename)/i,
  /eval\s*\(|include\s*\(/i,
  /\$\.(?:evalFile|eval|write|writeln)/i,
  /system\.callSystem/i,
];

function validateExtendScriptSecurity(code: string): { valid: boolean; reason?: string } {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      return { valid: false, reason: `Forbidden pattern: ${pattern.source}` };
    }
  }
  return { valid: true };
}

function ensureDirs() {
  if (!existsSync(WATCH_DIR)) mkdirSync(WATCH_DIR, { recursive: true });
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
}

async function sendCommand(code: string, args: { timeout?: number } = {}) {
  // Security: Rate limiting
  if (!checkRateLimit("global")) {
    return { ok: false, error: "Rate limit exceeded. Try again later." };
  }

  // Security: Sanitize input
  const sanitizedCode = sanitizeInput(code, 10000);

  // Security: Validate ExtendScript
  const validation = validateExtendScriptSecurity(sanitizedCode);
  if (!validation.valid) {
    return { ok: false, error: `Security: ${validation.reason}` };
  }

  const commandId = randomUUID();
  const commandFile = join(WATCH_DIR, `${commandId}.json`);
  const resultFile = join(RESULTS_DIR, `${commandId}_result.json`);

  // Clean up old result files
  if (existsSync(resultFile)) unlinkSync(resultFile);

  const command = { id: commandId, code: sanitizedCode, args, timestamp: Date.now() };
  writeFileSync(commandFile, JSON.stringify(command), "utf8");

  // Wait for result
  const startTime = Date.now();
  const timeout = args.timeout || 30000;

  while (!existsSync(resultFile) && (Date.now() - startTime) < timeout) {
    await new Promise(r => setTimeout(r, 200));
  }

  let result;
  if (existsSync(resultFile)) {
    try {
      result = JSON.parse(readFileSync(resultFile, "utf8"));
      unlinkSync(resultFile);
    } catch (e) {
      result = { ok: false, error: "Invalid result JSON" };
    }
  } else {
    result = { ok: false, error: "Timeout waiting for result" };
  }

  // Clean up command file
  if (existsSync(commandFile)) unlinkSync(commandFile);

  return result;
}

// Map stdio-style tool calls to file bridge commands
const tools: Record<string, (args?: any) => Promise<any>> = {
  ae_find_executable: async () => {
    const result = await sendCommand(`
      return {
        path: app.path,
        version: app.version,
        os: $.os
      };
    `);
    return result;
  },

  ae_project_summary: async () => {
    const result = await sendCommand(`
      var project = app.project;
      if (!project) return { hasProject: false };
      var summary = {
        hasProject: true,
        file: project.file ? project.file.fsName : null,
        items: project.items.length,
        counts: { comps: 0, footage: 0, folders: 0 },
        renderQueueItems: project.renderQueue.numItems
      };
      for (var i = 1; i <= project.items.length; i++) {
        var item = project.item(i);
        if (item instanceof CompItem) summary.counts.comps++;
        else if (item instanceof FootageItem) summary.counts.footage++;
        else if (item instanceof FolderItem) summary.counts.folders++;
      }
      return summary;
    `);
    return result;
  },

  ae_list_comps: async () => {
    const result = await sendCommand(`
      if (!app.project) return [];
      var comps = [];
      for (var i = 1; i <= app.project.items.length; i++) {
        var item = app.project.item(i);
        if (item instanceof CompItem) {
          comps.push({
            name: item.name,
            width: item.width,
            height: item.height,
            duration: item.duration,
            frameRate: item.frameRate,
            layers: item.layers.length
          });
        }
      }
      return comps;
    `);
    return result;
  },

  ae_create_comp: async ({ name, width = 1920, height = 1080, duration = 10, frameRate = 30, pixelAspect = 1 }) => {
    const result = await sendCommand(`
      if (!app.project) app.newProject();
      app.beginUndoGroup("MCP Create Comp");
      try {
        var comp = app.project.items.addComp("${name}", ${width}, ${height}, ${pixelAspect}, ${duration}, ${frameRate});
        return { id: comp.id, name: comp.name, width: comp.width, height: comp.height, duration: comp.duration };
      } finally {
        app.endUndoGroup();
      }
    `);
    return result;
  },

  ae_add_text_layer: async ({ text, compName, x = 960, y = 540, fontSize = 96, color = [1, 1, 1], startTime = 0 }) => {
    const result = await sendCommand(`
      if (!app.project) throw new Error("No project open");
      var comp = app.project.activeItem;
      if (!comp || !(comp instanceof CompItem)) throw new Error("No active comp");
      app.beginUndoGroup("MCP Add Text");
      try {
        var layer = comp.layers.addText("${text}");
        layer.startTime = ${startTime};
        layer.property("Transform").property("Position").setValue([${x}, ${y}]);
        var doc = layer.property("Source Text").value;
        doc.fontSize = ${fontSize};
        doc.fillColor = [${color[0]}, ${color[1]}, ${color[2]}];
        layer.property("Source Text").setValue(doc);
        return { layer: layer.name, index: layer.index };
      } finally {
        app.endUndoGroup();
      }
    `);
    return result;
  },

  ae_add_solid: async ({ name = "MCP Solid", color = [0.1, 0.1, 0.1], width, height, duration }) => {
    const result = await sendCommand(`
      if (!app.project) throw new Error("No project open");
      var comp = app.project.activeItem;
      if (!comp || !(comp instanceof CompItem)) throw new Error("No active comp");
      app.beginUndoGroup("MCP Add Solid");
      try {
        var layer = comp.layers.addSolid([${color[0]}, ${color[1]}, ${color[2]}], "${name}", ${width || "comp.width"}, ${height || "comp.height"}, 1, ${duration || "comp.duration"});
        return { layer: layer.name, width: layer.width, height: layer.height };
      } finally {
        app.endUndoGroup();
      }
    `);
    return result;
  },

  ae_eval: async ({ code, timeoutMs = 30000 }) => {
    const result = await sendCommand(code, { timeout: timeoutMs });
    return result;
  }
};

async function main() {
  ensureDirs();
  console.log(`[AE MCP File Bridge] Watching: ${WATCH_DIR}`);
  console.log(`[AE MCP File Bridge] Results: ${RESULTS_DIR}`);
  console.log("[AE MCP File Bridge] Ready!");

  // Simple stdin command processor
  const readline = await import("node:readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  rl.on("line", async (line) => {
    try {
      const msg = JSON.parse(line);
      
      if (msg.method === "tools/list") {
        const toolList = Object.keys(tools).map(name => ({
          name,
          description: `AE MCP ${name} via file bridge`
        }));
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: toolList } }) + "\n");
      }
      else if (msg.method === "tools/call") {
        const tool = tools[msg.params.name];
        if (tool) {
          const result = await tool(msg.params.arguments);
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } }) + "\n");
        } else {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { message: "Unknown tool" } }) + "\n");
        }
      }
      else if (msg.method === "initialize") {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "ae-mcp-file-bridge", version: "1.0.0" } } }) + "\n");
      }
    } catch (e) {
      // Ignore non-JSON lines
    }
  });
}

main().catch(console.error);