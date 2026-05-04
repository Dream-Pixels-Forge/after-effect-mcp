# MCP Configuration Examples

## Quick Setup (Recommended)

Run `npm run setup` to automatically configure your MCP clients. This will:
- Copy CEP extension to After Effects
- Generate config files for Claude Desktop, VSCode (Cline/Roo Code), and OpenCode

## Option 1: Using npx from GitHub (Zero-Install)

No cloning or building needed:

### OpenCode
```jsonc
{
  "mcp": {
    "after_effects": {
      "type": "local",
      "command": ["npx", "-y", "github:Dream-Pixels-Forge/after-effect-mcp"],
      "enabled": true,
      "environment": {
        "MCP_ALLOWED_DIRS": "<path to your projects>"
      }
    }
  }
}
```

### Claude Desktop / VSCode (Cline, Roo Code)
```json
{
  "mcpServers": {
    "after-effects": {
      "command": "npx",
      "args": ["-y", "github:Dream-Pixels-Forge/after-effect-mcp"],
      "env": {
        "MCP_ALLOWED_DIRS": "<path to your projects>"
      }
    }
  }
}
```

### Codex
```toml
[mcp_servers.after_effects]
command = "npx"
args = ["-y", "github:Dream-Pixels-Forge/after-effect-mcp"]
env_vars = ["MCP_ALLOWED_DIRS"]
```

## Option 2: Using Local Build

If you've cloned the repository:

### OpenCode
```jsonc
{
  "mcp": {
    "after_effects": {
      "type": "local",
      "command": ["node", "<path to after-effect-mcp>/build/index.js"],
      "enabled": true,
      "environment": {
        "MCP_ALLOWED_DIRS": "<path to your projects>"
      }
    }
  }
}
```

### Claude Desktop / VSCode
```json
{
  "mcpServers": {
    "after-effects": {
      "command": "node",
      "args": ["<path to after-effect-mcp>/build/index.js"],
      "env": {
        "MCP_ALLOWED_DIRS": "<path to your projects>"
      }
    }
  }
}
```

## Option 3: Using File Bridge (CEP Extension)

For more reliable execution via CEP extension:
```jsonc
{
  "mcp": {
    "after_effects": {
      "type": "local",
      "command": ["npx", "-y", "github:Dream-Pixels-Forge/after-effect-mcp", "start:bridge"],
      "enabled": true,
      "environment": {
        "MCP_ALLOWED_DIRS": "<path to your projects>"
      }
    }
  }
}
```

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `MCP_ALLOWED_DIRS` | Allowed directories for file operations | Current directory |
| `AFTERFX_PATH` | Explicit After Effects executable path | Auto-detect |
| `AFTER_EFFECTS_PATH` | Alternative AE path variable | Auto-detect |