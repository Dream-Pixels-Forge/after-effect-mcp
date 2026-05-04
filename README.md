# After Effect MCP

![After Effect MCP banner](assets/banner.svg)

Local MCP server for Codex, OpenCode, and other MCP clients that lets ChatGPT inspect and automate Adobe After Effects through ExtendScript.

The server runs over MCP stdio, launches `afterfx.com` or `AfterFX.exe` with a temporary JSX wrapper, and returns structured JSON results back to the MCP client.

![After Effect MCP gif](assets/ae_mcp.gif)

## Requirements

- Node.js 18 or newer.
- Adobe After Effects installed.
- After Effects scripting access enabled:
  `Edit > Preferences > Scripting & Expressions > Allow Scripts To Write Files And Access Network`.
- For live automation, keep After Effects open before calling MCP tools.

## 🚀 Zero-Install Setup (npx)

If you have Node.js installed, you can set up everything with one command without even cloning the repository:

```powershell
npx -y github:Dream-Pixels-Forge/after-effect-mcp setup
```

This will automatically build the server, install CEP extension, and configure your MCP clients.

## 📦 Local Setup (Recommended for Developers)

If you have cloned the repository:

```powershell
npm install
npm run setup
```

This script will:

1. Build the MCP server.
2. Detect your After Effects installation and copy the CEP extension.
3. Update your MCP client configurations with the correct paths.

## 🛠️ Manual Install

If you prefer to set up manually:

1. **Install Dependencies & Build**:
   ```powershell
   npm install
   npm run build
   ```
