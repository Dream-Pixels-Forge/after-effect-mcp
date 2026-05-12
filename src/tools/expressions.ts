/**
 * Expression tools for After Effects MCP Server
 * Based on wiki/sources/ae-mcp-expression-tools.md
 */

import { z } from "zod";
import { validateExtendScriptSecurity, sanitizeInput } from "../security.js";

export interface ExpressionToolContext {
  runScript: (code: string, options?: { timeoutMs?: number; keepTempFiles?: boolean }) => Promise<{
    ok: boolean;
    value?: unknown;
    error?: string;
  }>;
  escapeForJsString: (value: string) => string;
}

function validatePropertyPath(propertyPath: string): { valid: boolean; reason?: string } {
  const parts = propertyPath.split(".");
  const validRoot = parts[0] === "Transform" || parts[0] === "Effects";
  const validParts = parts.length >= 2 && parts.every((part) => /^[A-Za-z][\w -]*$/.test(part));

  if (!validRoot || !validParts) {
    return { valid: false, reason: `Invalid property path: ${propertyPath}. Use format like "Transform.Position" or "Effects.Gaussian Blur.Blurriness"` };
  }
  return { valid: true };
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

function propertyAccessor(rootExpression: string, propertyPath: string): string {
  return sanitizeInput(propertyPath, 200)
    .split(".")
    .map((part) => `.property("${part}")`)
    .reduce((expression, access) => expression + access, rootExpression);
}

export function registerExpressionTools(
  server: any,
  context: ExpressionToolContext
) {
  // ae_set_expression - Set expression on any property
  server.registerTool(
    "ae_set_expression",
    {
      description: "Set an expression on an After Effects property. Expressions must be ES3-compatible (use var, function, not arrow functions).",
      inputSchema: {
        compId: z.number().int().positive().describe("Composition id from ae_list_comps."),
        layerIndex: z.number().int().min(1).describe("Layer index in the composition."),
        propertyPath: z.string().min(1).describe("Property path, e.g. 'Transform.Position', 'Transform.Scale', 'Effects.Gaussian Blur.Blurriness'."),
        expression: z.string().min(1).describe("ExtendScript expression. Must be ES3 syntax: use 'var', 'function()', not arrow functions or template literals."),
        enabled: z.boolean().default(true).describe("Whether to enable the expression after setting."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ compId, layerIndex, propertyPath, expression, enabled }: {
      compId: number;
      layerIndex: number;
      propertyPath: string;
      expression: string;
      enabled: boolean;
    }) => {
      // Security: Validate property path
      const pathValidation = validatePropertyPath(propertyPath);
      if (!pathValidation.valid) {
        return {
          content: [{ type: "text" as const, text: `Error: ${pathValidation.reason}` }],
          structuredContent: { ok: false, error: pathValidation.reason },
        };
      }

      // Security: Validate expression code
      const validation = validateExtendScriptSecurity(expression);
      if (!validation.valid) {
        return {
          content: [{ type: "text" as const, text: `Security error: ${validation.reason}` }],
          structuredContent: { ok: false, error: validation.reason },
        };
      }

      // Security: Sanitize inputs
      const sanitizedExpression = sanitizeInput(expression, 5000);
      const propAccessor = propertyAccessor("layer", propertyPath);

      const code = `
if (!app.project) throw new Error("No project open");
${compLookupScript(compId)}
var layer = comp.layer(${layerIndex});
if (!layer) throw new Error("Layer not found: ${layerIndex}");
var prop = ${propAccessor};
if (!prop) throw new Error("Property not found: ${propertyPath}");
try {
    prop.expression = "${context.escapeForJsString(sanitizedExpression)}";
    prop.expressionEnabled = ${enabled};
    return { success: true, expression: prop.expression, enabled: prop.expressionEnabled };
} catch (e) {
    throw new Error("Failed to set expression: " + e.message);
}
`;
      const result = await context.runScript(code);
      return {
        content: [{ type: "text" as const, text: result.ok ? `Expression set:\n${JSON.stringify(result.value, null, 2)}` : `Failed: ${result.error}` }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ae_get_expression - Get current expression
  server.registerTool(
    "ae_get_expression",
    {
      description: "Get the current expression on an After Effects property.",
      inputSchema: {
        compId: z.number().int().positive().describe("Composition id."),
        layerIndex: z.number().int().min(1).describe("Layer index."),
        propertyPath: z.string().min(1).describe("Property path, e.g. 'Transform.Position'."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ compId, layerIndex, propertyPath }: {
      compId: number;
      layerIndex: number;
      propertyPath: string;
    }) => {
      const pathValidation = validatePropertyPath(propertyPath);
      if (!pathValidation.valid) {
        return {
          content: [{ type: "text" as const, text: `Error: ${pathValidation.reason}` }],
          structuredContent: { ok: false, error: pathValidation.reason },
        };
      }

      const code = `
if (!app.project) throw new Error("No project open");
${compLookupScript(compId)}
var layer = comp.layer(${layerIndex});
if (!layer) throw new Error("Layer not found");
var prop = ${propertyAccessor("layer", propertyPath)};
if (!prop) throw new Error("Property not found: ${propertyPath}");
return { expression: prop.expression || null, enabled: prop.expressionEnabled };
`;
      const result = await context.runScript(code);
      return {
        content: [{ type: "text" as const, text: result.ok ? JSON.stringify(result.value, null, 2) : `Failed: ${result.error}` }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ae_remove_expression - Remove an expression
  server.registerTool(
    "ae_remove_expression",
    {
      description: "Remove the expression from an After Effects property without deleting the property value.",
      inputSchema: {
        compId: z.number().int().positive().describe("Composition id."),
        layerIndex: z.number().int().min(1).describe("Layer index."),
        propertyPath: z.string().min(1).describe("Property path."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ compId, layerIndex, propertyPath }: {
      compId: number;
      layerIndex: number;
      propertyPath: string;
    }) => {
      const pathValidation = validatePropertyPath(propertyPath);
      if (!pathValidation.valid) {
        return {
          content: [{ type: "text" as const, text: `Error: ${pathValidation.reason}` }],
          structuredContent: { ok: false, error: pathValidation.reason },
        };
      }

      const code = `
if (!app.project) throw new Error("No project open");
${compLookupScript(compId)}
var layer = comp.layer(${layerIndex});
if (!layer) throw new Error("Layer not found");
var prop = ${propertyAccessor("layer", propertyPath)};
if (!prop) throw new Error("Property not found: ${propertyPath}");
prop.expression = "";
return { success: true, message: "Expression removed" };
`;
      const result = await context.runScript(code);
      return {
        content: [{ type: "text" as const, text: result.ok ? "Expression removed successfully" : `Failed: ${result.error}` }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ae_enable_expression - Enable/disable expression
  server.registerTool(
    "ae_enable_expression",
    {
      description: "Enable or disable an expression without removing it.",
      inputSchema: {
        compId: z.number().int().positive().describe("Composition id."),
        layerIndex: z.number().int().min(1).describe("Layer index."),
        propertyPath: z.string().min(1).describe("Property path."),
        enabled: z.boolean().describe("True to enable, false to disable."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ compId, layerIndex, propertyPath, enabled }: {
      compId: number;
      layerIndex: number;
      propertyPath: string;
      enabled: boolean;
    }) => {
      const pathValidation = validatePropertyPath(propertyPath);
      if (!pathValidation.valid) {
        return {
          content: [{ type: "text" as const, text: `Error: ${pathValidation.reason}` }],
          structuredContent: { ok: false, error: pathValidation.reason },
        };
      }

      const code = `
if (!app.project) throw new Error("No project open");
${compLookupScript(compId)}
var layer = comp.layer(${layerIndex});
if (!layer) throw new Error("Layer not found");
var prop = ${propertyAccessor("layer", propertyPath)};
if (!prop) throw new Error("Property not found: ${propertyPath}");
prop.expressionEnabled = ${enabled};
return { success: true, enabled: prop.expressionEnabled };
`;
      const result = await context.runScript(code);
      return {
        content: [{ type: "text" as const, text: result.ok ? `Expression ${enabled ? 'enabled' : 'disabled'}` : `Failed: ${result.error}` }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ae_add_wiggle_expression - Add wiggle to property
  server.registerTool(
    "ae_add_wiggle_expression",
    {
      description: "Add a wiggle() expression to an After Effects property for random movement.",
      inputSchema: {
        compId: z.number().int().positive().describe("Composition id."),
        layerIndex: z.number().int().min(1).describe("Layer index."),
        propertyPath: z.string().min(1).describe("Property path, e.g. 'Transform.Position'."),
        frequency: z.number().positive().default(5).describe("Wiggle frequency (times per second)."),
        amplitude: z.number().positive().default(50).describe("Wiggle amplitude (pixel movement)."),
        octaves: z.number().int().min(1).max(10).default(1).describe("Wiggle detail level."),
        ampMultiplier: z.number().min(0).max(1).default(0.5).describe("Amplitude multiplier per octave."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ compId, layerIndex, propertyPath, frequency, amplitude, octaves, ampMultiplier }: {
      compId: number;
      layerIndex: number;
      propertyPath: string;
      frequency: number;
      amplitude: number;
      octaves: number;
      ampMultiplier: number;
    }) => {
      const pathValidation = validatePropertyPath(propertyPath);
      if (!pathValidation.valid) {
        return {
          content: [{ type: "text" as const, text: `Error: ${pathValidation.reason}` }],
          structuredContent: { ok: false, error: pathValidation.reason },
        };
      }

      const expression = `wiggle(${frequency}, ${amplitude}, ${octaves}, ${ampMultiplier})`;
      const code = `
if (!app.project) throw new Error("No project open");
${compLookupScript(compId)}
var layer = comp.layer(${layerIndex});
if (!layer) throw new Error("Layer not found");
var prop = ${propertyAccessor("layer", propertyPath)};
if (!prop) throw new Error("Property not found: ${propertyPath}");
prop.expression = "${expression}";
return { success: true, expression: "${expression}" };
`;
      const result = await context.runScript(code);
      return {
        content: [{ type: "text" as const, text: result.ok ? `Wiggle expression added:\n${JSON.stringify(result.value, null, 2)}` : `Failed: ${result.error}` }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ae_add_loop_expression - Add loop expression
  server.registerTool(
    "ae_add_loop_expression",
    {
      description: "Add a loop expression to an After Effects property for repeating animations.",
      inputSchema: {
        compId: z.number().int().positive().describe("Composition id."),
        layerIndex: z.number().int().min(1).describe("Layer index."),
        propertyPath: z.string().min(1).describe("Property path."),
        loopType: z.enum(["cycle", "pingpong", "offset"]).default("cycle").describe("Loop type."),
        numKeyframes: z.number().int().min(0).default(0).describe("Number of keyframes to loop (0 = all)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ compId, layerIndex, propertyPath, loopType, numKeyframes }: {
      compId: number;
      layerIndex: number;
      propertyPath: string;
      loopType: string;
      numKeyframes: number;
    }) => {
      const pathValidation = validatePropertyPath(propertyPath);
      if (!pathValidation.valid) {
        return {
          content: [{ type: "text" as const, text: `Error: ${pathValidation.reason}` }],
          structuredContent: { ok: false, error: pathValidation.reason },
        };
      }

      const expression = `loopOut("${loopType}", ${numKeyframes})`;
      const code = `
if (!app.project) throw new Error("No project open");
${compLookupScript(compId)}
var layer = comp.layer(${layerIndex});
if (!layer) throw new Error("Layer not found");
var prop = ${propertyAccessor("layer", propertyPath)};
if (!prop) throw new Error("Property not found: ${propertyPath}");
prop.expression = "${expression}";
return { success: true, expression: "${expression}" };
`;
      const result = await context.runScript(code);
      return {
        content: [{ type: "text" as const, text: result.ok ? `Loop expression added:\n${JSON.stringify(result.value, null, 2)}` : `Failed: ${result.error}` }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ae_link_properties - Link properties with expression
  server.registerTool(
    "ae_link_properties",
    {
      description: "Link a property to another layer's property using expressions.",
      inputSchema: {
        compId: z.number().int().positive().describe("Composition id."),
        sourceLayer: z.number().int().min(1).describe("Source layer index (property to read from)."),
        sourceProperty: z.string().min(1).describe("Source property path."),
        targetLayer: z.number().int().min(1).describe("Target layer index (property to control)."),
        targetProperty: z.string().min(1).describe("Target property path."),
        linkType: z.enum(["direct", "multiply", "add"]).default("direct").describe("How to link the properties."),
        multiplier: z.number().default(1).describe("Multiplier for multiply/add operations."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ compId, sourceLayer, sourceProperty, targetLayer, targetProperty, linkType, multiplier }: {
      compId: number;
      sourceLayer: number;
      sourceProperty: string;
      targetLayer: number;
      targetProperty: string;
      linkType: string;
      multiplier: number;
    }) => {
      const srcPathValidation = validatePropertyPath(sourceProperty);
      const tgtPathValidation = validatePropertyPath(targetProperty);
      if (!srcPathValidation.valid || !tgtPathValidation.valid) {
        return {
          content: [{ type: "text" as const, text: `Error: Invalid property path` }],
          structuredContent: { ok: false, error: "Invalid property path" },
        };
      }

      let expression: string;
      const sourceAccessor = propertyAccessor(`thisComp.layer(${sourceLayer})`, sourceProperty);
      if (linkType === "multiply") {
        expression = `${sourceAccessor} * ${multiplier}`;
      } else if (linkType === "add") {
        expression = `${sourceAccessor} + ${multiplier}`;
      } else {
        expression = sourceAccessor;
      }

      const code = `
if (!app.project) throw new Error("No project open");
${compLookupScript(compId)}
var targetLayer = comp.layer(${targetLayer});
if (!targetLayer) throw new Error("Target layer not found");
var prop = ${propertyAccessor("targetLayer", targetProperty)};
if (!prop) throw new Error("Target property not found: ${targetProperty}");
prop.expression = "${context.escapeForJsString(expression)}";
return { success: true, expression: "${context.escapeForJsString(expression)}" };
`;
      const result = await context.runScript(code);
      return {
        content: [{ type: "text" as const, text: result.ok ? `Properties linked:\n${JSON.stringify(result.value, null, 2)}` : `Failed: ${result.error}` }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ae_add_expression_control - Add expression control effect
  server.registerTool(
    "ae_add_expression_control",
    {
      description: "Add an expression control effect (slider, point, angle, checkbox, color, layer) to a layer.",
      inputSchema: {
        compId: z.number().int().positive().describe("Composition id."),
        layerIndex: z.number().int().min(1).describe("Layer index."),
        controlType: z.enum(["slider", "point", "angle", "checkbox", "color", "layer"]).describe("Type of control effect."),
        controlName: z.string().min(1).describe("Name for the control effect."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ compId, layerIndex, controlType, controlName }: {
      compId: number;
      layerIndex: number;
      controlType: string;
      controlName: string;
    }) => {
      const sanitizedName = sanitizeInput(controlName, 200);
      const effectMap: Record<string, string> = {
        slider: "ADBE Slider Control",
        point: "ADBE Point Control",
        angle: "ADBE Angle Control",
        checkbox: "ADBE Checkbox Control",
        color: "ADBE Color Control",
        layer: "ADBE Layer Control",
      };
      const effectMatchName = effectMap[controlType] || effectMap.slider;

      const code = `
if (!app.project) throw new Error("No project open");
${compLookupScript(compId)}
var layer = comp.layer(${layerIndex});
if (!layer) throw new Error("Layer not found");
var effect = layer.property("Effects").addProperty("${effectMatchName}");
effect.name = "${context.escapeForJsString(sanitizedName)}";
return { success: true, effectName: effect.name, matchName: effect.matchName };
`;
      const result = await context.runScript(code);
      return {
        content: [{ type: "text" as const, text: result.ok ? `Expression control added:\n${JSON.stringify(result.value, null, 2)}` : `Failed: ${result.error}` }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    }
  );

  // ae_batch_set_expressions - Set multiple expressions
  server.registerTool(
    "ae_batch_set_expressions",
    {
      description: "Set multiple expressions at once for efficiency.",
      inputSchema: {
        compId: z.number().int().positive().describe("Composition id."),
        expressions: z.array(z.object({
          layerIndex: z.number().int().min(1),
          propertyPath: z.string().min(1),
          expression: z.string().min(1),
          enabled: z.boolean().default(true),
        })).min(1).describe("Array of expression objects to set."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ compId, expressions }: {
      compId: number;
      expressions: Array<{
        layerIndex: number;
        propertyPath: string;
        expression: string;
        enabled: boolean;
      }>;
    }) => {
      const results: Array<{ layerIndex: number; propertyPath: string; success: boolean; error?: string }> = [];

      for (const expr of expressions) {
        const pathValidation = validatePropertyPath(expr.propertyPath);
        if (!pathValidation.valid) {
          results.push({ layerIndex: expr.layerIndex, propertyPath: expr.propertyPath, success: false, error: pathValidation.reason });
          continue;
        }

        const validation = validateExtendScriptSecurity(expr.expression);
        if (!validation.valid) {
          results.push({ layerIndex: expr.layerIndex, propertyPath: expr.propertyPath, success: false, error: validation.reason });
          continue;
        }

        const code = `
if (!app.project) throw new Error("No project open");
${compLookupScript(compId)}
var layer = comp.layer(${expr.layerIndex});
if (!layer) throw new Error("Layer not found");
var prop = ${propertyAccessor("layer", expr.propertyPath)};
if (!prop) throw new Error("Property not found: ${expr.propertyPath}");
prop.expression = "${context.escapeForJsString(sanitizeInput(expr.expression, 5000))}";
prop.expressionEnabled = ${expr.enabled};
`;
        const result = await context.runScript(code);
        results.push({ layerIndex: expr.layerIndex, propertyPath: expr.propertyPath, success: result.ok, error: result.error });
      }

      return {
        content: [{ type: "text" as const, text: `Batch expressions complete:\n${JSON.stringify(results, null, 2)}` }],
        structuredContent: { results } as unknown as Record<string, unknown>,
      };
    }
  );
}
