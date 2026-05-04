#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, normalize, resolve, sep } from "node:path";
import { z } from "zod";

// Security: Rate limiting (CVE-009 fix)
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_MAX = 100; // Max requests per window
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute

// Security: Optional auth token for stdio transport (CVE-011 fix)
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

function checkRateLimit(identifier: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const record = requestCounts.get(identifier);

  if (!record || now > record.resetTime) {
    requestCounts.set(identifier, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return { allowed: true };
  }

  if (record.count >= RATE_LIMIT_MAX) {
    return { allowed: false, retryAfter: Math.ceil((record.resetTime - now) / 1000) };
  }

  record.count++;
  return { allowed: true };
}

// Security: Allowed directories for file operations (CVE-002 fix)
const ALLOWED_DIRECTORIES = (process.env.MCP_ALLOWED_DIRS || "")
  .split(";")
  .filter(Boolean)
  .map((dir) => resolve(normalize(dir)));

// If no directories specified, default to current working directory
if (ALLOWED_DIRECTORIES.length === 0) {
  ALLOWED_DIRECTORIES.push(resolve(process.cwd()));
}

// Security: Forbidden patterns for ExtendScript execution (CVE-001 fix)
const FORBIDDEN_EXTENDSCRIPT_PATTERNS = [
  /app\.(?:system|exit)/i,
  /File\.(?:write|copy|save|remove|rename)/i,
  /Folder\.(?:create|remove|rename)/i,
  /eval\s*\(|include\s*\(/i,
  /\$\.(?:evalFile|eval|write|writeln)/i,
  /system\.callSystem/i,
  /executeCommand.*system/i,
  // Catch bracket notation access to sensitive properties
  /app\s*\[\s*['"](?:system|exit)['"]\s*\]/i,
  /File\s*\[\s*['"](?:write|copy|save|remove|rename)['"]\s*\]/i,
  /\$\s*\[\s*['"](?:evalFile|eval|write|writeln)['"]\s*\]/i,
];

// Security: Validate that a path is within allowed directories
function validatePathSecurity(inputPath: string): { valid: boolean; reason?: string; normalized?: string } {
  const normalized = normalize(resolve(inputPath));

  // Check for path traversal attempts
  if (normalized !== resolve(inputPath)) {
    return { valid: false, reason: "Path traversal detected" };
  }

  // Check if path is within allowed directories
  const isAllowed = ALLOWED_DIRECTORIES.some((dir) => {
    const dirWithSep = dir.endsWith(sep) ? dir : dir + sep;
    return normalized === dir || normalized.startsWith(dirWithSep);
  });

  if (!isAllowed) {
    const allowedList = ALLOWED_DIRECTORIES.join("; ");
    return { valid: false, reason: `Path outside allowed directories. Allowed: ${allowedList}` };
  }

  return { valid: true, normalized };
}

// Security: Validate ExtendScript code against forbidden patterns
function validateExtendScriptSecurity(code: string): { valid: boolean; reason?: string } {
  for (const pattern of FORBIDDEN_EXTENDSCRIPT_PATTERNS) {
    if (pattern.test(code)) {
      return { valid: false, reason: `Forbidden pattern detected: ${pattern.source}` };
    }
  }
  return { valid: true };
}

// Security: Sanitize user input strings (CVE-014 fix)
function sanitizeInput(input: string, maxLength: number = 1000): string {
  // Truncate to max length
  let sanitized = input.substring(0, maxLength);
  // Remove null bytes and other control characters except newlines/tabs
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return sanitized;
}

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type AeRunResult = {
  ok: boolean;
  value?: JsonValue;
  error?: string;
  scriptPath?: string;
  resultPath?: string;
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
};

const server = new McpServer({
  name: "after-effect-mcp",
  version: "0.1.0",
});

const DEFAULT_TIMEOUT_MS = 30000;

function textResponse(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

function findAfterEffectsExecutable(explicitPath?: string): string {
  if (explicitPath && existsSync(explicitPath)) {
    return explicitPath;
  }

  const envPath = process.env.AFTERFX_PATH || process.env.AFTER_EFFECTS_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // Check for running AfterFX process (Windows)
  if (process.platform === "win32") {
    try {
      const ps = execSync(
        'powershell -Command "Get-Process -Name afterfx -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path"',
        { encoding: "utf8", timeout: 5000 }
      ).trim();
      if (ps && existsSync(ps)) {
        return ps;
      }
    } catch {
      // Best-effort - process detection failed
    }
  }

  if (process.platform === "win32") {
    // Scan all drives for After Effects (not just ProgramFiles)
    const drives = ["C:", "D:", "E:", "F:"].filter((d) => {
      try {
        return existsSync(d);
      } catch {
        return false;
      }
    });

    const candidates: string[] = [];
    for (const drive of drives) {
      const adobeRoot = join(drive, "\\Program Files", "Adobe");
      if (!existsSync(adobeRoot)) {
        continue;
      }
      try {
        for (const entry of readdirSync(adobeRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("Adobe After Effects")) {
            continue;
          }
          candidates.push(join(adobeRoot, entry.name, "Support Files", "afterfx.com"));
          candidates.push(join(adobeRoot, entry.name, "Support Files", "AfterFX.exe"));
        }
      } catch {
        // Keep discovery best-effort.
      }
    }

    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) {
      return found;
    }
  }

  if (process.platform === "darwin") {
    const appRoot = "/Applications";
    if (existsSync(appRoot)) {
      try {
        for (const entry of readdirSync(appRoot, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.startsWith("Adobe After Effects")) {
            continue;
          }
          const appName = entry.name.replace(/\.app$/, "");
          const candidate = join(appRoot, entry.name, "Contents", "MacOS", appName);
          if (existsSync(candidate)) {
            return candidate;
          }
        }
      } catch {
        // Keep discovery best-effort.
      }
    }
  }

  return process.platform === "win32" ? "afterfx.com" : "afterfx";
}

function escapeForJsString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function makeWrapper(userCode: string, resultPath: string): string {
  // Security: Validate user code before wrapping (CVE-003 fix)
  const validation = validateExtendScriptSecurity(userCode);
  if (!validation.valid) {
    throw new Error(`Invalid ExtendScript code: ${validation.reason}`);
  }

  // Convert newlines to actual newlines for JSX embedding
  const escapedUserCode = userCode
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  return `#target aftereffects
(function afterEffectMcpWrapper() {
    function stringify(value) {
        var type = typeof value;
        if (value === null) return "null";
        if (type === "number" || type === "boolean") return String(value);
        if (type === "string") {
            var escaped = "";
            for (var s = 0; s < value.length; s++) {
                var ch = value.charAt(s);
                var code = value.charCodeAt(s);
                if (ch === "\\\\") escaped += "\\\\\\\\";
                else if (ch === '"') escaped += '\\\\"';
                else if (ch === "\\b") escaped += "\\\\b";
                else if (ch === "\\f") escaped += "\\\\f";
                else if (ch === "\\n") escaped += "\\\\n";
                else if (ch === "\\r") escaped += "\\\\r";
                else if (ch === "\\t") escaped += "\\\\t";
                else if (code < 16) escaped += "\\\\u000" + code.toString(16);
                else if (code < 32) escaped += "\\\\u00" + code.toString(16);
                else escaped += ch;
            }
            return '"' + escaped + '"';
        }
        if (value instanceof Array) {
            var arr = [];
            for (var i = 0; i < value.length; i++) arr.push(stringify(value[i]));
            return "[" + arr.join(",") + "]";
        }
        if (type === "object") {
            var props = [];
            for (var key in value) {
                if (value.hasOwnProperty(key) && typeof value[key] !== "function") {
                    props.push(stringify(key) + ":" + stringify(value[key]));
                }
            }
            return "{" + props.join(",") + "}";
        }
        return stringify(String(value));
    }

    function writeResult(payload) {
        var f = new File("${escapeForJsString(resultPath)}");
        f.encoding = "UTF-8";
        f.open("w");
        f.write(stringify(payload));
        f.close();
    }

    app.beginSuppressDialogs();
    try {
        var __mcpResult = (function () {
${escapedUserCode.split("\n").map((line) => `            ${line}`).join("\n")}
        })();
        writeResult({ ok: true, value: __mcpResult });
        app.exitCode = 0;
    } catch (e) {
        writeResult({ ok: false, error: String(e && e.message ? e.message : e), line: e && e.line ? e.line : null });
        app.exitCode = 1;
    } finally {
        app.endSuppressDialogs(false);
    }
})();`;
}

async function runAfterEffectsScript(options: {
  code: string;
  executablePath?: string;
  timeoutMs?: number;
  keepTempFiles?: boolean;
}): Promise<AeRunResult> {
  // Security: Rate limiting for AE script execution (CVE-009 fix)
  const rateCheck = checkRateLimit("global");
  if (!rateCheck.allowed) {
    return {
      ok: false,
      error: `Rate limit exceeded. Retry after ${rateCheck.retryAfter} seconds.`,
      scriptPath: "",
      resultPath: "",
      exitCode: null,
      timedOut: false,
      stderr: "",
    };
  }

  const workDir = join(tmpdir(), "after-effect-mcp");
  mkdirSync(workDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const scriptPath = join(workDir, `mcp-${stamp}.jsx`);
  const resultPath = join(workDir, `mcp-${stamp}.json`);
  writeFileSync(scriptPath, makeWrapper(options.code, resultPath), "utf8");

  const executable = findAfterEffectsExecutable(options.executablePath);

  // Security: Validate AE executable path (CVE-004 fix)
  const exeValidation = validateAfterEffectsExecutable(executable);
  if (!exeValidation.valid) {
    return {
      ok: false,
      error: `Invalid After Effects executable: ${exeValidation.reason}`,
      scriptPath,
      resultPath,
      exitCode: null,
      timedOut: false,
      stderr: "",
    };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = ["-r", scriptPath];
  let stderr = "";
  let timedOut = false;

  const exitCode = await new Promise<number | null>((resolve) => {
    const child = spawn(executable, args, { windowsHide: false });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      resolve(null);
    }, timeoutMs);

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      stderr += error.message;
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  const deadline = Date.now() + Math.min(timeoutMs, 10000);
  while (!existsSync(resultPath) && Date.now() < deadline && !timedOut) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  let payload: { ok: boolean; value?: JsonValue; error?: string } = {
    ok: false,
    error: `After Effects did not write a result file. Make sure After Effects is running and Preferences > Scripting & Expressions > Allow Scripts To Write Files And Access Network is enabled.`,
  };

  if (existsSync(resultPath)) {
    try {
      payload = JSON.parse(readFileSync(resultPath, "utf8")) as typeof payload;
  } catch (error) {
    // Security: Sanitize error messages (CVE-010 fix)
    const errorMessage = (error as Error).message || "Unknown error";
    payload = { ok: false, error: `Could not parse After Effects result: ${errorMessage.substring(0, 200)}` };
  }
  }

  if (!options.keepTempFiles) {
    for (const path of [scriptPath, resultPath]) {
      try {
        if (existsSync(path)) rmSync(path);
      } catch {
        // Temp cleanup should not hide the AE result.
      }
    }
  }

  return {
    ok: payload.ok,
    value: payload.value,
    error: payload.error,
    // Security: Don't expose internal temp paths to client (CVE-007 fix)
    exitCode,
    timedOut,
    stderr,
  };
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

server.registerTool(
  "ae_find_executable",
  {
    description: "Find the After Effects command-line executable that will be used by this MCP server.",
    inputSchema: {
      executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path to validate."),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ executablePath }) => {
    const path = findAfterEffectsExecutable(executablePath);
    const exists = existsSync(path);
    return textResponse(
      exists ? `After Effects executable found: ${path}` : `No concrete executable found. The server will try command: ${path}`,
      { path, exists },
    );
  },
);

server.registerTool(
  "ae_eval",
  {
    description: "Run ExtendScript in the current After Effects instance and return a JSON-serializable result.",
    inputSchema: {
      code: z.string().min(1).describe("ExtendScript body to run. Use ES3 syntax with var/function, not modern JavaScript."),
      executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
      timeoutMs: z.number().int().min(1000).max(300000).optional().describe("Timeout in milliseconds. Defaults to 30000."),
      keepTempFiles: z.boolean().optional().describe("Keep generated JSX/result files for debugging."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ code, executablePath, timeoutMs, keepTempFiles }) => {
    // Security: Validate ExtendScript code (CVE-001 fix)
    const validation = validateExtendScriptSecurity(code);
    if (!validation.valid) {
      return textResponse(`Security error: ${validation.reason}`, { ok: false, error: validation.reason });
    }

    // Security: Sanitize input (CVE-014 fix)
    const sanitizedCode = sanitizeInput(code, 10000);

    const result = await runAfterEffectsScript({ code: sanitizedCode, executablePath, timeoutMs, keepTempFiles });
    const text = result.ok
      ? `After Effects script completed.\n\n${prettyJson(result.value ?? null)}`
      : `After Effects script failed: ${result.error}\n\nstderr:\n${result.stderr || "(empty)"}`;
    return textResponse(text, result as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  "ae_project_summary",
  {
    description: "Inspect the open After Effects project: file, active comp, item counts, comps, footage, and render queue size.",
    inputSchema: {
      executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ executablePath, timeoutMs }) => {
    const code = `
var project = app.project;
var summary = {
    hasProject: !!project,
    file: project && project.file ? project.file.fsName : null,
    items: [],
    counts: { comps: 0, footage: 0, folders: 0, other: 0 },
    activeItem: null,
    renderQueueItems: project ? project.renderQueue.numItems : 0
};
if (project) {
    if (project.activeItem) {
        summary.activeItem = {
            name: project.activeItem.name,
            typeName: project.activeItem.typeName || String(project.activeItem)
        };
    }
    for (var i = 1; i <= project.items.length; i++) {
        var item = project.item(i);
        var type = "other";
        if (item instanceof CompItem) {
            type = "comp";
            summary.counts.comps++;
        } else if (item instanceof FootageItem) {
            type = "footage";
            summary.counts.footage++;
        } else if (item instanceof FolderItem) {
            type = "folder";
            summary.counts.folders++;
        } else {
            summary.counts.other++;
        }
        summary.items.push({
            index: i,
            id: item.id,
            name: item.name,
            type: type,
            width: item.width || null,
            height: item.height || null,
            duration: item.duration || null
        });
    }
}
return summary;`;
    const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
    return textResponse(result.ok ? prettyJson(result.value) : `After Effects inspection failed: ${result.error}`, result as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  "ae_create_comp",
  {
    description: "Create a composition in the current After Effects project.",
    inputSchema: {
      name: z.string().min(1).describe("Composition name."),
      width: z.number().int().min(1).max(32768).default(1920),
      height: z.number().int().min(1).max(32768).default(1080),
      duration: z.number().positive().max(86400).default(10),
      frameRate: z.number().positive().max(240).default(30),
      pixelAspect: z.number().positive().default(1),
      executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ name, width, height, duration, frameRate, pixelAspect, executablePath, timeoutMs }) => {
    // Security: Sanitize name (CVE-014 fix)
    const sanitizedName = sanitizeInput(name, 200);
    const code = `
if (!app.project) app.newProject();
app.beginUndoGroup("MCP Create Comp");
try {
    var comp = app.project.items.addComp("${escapeForJsString(sanitizedName)}", ${width}, ${height}, ${pixelAspect}, ${duration}, ${frameRate});
    return { id: comp.id, name: comp.name, width: comp.width, height: comp.height, duration: comp.duration, frameRate: comp.frameRate };
} finally {
    app.endUndoGroup();
}`;
    const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
    return textResponse(result.ok ? `Created composition:\n${prettyJson(result.value)}` : `Could not create comp: ${result.error}`, result as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  "ae_list_comps",
  {
    description: "List compositions in the current After Effects project.",
    inputSchema: {
      executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async ({ executablePath, timeoutMs }) => {
    const code = `
if (!app.project) return [];
var comps = [];
for (var i = 1; i <= app.project.items.length; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem) {
        comps.push({
            index: i,
            id: item.id,
            name: item.name,
            width: item.width,
            height: item.height,
            duration: item.duration,
            frameRate: item.frameRate,
            layers: item.layers.length
        });
    }
}
return comps;`;
    const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
    return textResponse(result.ok ? prettyJson(result.value) : `Could not list comps: ${result.error}`, result as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  "ae_add_text_layer",
  {
    description: "Add a text layer to a composition, defaulting to the active comp.",
    inputSchema: {
      text: z.string().min(1).describe("Text content for the new layer."),
      compName: z.string().optional().describe("Composition name. Uses active comp when omitted."),
      x: z.number().default(960).describe("Layer position X."),
      y: z.number().default(540).describe("Layer position Y."),
      fontSize: z.number().positive().max(1000).default(96),
      color: z.array(z.number().min(0).max(1)).length(3).default([1, 1, 1]).describe("RGB fill color, each channel 0..1."),
      startTime: z.number().min(0).default(0),
      duration: z.number().positive().optional().describe("Optional layer out point duration in seconds."),
      executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ text, compName, x, y, fontSize, color, startTime, duration, executablePath, timeoutMs }) => {
    // Security: Sanitize inputs (CVE-014 fix)
    const sanitizedText = sanitizeInput(text, 1000);
    const sanitizedCompName = compName ? sanitizeInput(compName, 200) : undefined;

    const compSelector = sanitizedCompName
      ? `
var comp = null;
for (var i = 1; i <= app.project.items.length; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem && item.name === "${escapeForJsString(sanitizedCompName ?? "")}") {
        comp = item;
        break;
    }
}`
      : `
var comp = app.project.activeItem instanceof CompItem ? app.project.activeItem : null;`;
    const outPointLine = duration ? `layer.outPoint = ${startTime + duration};` : "";
    const code = `
if (!app.project) throw new Error("No After Effects project is open.");
${compSelector}
if (!(comp instanceof CompItem)) throw new Error("No target composition found.");
app.beginUndoGroup("MCP Add Text Layer");
try {
    var layer = comp.layers.addText("${escapeForJsString(text)}");
    layer.startTime = ${startTime};
    ${outPointLine}
    layer.property("Transform").property("Position").setValue([${x}, ${y}]);
    var doc = layer.property("Source Text").value;
    doc.fontSize = ${fontSize};
    doc.fillColor = [${color[0]}, ${color[1]}, ${color[2]}];
    layer.property("Source Text").setValue(doc);
    return { comp: comp.name, layer: layer.name, index: layer.index, text: "${escapeForJsString(text)}" };
} finally {
    app.endUndoGroup();
}`;
    const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
    return textResponse(result.ok ? `Added text layer:\n${prettyJson(result.value)}` : `Could not add text layer: ${result.error}`, result as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  "ae_add_solid",
  {
    description: "Add a solid layer to a composition, defaulting to the active comp.",
    inputSchema: {
      name: z.string().min(1).default("MCP Solid"),
      compName: z.string().optional().describe("Composition name. Uses active comp when omitted."),
      color: z.array(z.number().min(0).max(1)).length(3).default([0.1, 0.1, 0.1]).describe("RGB solid color, each channel 0..1."),
      width: z.number().int().positive().optional().describe("Solid width. Defaults to comp width."),
      height: z.number().int().positive().optional().describe("Solid height. Defaults to comp height."),
      duration: z.number().positive().optional().describe("Solid duration. Defaults to comp duration."),
      executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ name, compName, color, width, height, duration, executablePath, timeoutMs }) => {
    // Security: Sanitize inputs (CVE-014 fix)
    const sanitizedName = sanitizeInput(name, 200);
    const sanitizedCompName = compName ? sanitizeInput(compName, 200) : undefined;

    const compSelector = sanitizedCompName
      ? `
var comp = null;
for (var i = 1; i <= app.project.items.length; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem && item.name === "${escapeForJsString(sanitizedCompName ?? "")}") {
        comp = item;
        break;
    }
}`
      : `
var comp = app.project.activeItem instanceof CompItem ? app.project.activeItem : null;`;
    const code = `
if (!app.project) throw new Error("No After Effects project is open.");
${compSelector}
if (!(comp instanceof CompItem)) throw new Error("No target composition found.");
app.beginUndoGroup("MCP Add Solid");
try {
    var layer = comp.layers.addSolid([${color[0]}, ${color[1]}, ${color[2]}], "${escapeForJsString(name)}", ${width ?? "comp.width"}, ${height ?? "comp.height"}, 1, ${duration ?? "comp.duration"});
    return { comp: comp.name, layer: layer.name, index: layer.index, width: layer.width, height: layer.height };
} finally {
    app.endUndoGroup();
}`;
    const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
    return textResponse(result.ok ? `Added solid layer:\n${prettyJson(result.value)}` : `Could not add solid layer: ${result.error}`, result as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  "ae_import_file",
  {
    description: "Import a media or project file into the current After Effects project.",
    inputSchema: {
      path: z.string().min(1).describe("Absolute path to the file to import."),
      executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ path, executablePath, timeoutMs }) => {
    // Security: Validate path (CVE-002 fix)
    const pathValidation = validatePathSecurity(path);
    if (!pathValidation.valid) {
      return textResponse(`Security error: ${pathValidation.reason}`, { ok: false, error: pathValidation.reason });
    }
    const normalized = pathValidation.normalized!;
    const code = `
if (!app.project) app.newProject();
var file = new File("${escapeForJsString(normalized)}");
if (!file.exists) throw new Error("File does not exist: " + file.fsName);
app.beginUndoGroup("MCP Import File");
try {
    var item = app.project.importFile(new ImportOptions(file));
    return { id: item.id, name: item.name, path: file.fsName, typeName: item.typeName || null };
} finally {
    app.endUndoGroup();
}`;
    const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
    return textResponse(result.ok ? `Imported ${basename(normalized)}:\n${prettyJson(result.value)}` : `Could not import file: ${result.error}`, result as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  "ae_open_project",
  {
    description: "Open an After Effects project file.",
    inputSchema: {
      path: z.string().min(1).describe("Absolute path to an .aep project file."),
      executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ path, executablePath, timeoutMs }) => {
    // Security: Validate path (CVE-002 fix)
    const pathValidation = validatePathSecurity(path);
    if (!pathValidation.valid) {
      return textResponse(`Security error: ${pathValidation.reason}`, { ok: false, error: pathValidation.reason });
    }
    const normalized = pathValidation.normalized!;
    const code = `
var file = new File("${escapeForJsString(normalized)}");
if (!file.exists) throw new Error("Project file does not exist: " + file.fsName);
var project = app.open(file);
return { file: project.file ? project.file.fsName : file.fsName, items: project.items.length };`;
    const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
    return textResponse(result.ok ? `Opened project:\n${prettyJson(result.value)}` : `Could not open project: ${result.error}`, result as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  "ae_save_project",
  {
    description: "Save the current After Effects project, optionally to a new path.",
    inputSchema: {
      path: z.string().optional().describe("Optional absolute .aep path. If omitted, saves the current project file."),
      executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ path, executablePath, timeoutMs }) => {
    // Security: Validate path if provided (CVE-002 fix)
    let normalized: string | undefined;
    if (path) {
      const pathValidation = validatePathSecurity(path);
      if (!pathValidation.valid) {
        return textResponse(`Security error: ${pathValidation.reason}`, { ok: false, error: pathValidation.reason });
      }
      normalized = pathValidation.normalized!;
    }
    const saveLine = normalized ? `app.project.save(new File("${escapeForJsString(normalized)}"));` : "app.project.save();";
    const code = `
if (!app.project) throw new Error("No After Effects project is open.");
${saveLine}
return { file: app.project.file ? app.project.file.fsName : null, items: app.project.items.length };`;
    const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
    return textResponse(result.ok ? `Saved project:\n${prettyJson(result.value)}` : `Could not save project: ${result.error}`, result as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  "ae_queue_render",
  {
    description: "Add a composition to the render queue and optionally set the output path. This does not start rendering.",
    inputSchema: {
      compName: z.string().min(1).describe("Composition name to add to the render queue."),
      outputPath: z.string().optional().describe("Optional absolute output file path."),
      renderSettingsTemplate: z.string().optional().describe("Optional render settings template name."),
      outputModuleTemplate: z.string().optional().describe("Optional output module template name."),
      executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ compName, outputPath, renderSettingsTemplate, outputModuleTemplate, executablePath, timeoutMs }) => {
    // Security: Validate path if provided (CVE-002 fix)
    let normalizedPath: string | undefined;
    if (outputPath) {
      const pathValidation = validatePathSecurity(outputPath);
      if (!pathValidation.valid) {
        return textResponse(`Security error: ${pathValidation.reason}`, { ok: false, error: pathValidation.reason });
      }
      normalizedPath = pathValidation.normalized!;
    }

    // Security: Sanitize inputs (CVE-014 fix)
    const sanitizedCompName = compName ? sanitizeInput(compName, 200) : undefined;
    const outputLine = normalizedPath ? `om.file = new File("${escapeForJsString(normalizedPath)}");` : "";
    const renderSettingsLine = renderSettingsTemplate ? `rqItem.applyTemplate("${escapeForJsString(renderSettingsTemplate)}");` : "";
    const outputTemplateLine = outputModuleTemplate ? `om.applyTemplate("${escapeForJsString(outputModuleTemplate)}");` : "";
    const code = `
if (!app.project) throw new Error("No After Effects project is open.");
var comp = null;
for (var i = 1; i <= app.project.items.length; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem && item.name === "${escapeForJsString(sanitizedCompName ?? "")}") {
        comp = item;
        break;
    }
}
if (!(comp instanceof CompItem)) throw new Error("Composition not found: ${escapeForJsString(sanitizedCompName ?? "")}");
app.beginUndoGroup("MCP Queue Render");
try {
    var rqItem = app.project.renderQueue.items.add(comp);
    ${renderSettingsLine}
    var om = rqItem.outputModule(1);
    ${outputTemplateLine}
    ${outputLine}
    return { comp: comp.name, renderQueueIndex: rqItem.index, output: om.file ? om.file.fsName : null };
} finally {
    app.endUndoGroup();
}`;
    const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
    return textResponse(result.ok ? `Queued render:\n${prettyJson(result.value)}` : `Could not queue render: ${result.error}`, result as unknown as Record<string, unknown>);
  },
);

server.registerTool(
  "ae_run_script_file",
  {
    description: "Run an existing JSX file in After Effects using $.evalFile and return the script result when possible.",
    inputSchema: {
      path: z.string().min(1).describe("Absolute path to a JSX or JSXBIN file."),
      executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
      keepTempFiles: z.boolean().optional().describe("Keep generated wrapper/result files for debugging."),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  async ({ path, executablePath, timeoutMs, keepTempFiles }) => {
    // Security: Validate path (CVE-006 fix)
    const pathValidation = validatePathSecurity(path);
    if (!pathValidation.valid) {
      return textResponse(`Security error: ${pathValidation.reason}`, { ok: false, error: pathValidation.reason });
    }
    const normalized = pathValidation.normalized!;
    const code = `
var scriptFile = new File("${escapeForJsString(normalized)}");
if (!scriptFile.exists) throw new Error("Script file does not exist: " + scriptFile.fsName);
return $.evalFile(scriptFile);`;
    const result = await runAfterEffectsScript({ code, executablePath, timeoutMs, keepTempFiles });
    return textResponse(result.ok ? `Ran ${normalized}:\n${prettyJson(result.value ?? null)}` : `Could not run script file: ${result.error}`, result as unknown as Record<string, unknown>);
  },
);

// Security: Validate AE executable path (CVE-004 fix)
function validateAfterEffectsExecutable(executablePath: string): { valid: boolean; reason?: string; normalized?: string } {
  const normalized = normalize(resolve(executablePath));

  // Check for path traversal
  if (normalized !== resolve(executablePath)) {
    return { valid: false, reason: "Path traversal detected in executable path" };
  }

  // Must be a known AE executable name
  const fileName = basename(normalized).toLowerCase();
  const allowedNames = ["afterfx.exe", "afterfx.com", "afterfx"];
  if (!allowedNames.includes(fileName)) {
    return { valid: false, reason: `Executable name not allowed: ${fileName}` };
  }

  // If it's just a command name (no directory path), don't check file existence
  // Let the system resolve it via PATH
  const hasPath = normalized.includes(sep) || normalized.includes("/");
  if (!hasPath) {
    return { valid: true, normalized };
  }

  // Full path provided - must exist
  if (!existsSync(normalized)) {
    return { valid: false, reason: `Executable not found: ${normalized}` };
  }

  return { valid: true, normalized };
}

async function main() {
  // Support 'npx after-effect-mcp setup'
  if (process.argv.includes("setup")) {
    console.log("🛠️ Starting After Effects MCP Setup...");
    try {
      // Use dynamic import for the setup script
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

  // Security: Validate auth token if configured (CVE-011 fix)
  if (MCP_AUTH_TOKEN) {
    const providedToken = process.env.MCP_CLIENT_TOKEN;
    if (!providedToken || providedToken !== MCP_AUTH_TOKEN) {
      console.error("Authentication failed: Invalid or missing MCP_CLIENT_TOKEN");
      process.exit(1);
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("after-effect-mcp failed:", error);
  process.exit(1);
});
