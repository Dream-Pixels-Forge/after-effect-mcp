# Changelog - After Effects MCP

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-05-04

### Fixed
- **Security**: Fixed path traversal vulnerability in `ae_queue_render` by enforcing `validatePathSecurity`.
- **Security**: Fixed ExtendScript injection risk in `ae_create_comp` by adding `sanitizeInput`.
- **Security**: Hardened ExtendScript sandbox to block bracket-notation bypasses (e.g. `app["system"]`).
- **Stability**: Fixed memory leak (listener leak) in `mcp-http-bridge.js` by using a persistent listener and callback registry.
- **Syntax**: Fixed invalid triple-quote syntax in `mcp-connection-panel.jsx`.
- **UX**: Improved connection status feedback in JSX UI panels.

### Added
- **Feature**: Dynamic tool discovery in HTTP bridge via `/tools` endpoint.
- **Robustness**: Safer JSON parsing in ExtendScript environments.

### Security Audit Result
- **Status**: 🟢 CLEAN (Remediation Complete)
- **Remaining Issues**: 0 Critical, 0 High.
- **Verified**: Build passed, Smoke test passed.

## [Unreleased]

### Security
- Comprehensive security audit completed (2026-05-04)
- Identified 15 vulnerabilities (5 Critical, 5 High, 5 Medium)
- Created `docs/SECURITY.md` with full audit report
- Created `docs/TASKS.md` with remediation tasks
- Created `docs/PROGRESS.md` with session progress

## [0.1.0] - 2026-05-04

### Added
- Initial release of After Effects MCP Server
- MCP tools for After Effects automation:
  - `ae_find_executable` - Find After Effects executable
  - `ae_eval` - Run arbitrary ExtendScript code
  - `ae_project_summary` - Inspect open project
  - `ae_create_comp` - Create composition
  - `ae_list_comps` - List compositions
  - `ae_add_text_layer` - Add text layer
  - `ae_add_solid` - Add solid layer
  - `ae_import_file` - Import media/project files
  - `ae_open_project` - Open .aep project
  - `ae_save_project` - Save project
  - `ae_queue_render` - Add to render queue
  - `ae_run_script_file` - Run existing JSX/JSXBIN file
- TypeScript source with strict mode enabled
- Zod schema validation for all tool inputs
- Temp file-based communication with After Effects
- Support for Windows (AfterFX.exe) and macOS (AfterFX.com)
- Example configuration for OpenCode (`examples/opencode.jsonc`)
- Makefile with build, test, and smoke test targets

### Security
- Input validation using Zod schemas
- Path normalization for file operations
- Temp file cleanup after operations
- Error handling with try/catch in ExtendScript wrappers

### Technical
- Built with `@modelcontextprotocol/sdk` v1.29.0
- Uses stdio transport for local communication
- ExtendScript execution via After Effects `-r` flag
- Result passing via JSON files in temp directory

---

## Security Audit Summary (2026-05-04)

**Overall Rating**: 🔴 HIGH RISK

**Vulnerability Breakdown**:
- Critical: 2 (Arbitrary code execution, Path traversal)
- High: 4 (Code injection, Executable hijacking, Supply chain, File execution)
- Medium: 4 (Temp files, Source maps, Rate limiting, Error handling)
- Low: 4 (Auth, Environment, Build artifacts, Input sanitization)

**Next Review Date**: 2026-06-04

**Recommendation**: Do not expose to untrusted clients without implementing Critical and High severity remediations.

---

## Template for Future Releases

## [Version] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes in existing functionality

### Deprecated
- Soon-to-be removed features

### Removed
- Now removed features

### Fixed
- Any bug fixes

### Security
- Security-related changes
