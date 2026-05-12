/**
 * Layer tools for After Effects MCP Server
 * Based on wiki/sources/ae-mcp-layer-ordering.md
 */

import { z } from "zod";
import { sanitizeInput } from "../security.js";

export interface LayerToolContext {
  runScript: (code: string, options?: { timeoutMs?: number; keepTempFiles?: boolean }) => Promise<{
    ok: boolean;
    value?: unknown;
    error?: string;
  }>;
  escapeForJsString: (value: string) => string;
}

function compLookupScript(compId: number): string {
  return `
var comp = null;
for (var __mcpItemIndex = 1; __mcpItemIndex <= app.project.items.length; __mcpItemIndex++) {
    var __mcpItem = app.project.item(__mcpItemIndex);
    if (__mcpItem instanceof CompItem && __mcpItem.id === ${compId}) {
        comp = __mcpItem;
        break;
    }
}
if (!comp) throw new Error("Composition not found: ${compId}");`;
}

export function registerLayerTools(
  server: any,
  context: LayerToolContext
) {
  // ae_reorder_layers - Move layer from one index to another
  server.registerTool(
    "ae_reorder_layers",
    {
      description: "Reorder layers in a composition. Move a layer from one index to another position in the stack. Remember: Layer 1 is on top, higher numbers are underneath.",
      inputSchema: {
        compId: z.number().int().positive().describe("Composition id from ae_list_comps."),
        layerIndex: z.number().int().min(1).describe("Current layer index (1-based, 1 = top)."),
        newIndex: z.number().int().min(1).describe("New index position (1 = top, higher = further back)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ compId, layerIndex, newIndex }: {
      compId: number;
      layerIndex: number;
      newIndex: number;
    }) => {
      const code = `
if (!app.project) throw new Error("No project open");
${compLookupScript(compId)}

app.beginUndoGroup("MCP Reorder Layers");
try {
    var layer = comp.layer(${layerIndex});
    if (!layer) throw new Error("Layer not found at index ${layerIndex}");
    var targetLayer = comp.layer(${newIndex});
    if (!targetLayer) throw new Error("Target layer not found at index ${newIndex}");
    
    // AE layer indices: 1 is top, moving layer to newIndex
    layer.moveTowardLayer(targetLayer);
    
    return { 
        success: true, 
        layerName: layer.name, 
        oldIndex: ${layerIndex}, 
        newIndex: ${newIndex},
        note: "Layer 1 is top, higher numbers are underneath"
    };
} finally {
    app.endUndoGroup();
}
`;
      const result = await context.runScript(code);
      return {
        content: [{ type: "text", text: result.ok ? `Layer reordered:\n${JSON.stringify(result.value, null, 2)}` : `Failed: ${result.error}` }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ae_batch_execute - Execute multiple commands sequentially
  server.registerTool(
    "ae_batch_execute",
    {
      description: "Execute multiple After Effects commands sequentially. Use for creating layers in correct order (foreground first, background LAST). Based on layer ordering guide.",
      inputSchema: {
        commands: z.array(z.object({
          tool: z.string().min(1).describe("Tool name to call (e.g. 'ae_add_text_layer', 'ae_add_solid')."),
          params: z.record(z.string(), z.any()).describe("Parameters for the tool."),
        })).min(1).describe("Array of commands to execute in order."),
        sequential: z.boolean().default(true).describe("Execute sequentially (true) or attempt parallel (false)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ commands, sequential }: {
      commands: Array<{
        tool: string;
        params: Record<string, unknown>;
      }>;
      sequential: boolean;
    }) => {
      const results: Array<{
        command: string;
        success: boolean;
        result?: unknown;
        error?: string;
      }> = [];

      // Build a comprehensive ExtendScript that executes all commands
      let script = `
app.beginUndoGroup("MCP Batch Execute");
var results = [];

try {
`;

      for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        const sanitizedTool = sanitizeInput(cmd.tool, 100);

        // Generate ExtendScript based on tool type
        switch (sanitizedTool) {
          case "ae_add_text_layer": {
            const p = cmd.params;
            const text = sanitizeInput(String(p.text || ""), 1000);
            const x = Number(p.x) || 960;
            const y = Number(p.y) || 540;
            const fontSize = Number(p.fontSize) || 96;
            const color = Array.isArray(p.color) ? p.color : [1, 1, 1];
            const name = sanitizeInput(String(p.name || "Text Layer"), 200);
            const compName = p.compName ? sanitizeInput(String(p.compName), 200) : null;

            const compInitializer = compName ? "null" : "app.project.activeItem";
            const compCheckCondition = compName ? "comp" : "comp || !(comp instanceof CompItem)";
            script += `
    // Command ${i + 1}: ${sanitizedTool}
    (function() {
        var comp = ${compInitializer};
        if (!${compCheckCondition}) {
            // Try to find by name
            if ("${compName || ""}" !== "") {
                for (var i = 1; i <= app.project.items.length; i++) {
                    var item = app.project.item(i);
                    if (item instanceof CompItem && item.name === "${context.escapeForJsString(compName || "")}") {
                        comp = item;
                        break;
                    }
                }
            }
        }
        if (!(comp instanceof CompItem)) throw new Error("No target composition");

        var layer = comp.layers.addText("${context.escapeForJsString(text)}");
        layer.startTime = ${Number(p.startTime) || 0};
        layer.property("Transform").property("Position").setValue([${x}, ${y}]);
        var doc = layer.property("Source Text").value;
        doc.fontSize = ${fontSize};
        doc.fillColor = [${color[0]}, ${color[1]}, ${color[2]}];
        layer.property("Source Text").setValue(doc);
        if ("${name}" !== "") layer.name = "${context.escapeForJsString(name)}";

        results.push({ command: ${i}, tool: "${sanitizedTool}", success: true, layerName: layer.name, index: layer.index });
    })();
`;
            break;
          }

          case "ae_add_solid": {
            const p = cmd.params;
            const name = sanitizeInput(String(p.name || "Solid"), 200);
            const color = Array.isArray(p.color) ? p.color : [0.1, 0.1, 0.1];
            const compName = p.compName ? sanitizeInput(String(p.compName), 200) : null;

            const solidCompInitializer = compName ? "null" : "app.project.activeItem";
            const solidCompCheckCondition = compName ? "comp" : "comp || !(comp instanceof CompItem)";
            script += `
    // Command ${i + 1}: ${sanitizedTool}
    (function() {
        var comp = ${solidCompInitializer};
        if (!${solidCompCheckCondition}) {
            if ("${compName || ""}" !== "") {
                for (var i = 1; i <= app.project.items.length; i++) {
                    var item = app.project.item(i);
                    if (item instanceof CompItem && item.name === "${context.escapeForJsString(compName || "")}") {
                        comp = item;
                        break;
                    }
                }
            }
        }
        if (!(comp instanceof CompItem)) throw new Error("No target composition");
        
        var layer = comp.layers.addSolid([${color[0]}, ${color[1]}, ${color[2]}], "${context.escapeForJsString(name)}", comp.width, comp.height, 1, comp.duration);
        results.push({ command: ${i}, tool: "${sanitizedTool}", success: true, layerName: layer.name, index: layer.index });
    })();
`;
            break;
          }

          case "ae_create_comp": {
            const p = cmd.params;
            const name = sanitizeInput(String(p.name || "Comp"), 200);

            const width = Number(p.width) || 1920;
            const height = Number(p.height) || 1080;
            const pixelAspect = Number(p.pixelAspect) || 1;
            const duration = Number(p.duration) || 10;
            const frameRate = Number(p.frameRate) || 30;
            script += `
    // Command ${i + 1}: ${sanitizedTool}
    (function() {
        if (!app.project) app.newProject();
        var comp = app.project.items.addComp("${context.escapeForJsString(name)}", ${width}, ${height}, ${pixelAspect}, ${duration}, ${frameRate});
        results.push({ command: ${i}, tool: "${sanitizedTool}", success: true, compName: comp.name, id: comp.id });
    })();
`;
            break;
          }

          default: {
            script += `
    // Command ${i + 1}: ${sanitizedTool} - NOT SUPPORTED
    results.push({ command: ${i}, tool: "${sanitizedTool}", success: false, error: "Tool not supported in batch mode" });
`;
          }
        }
      }

      script += `
    return results;
} finally {
    app.endUndoGroup();
}
`;

      // For now, execute as a single ExtendScript
      // TODO: In future, could call individual tool handlers
      const result = await context.runScript(script);

      // If the script failed, return error
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Batch execute failed: ${result.error}` }],
          structuredContent: { ok: false, error: result.error } as Record<string, unknown>,
        };
      }

      return {
        content: [{ type: "text", text: `Batch execute complete:\n${JSON.stringify(result.value, null, 2)}` }],
        structuredContent: { ok: true, results: result.value } as unknown as Record<string, unknown>,
      };
    }
  );

  // ae_list_layers - List all layers in a composition
  server.registerTool(
    "ae_list_layers",
    {
      description: "List all layers in a composition with their indices, names, types, and properties.",
      inputSchema: {
        compId: z.number().int().positive().describe("Composition id."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ compId }: { compId: number }) => {
      const code = `
if (!app.project) throw new Error("No project open");
${compLookupScript(compId)}

var layers = [];
for (var i = 1; i <= comp.layers.length; i++) {
    var layer = comp.layer(i);
    layers.push({
        index: i,
        name: layer.name,
        layerType: layer.matchName || "Unknown",
        active: layer.active,
        solo: layer.solo,
        shy: layer.shy,
        quality: layer.quality,
        indexInComp: layer.index
    });
}
return { compName: comp.name, layerCount: comp.layers.length, layers: layers };
`;
      const result = await context.runScript(code);
      return {
        content: [{ type: "text", text: result.ok ? JSON.stringify(result.value, null, 2) : `Failed: ${result.error}` }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );
}
