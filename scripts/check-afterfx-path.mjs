import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function findAfterEffectsExecutable() {
  if (process.env.AFTERFX_PATH && existsSync(process.env.AFTERFX_PATH)) {
    return process.env.AFTERFX_PATH;
  }

  if (process.platform === "win32") {
    const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean);
    for (const root of roots) {
      const adobeRoot = join(root, "Adobe");
      if (!existsSync(adobeRoot)) continue;
      for (const entry of readdirSync(adobeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("Adobe After Effects")) continue;
        const afterfxCom = join(adobeRoot, entry.name, "Support Files", "AfterFX.com");
        const afterfxExe = join(adobeRoot, entry.name, "Support Files", "AfterFX.exe");
        if (existsSync(afterfxCom)) return afterfxCom;
        if (existsSync(afterfxExe)) return afterfxExe;
      }
    }
  }

  if (process.platform === "darwin") {
    const appRoot = "/Applications";
    if (existsSync(appRoot)) {
      for (const entry of readdirSync(appRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("Adobe After Effects")) continue;
        const appName = entry.name.replace(/\.app$/, "");
        const candidate = join(appRoot, entry.name, "Contents", "MacOS", appName);
        if (existsSync(candidate)) return candidate;
      }
    }
  }

  return null;
}

const expectedPath = findAfterEffectsExecutable();

if (!expectedPath) {
  console.error("After Effects executable not found.");
  console.error("Set AFTERFX_PATH to the full path of AfterFX.com or AfterFX.exe.");
  process.exit(1);
}

console.error(`After Effects executable found: ${expectedPath}`);
