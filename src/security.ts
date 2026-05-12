/**
 * Security module for After Effects MCP Server
 * Extracted from src/index.ts for modularity
 */

import { existsSync } from "node:fs";
import { basename, resolve, normalize, sep } from "node:path";

// Security: Rate limiting (CVE-009 fix)
const requestCounts = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_MAX = 100; // Max requests per window
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute

// Security: Optional auth token for stdio transport (CVE-011 fix)
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

export function checkRateLimit(identifier: string): { allowed: boolean; retryAfter?: number } {
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
  /\$\.evalFile/i,
  /\$\.(?:eval|write|writeln)/i,
  /system\.callSystem/i,
  /executeCommand.*system/i,
  // Catch bracket notation access to sensitive properties
  /app\s*\[\s*['"](?:system|exit)['"]\s*\]/i,
  /File\s*\[\s*['"](?:write|copy|save|remove|rename)['"]\s*\]/i,
  /\$\s*\[\s*['"]evalFile['"]\s*\]/i,
  /\$\s*\[\s*['"](?:eval|write|writeln)['"]\s*\]/i,
];

// Security: Validate that a path is within allowed directories
export function validatePathSecurity(inputPath: string): { valid: boolean; reason?: string; normalized?: string } {
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
export function validateExtendScriptSecurity(
  code: string,
  options: { allowEvalFile?: boolean } = {},
): { valid: boolean; reason?: string } {
  for (const pattern of FORBIDDEN_EXTENDSCRIPT_PATTERNS) {
    if (options.allowEvalFile && pattern.source.includes("evalFile")) {
      continue;
    }
    if (pattern.test(code)) {
      return { valid: false, reason: `Forbidden pattern detected: ${pattern.source}` };
    }
  }
  return { valid: true };
}

// Security: Sanitize user input strings (CVE-014 fix)
export function sanitizeInput(input: string, maxLength: number = 1000): string {
  let sanitized = input.substring(0, maxLength);
  // Remove null bytes and other control characters except newlines/tabs
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return sanitized;
}

// Security: Validate AE executable path (CVE-004 fix)
export function validateAfterEffectsExecutable(executablePath: string): { valid: boolean; reason?: string; normalized?: string } {
  const isCommandName = !executablePath.includes("/") && !executablePath.includes("\\");
  const rawFileName = basename(executablePath).toLowerCase();
  const allowedNames = ["afterfx.exe", "afterfx.com", "afterfx"];

  if (isCommandName) {
    if (!allowedNames.includes(rawFileName)) {
      return { valid: false, reason: `Executable name not allowed: ${rawFileName}` };
    }
    return { valid: true, normalized: executablePath };
  }

  const normalized = normalize(resolve(executablePath));

  // Check for path traversal
  if (normalized !== resolve(executablePath)) {
    return { valid: false, reason: "Path traversal detected in executable path" };
  }

  // Must be a known AE executable name
  const fileName = normalized.toLowerCase().split(sep).pop() || "";
  if (!allowedNames.includes(fileName)) {
    return { valid: false, reason: `Executable name not allowed: ${fileName}` };
  }

  // Full path provided - must exist
  if (!existsSync(normalized)) {
    return { valid: false, reason: `Executable not found: ${normalized}` };
  }

  return { valid: true, normalized };
}

// Security: Check auth token if configured (CVE-011 fix)
export function checkAuth(): boolean {
  if (MCP_AUTH_TOKEN) {
    const providedToken = process.env.MCP_CLIENT_TOKEN;
    if (!providedToken || providedToken !== MCP_AUTH_TOKEN) {
      console.error("Authentication failed: Invalid or missing MCP_CLIENT_TOKEN");
      return false;
    }
  }
  return true;
}

export { ALLOWED_DIRECTORIES, RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS };
