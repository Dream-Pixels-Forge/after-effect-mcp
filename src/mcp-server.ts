import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runAfterEffectsScript } from "./ae-wrapper.js";
import { registerBasicTools } from "./tools/basic-tools.js";
import { registerExpressionTools } from "./tools/expressions.js";
import { registerLayerTools } from "./tools/layers.js";

export function createAfterEffectsMcpServer(): McpServer {
  const server = new McpServer({
    name: "after-effect-mcp",
    version: "0.2.0",
  });

  const toolContext = {
    runScript: async (code: string, options?: { timeoutMs?: number; keepTempFiles?: boolean }) => {
      const result = await runAfterEffectsScript({
        code,
        executablePath: undefined,
        timeoutMs: options?.timeoutMs,
        keepTempFiles: options?.keepTempFiles,
      });
      return {
        ok: result.ok,
        value: result.value,
        error: result.error,
      };
    },
    escapeForJsString: (value: string) => {
      return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
    },
  };

  registerBasicTools(server);
  registerExpressionTools(server, toolContext);
  registerLayerTools(server, toolContext);

  return server;
}