2. **Copy CEP Extension**: Copy `cep-extension/` folder to After Effects `CEPPlugIns` folder.
3. **Configure MCP Client**: Follow the instructions in [Connecting to MCP Clients](#connecting-to-mcp-clients).

## 🗑️ Uninstalling

If you need to remove the MCP server and its components:

### Automated Uninstall

```powershell
npx -y github:Dream-Pixels-Forge/after-effect-mcp uninstall
# OR if you have the repo:
npm run uninstall
```

### Manual Uninstall

1. **Remove CEP Extension**: Delete `AE-MCP-Bridge` folder from your AE `CEPPlugIns` folder.
2. **Clean Config**: Remove the `after-effects` entry from your MCP client config.
3. **Delete Project**: Delete the `after-effect-mcp` directory.

## 🔌 Connecting to MCP Clients

### Option 1: Using npx from GitHub (Zero-Install)

No cloning or building required:

```powershell
# npx downloads and runs directly from GitHub
npx -y github:Dream-Pixels-Forge/after-effect-mcp
```

### Claude Desktop

Add this to your `claude_desktop_config.json` (found in `%APPDATA%\Claude\claude_desktop_config.json` on Windows or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

**Using npx from GitHub (recommended):**
```json
{
  "mcpServers": {
    "after-effects": {
      "command": "npx",
      "args": ["-y", "github:Dream-Pixels-Forge/after-effect-mcp"],
      "env": {
        "MCP_ALLOWED_DIRS": "<path to your projects folder>"
      }
    }
  }
}
```

**Using local build:**
```json
{
  "mcpServers": {
    "after-effects": {
      "command": "node",
      "args": ["<absolute path to after-effect-mcp>/build/index.js"],
      "env": {
        "MCP_ALLOWED_DIRS": "<path to your projects folder>"
      }
    }
  }
}
```

### VSCode (Cline / Roo Code)

Same format as Claude Desktop. Add to your MCP settings JSON.

### OpenCode

Add to your `opencode.jsonc`:

```jsonc
{
  "mcp": {
    "after_effects": {
      "type": "local",
      "command": ["npx", "-y", "github:Dream-Pixels-Forge/after-effect-mcp"],
      "enabled": true,
      "environment": {
        "MCP_ALLOWED_DIRS": "<path to your projects folder>"
      }
    }
  }
}
```

### Codex

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.after_effects]
command = "npx"
args = ["-y", "github:Dream-Pixels-Forge/after-effect-mcp"]
env_vars = ["MCP_ALLOWED_DIRS"]
```

Replace `<path to your projects folder>` with your actual projects directory path. If After Effects is already on your `PATH` or auto-detection works, you can omit the `environment`/`env_vars` block.

## Available Tools

- `ae_find_executable`: find the After Effects executable used by the server.
- `ae_project_summary`: inspect the open project, active item, comps, footage, folders, and render queue.
- `ae_eval`: run ExtendScript in After Effects and return JSON-serializable data. (Sandboxed: dangerous commands like `app.system` are blocked).
- `ae_run_script_file`: run an existing `.jsx` or `.jsxbin` file.
- `ae_create_comp`: create a composition.
- `ae_list_comps`: list project compositions.
- `ae_add_text_layer`: add a text layer to a composition.
- `ae_add_solid`: add a solid layer to a composition.
- `ae_import_file`: import media or project files.
- `ae_open_project`: open an `.aep` project file.
- `ae_save_project`: save the current project.
- `ae_queue_render`: add a comp to the render queue without starting render.

## Example Prompts

```text
Use the after_effects MCP tool to summarize the open After Effects project.
```

```text
Create a new 1920x1080 composition named mcp_gpt_test.
```

```text
Create a simple animated title sequence in After Effects with text layers and keyframes.
```

![After Effect MCP gif](assets/ae_mcp2.gif)

## Example `ae_eval`

Use ES3 ExtendScript syntax. After Effects ExtendScript does not support modern JavaScript features like `let`, `const`, arrow functions, promises, classes, or modules.

```javascript
if (!app.project) app.newProject();
app.beginUndoGroup("MCP Example");
try {
  var comp = app.project.items.addComp("MCP Test", 1920, 1080, 1, 5, 30);
  var text = comp.layers.addText("Hello from MCP");
  text.property("Transform").property("Position").setValue([960, 540]);
  comp.openInViewer();
  return { comp: comp.name, layer: text.name };
} finally {
  app.endUndoGroup();
}
```

## Tests

All project tests have been run successfully during implementation.

Completed checks:

- `npm test`: passed.
- TypeScript build: passed.
- After Effects executable path check: passed.
- MCP stdio tool discovery smoke test: passed.
- Live After Effects CEP extension test: passed after After Effects was opened.

Do not rerun live After Effects tests unless After Effects is open and you explicitly want to exercise the running application.

Useful commands:

```powershell
npm test
```

```powershell
npm run test:live
```

## Notes

- MCP stdio servers must not write normal logs to stdout because stdout carries JSON-RPC protocol messages.
- This server writes errors to stderr only.
- `ae_eval` scripts should return JSON-serializable values.
- For reliable automation, keep After Effects open before calling tools.

## Security

### Security Model

This MCP server executes Adobe ExtendScript code in After Effects. Key security features:

- **ExtendScript Whitelist**: Blocks dangerous patterns (`app.system`, `File.write`, `eval(`, etc.)
- **Path Validation**: All file operations restricted to allowed directories via `MCP_ALLOWED_DIRS`
- **Executable Validation**: After Effects executable path is validated
- **Rate Limiting**: 100 requests per minute per client
- **Source Maps Disabled**: No source map files in production builds

### Environment Variables

| Variable             | Purpose                                              | Default           | Security                  |
| -------------------- | ---------------------------------------------------- | ----------------- | ------------------------- |
| `AFTERFX_PATH`       | Explicit After Effects executable path               | Auto-detect       | Validated                 |
| `AFTER_EFFECTS_PATH` | Alternative path variable                            | Auto-detect       | Validated                 |
| `MCP_ALLOWED_DIRS`   | Semicolon-separated allowed directories for file ops | Current directory | **Required for security** |

### Security Audit

A comprehensive security audit and remediation was completed on 2026-05-04:

- **15 vulnerabilities fixed** (5 Critical, 5 High, 5 Medium)
- **Zero critical or high-risk vulnerabilities remaining**
- **Improved ExtendScript Sandbox**: Blocks bracket-notation bypasses and dangerous file/system operations.
- **Strict Path Validation**: All file-related tools (import, open, save, render) now strictly enforce `MCP_ALLOWED_DIRS`.

See `docs/SECURITY.md` for full audit details and remediation history.

### CEP Extension (Recommended)

The CEP extension runs inside After Effects for more reliable execution:

1. **Auto-install**: Run `npm run setup` to automatically copy the CEP extension
2. **Manual install**: Copy `cep-extension/` folder to:
   - **Windows**: `C:\Program Files\Adobe\Adobe After Effects <version>\Support Files\CEPPlugIns\`
   - **macOS**: `/Applications/Adobe After Effects <version>/CEPPlugIns/`
3. **Enable in AE**: Go to `Window > Extensions > AE MCP Bridge`
4. **Auto Process**: Turn on "Auto Process" in the panel for automatic command handling

### File Bridge Mode

For environments that need file-based communication:

```powershell
npm run start:bridge
```

This uses the CEP extension to execute commands reliably without stdio.

### Report Security Issues

For security concerns, review `docs/SECURITY.md` or open an issue with the "security" label.
