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
npx -y after-effect-mcp setup
```

This will automatically build the server, install After Effects panels, and configure your MCP clients.

## 📦 Local Setup (Recommended for Developers)

If you have cloned the repository:

```powershell
npm install
npm run setup
```

This script will:
1. Build the MCP server.
2. Detect your After Effects installation and copy the ScriptUI panels.
3. Update your `claude_desktop_config.json` with the correct paths.

## 🛠️ Manual Install

If you prefer to set up manually:

1. **Install Dependencies & Build**:
   ```powershell
   npm install
   npm run build
   ```
2. **Copy ScriptUI Panels**: Move `mcp-connection-panel.jsx` or `mcp-http-bridge.jsx` to your After Effects `Scripts/ScriptUI Panels` folder.
3. **Configure MCP Client**: Follow the instructions in [Connecting to MCP Clients](#connecting-to-mcp-clients).

## 🔌 Connecting to MCP Clients

### Claude Desktop
Add this to your `claude_desktop_config.json` (found in `%APPDATA%\Claude\claude_desktop_config.json` on Windows or `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "node",
      "args": ["<absolute path to after-effect-mcp>/build/index.js"],
      "env": {
        "MCP_ALLOWED_DIRS": "<absolute path to your projects folder>"
      }
    }
  }
}
```

### VSCode (Cline / Roo Code)
If you are using MCP-enabled extensions like **Cline** or **Roo Code**, add the configuration to their respective settings (usually `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "after-effects": {
      "command": "node",
      "args": ["<absolute path to after-effect-mcp>/build/index.js"],
      "env": {
        "MCP_ALLOWED_DIRS": "<absolute path to your projects folder>"
      }
    }
  }
}
```

### OpenCode & Codex
The easiest way is to use the included installer:

```powershell
npm run install:opencode
```

This will generate an `opencode.jsonc` file. For manual setup in **Codex**, use:

```jsonc
{
  "mcp": {
    "after_effects": {
      "type": "local",
      "command": ["node", "<absolute path to after-effect-mcp>/build/index.js"],
      "enabled": true,
      "environment": {
        "MCP_ALLOWED_DIRS": "<absolute path to your projects folder>"
      }
    }
  }
}
```

Replace both paths with the correct locations on your machine. If After Effects is already on your `PATH` or auto-detection works, you can omit the `environment` block.

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
- Live After Effects MCP bridge test: passed after After Effects was opened.

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

| Variable | Purpose | Default | Security |
|----------|---------|---------|----------|
| `AFTERFX_PATH` | Explicit After Effects executable path | Auto-detect | Validated |
| `AFTER_EFFECTS_PATH` | Alternative path variable | Auto-detect | Validated |
| `MCP_ALLOWED_DIRS` | Semicolon-separated allowed directories for file ops | Current directory | **Required for security** |

### Security Audit

A comprehensive security audit and remediation was completed on 2026-05-04:
- **15 vulnerabilities fixed** (5 Critical, 5 High, 5 Medium)
- **Zero critical or high-risk vulnerabilities remaining**
- **Improved ExtendScript Sandbox**: Blocks bracket-notation bypasses and dangerous file/system operations.
- **Strict Path Validation**: All file-related tools (import, open, save, render) now strictly enforce `MCP_ALLOWED_DIRS`.

See `docs/SECURITY.md` for full audit details and remediation history.

### ScriptUI Panels

To use the MCP interface directly inside After Effects:

1.  **Copy the Panels**: Move `mcp-connection-panel.jsx` or `mcp-http-bridge.jsx` to your After Effects `Scripts/ScriptUI Panels` folder.
    *   **Windows**: `C:\Program Files\Adobe\Adobe After Effects <version>\Support Files\Scripts\ScriptUI Panels\`
    *   **macOS**: `/Applications/Adobe After Effects <version>/Scripts/ScriptUI Panels/`
2.  **Enable Network Access**: In AE, go to `Preferences > Scripting & Expressions` and check **"Allow Scripts to Write Files and Access Network"**.
3.  **Launch the Panel**: Restart After Effects and find the panel under the **Window** menu.

> [!NOTE]
> The `mcp-http-bridge.jsx` version requires the Node.js bridge to be running: `node mcp-http-bridge.js`.

### HTTP Bridge Architecture

For environments that cannot use stdio directly (like After Effects ScriptUI), use the included HTTP Bridge:

1. **Start the Bridge**: `node mcp-http-bridge.js`
2. **Access Tools**: Connect via `mcp-http-bridge.jsx` in After Effects.
3. **Features**: Dynamic tool discovery, persistent connection management, and automated request-response mapping.

### Report Security Issues

For security concerns, review `docs/SECURITY.md` or open an issue with the "security" label.
