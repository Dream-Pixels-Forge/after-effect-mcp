/**
 * After Effects wrapper - script execution and ExtendScript generation
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execSync } from "node:child_process";
import { validateAfterEffectsExecutable, validateExtendScriptSecurity, sanitizeInput } from "./security.js";

const DEFAULT_TIMEOUT_MS = 30000;
const WORK_DIR_BASE = join(tmpdir(), "after-effect-mcp");

export interface AeRunResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  scriptPath?: string;
  resultPath?: string;
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
}

export function escapeForJsString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function makeWrapper(userCode: string, resultPath: string, options: { allowEvalFile?: boolean } = {}): string {
  // Security: Validate user code before wrapping
  const validation = validateExtendScriptSecurity(userCode, options);
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
                if (ch === "\\\\") escaped += "\\\\\\";
                else if (ch === '"') escaped += '\\"';
                else if (ch === "\\b") escaped += "\\b";
                else if (ch === "\\f") escaped += "\\f";
                else if (ch === "\\n") escaped += "\\n";
                else if (ch === "\\r") escaped += "\\r";
                else if (ch === "\\t") escaped += "\\t";
                else if (code < 16) escaped += "\\u000" + code.toString(16);
                else if (code < 32) escaped += "\\u00" + code.toString(16);
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

export async function runAfterEffectsScript(options: {
  code: string;
  executablePath?: string;
  timeoutMs?: number;
  keepTempFiles?: boolean;
  allowEvalFile?: boolean;
}): Promise<AeRunResult> {
  // Security: Rate limiting is handled by caller
  const workDir = join(WORK_DIR_BASE);
  mkdirSync(workDir, { recursive: true });
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const scriptPath = join(workDir, `mcp-${stamp}.jsx`);
  const resultPath = join(workDir, `mcp-${stamp}.json`);
  writeFileSync(scriptPath, makeWrapper(options.code, resultPath, { allowEvalFile: options.allowEvalFile }), "utf8");

  const executable = findAfterEffectsExecutable(options.executablePath);

  // Security: Validate AE executable path
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

  let payload: { ok: boolean; value?: unknown; error?: string } = {
    ok: false,
    error: `After Effects did not write a result file. Make sure After Effects is running and Preferences > Scripting & Expressions > Allow Scripts To Write Files And Access Network is enabled.`,
  };

  if (existsSync(resultPath)) {
    try {
      payload = JSON.parse(readFileSync(resultPath, "utf8")) as typeof payload;
    } catch (error) {
      const errorMessage = (error as Error).message || "Unknown error";
      payload = { ok: false, error: `Could not parse After Effects result: ${errorMessage.substring(0, 200)}` };
    }
  }

  if (!options.keepTempFiles) {
    for (const path of [scriptPath, resultPath]) {
      try {
        if (existsSync(path)) unlinkSync(path);
      } catch {
        // Temp cleanup should not hide the AE result.
      }
    }
  }

  return {
    ok: payload.ok,
    value: payload.value,
    error: payload.error,
    exitCode,
    timedOut,
    stderr,
  };
}

export function findAfterEffectsExecutable(explicitPath?: string): string {
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

export function textResponse(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

export function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
