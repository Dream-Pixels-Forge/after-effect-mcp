/**
 * Basic AE tools for After Effects MCP Server
 * Contains: project_summary, create_comp, list_comps, add_text_layer, add_solid,
 *            import_file, open_project, save_project, queue_render, run_script_file, find_executable, eval
 */

import { z } from "zod";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  checkRateLimit,
  validatePathSecurity,
  validateExtendScriptSecurity,
  sanitizeInput,
  checkAuth,
} from "../security.js";
import {
  runAfterEffectsScript,
  findAfterEffectsExecutable,
  escapeForJsString,
  textResponse,
  prettyJson,
} from "../ae-wrapper.js";

export interface ToolContext {
  runScript: (code: string, options?: { timeoutMs?: number; keepTempFiles?: boolean }) => Promise<any>;
  escape: (value: string) => string;
}

export function registerBasicTools(server: any): void {
  // ae_find_executable
  server.registerTool(
    "ae_find_executable",
    {
      description: "Find the After Effects command-line executable that will be used by this MCP server.",
      inputSchema: {
        executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path to validate."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ executablePath }: any) => {
      const path = findAfterEffectsExecutable(executablePath);
      const exists = existsSync(path);
      return textResponse(
        exists ? `After Effects executable found: ${path}` : `No concrete executable found. The server will try command: ${path}`,
        { path, exists },
      );
    },
  );

  // ae_project_summary
  server.registerTool(
    "ae_project_summary",
    {
      description: "Inspect the open After Effects project: file, active comp, item counts, comps, footage, and render queue size.",
      inputSchema: {
        executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ executablePath, timeoutMs }: any) => {
      const code = `
var project = app.project;
var summary = {
    hasProject: !!project,
    file: project && project.file ? project.file.fsName : null,
    items: [],
    counts: { comps: 0, footage: 0, folders: 0, other: 0 },
    activeItem: null,
    renderQueueItems: project ? project.renderQueue.numItems : 0
};
if (project) {
    if (project.activeItem) {
        summary.activeItem = {
            name: project.activeItem.name,
            typeName: project.activeItem.typeName || String(project.activeItem)
        };
    }
    for (var i = 1; i <= project.items.length; i++) {
        var item = project.item(i);
        var type = "other";
        if (item instanceof CompItem) {
            type = "comp";
            summary.counts.comps++;
        } else if (item instanceof FootageItem) {
            type = "footage";
            summary.counts.footage++;
        } else if (item instanceof FolderItem) {
            type = "folder";
            summary.counts.folders++;
        } else {
            summary.counts.other++;
        }
        summary.items.push({
            index: i,
            id: item.id,
            name: item.name,
            type: type,
            width: item.width || null,
            height: item.height || null,
            duration: item.duration || null
        });
    }
}
return summary;`;
      const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
      return textResponse(result.ok ? prettyJson(result.value) : `After Effects inspection failed: ${result.error}`, result as any);
    },
  );

  // ae_create_comp
  server.registerTool(
    "ae_create_comp",
    {
      description: "Create a composition in the current After Effects project.",
      inputSchema: {
        name: z.string().min(1).describe("Composition name."),
        width: z.number().int().min(1).max(32768).default(1920),
        height: z.number().int().min(1).max(32768).default(1080),
        duration: z.number().positive().max(86400).default(10),
        frameRate: z.number().positive().max(240).default(30),
        pixelAspect: z.number().positive().default(1),
        executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, width, height, duration, frameRate, pixelAspect, executablePath, timeoutMs }: any) => {
      const sanitizedName = sanitizeInput(name, 200);
      const code = `
if (!app.project) app.newProject();
app.beginUndoGroup("MCP Create Comp");
try {
    var comp = app.project.items.addComp("${escapeForJsString(sanitizedName)}", ${width}, ${height}, ${pixelAspect}, ${duration}, ${frameRate});
    return { id: comp.id, name: comp.name, width: comp.width, height: comp.height, duration: comp.duration, frameRate: comp.frameRate };
} finally {
    app.endUndoGroup();
}`;
      const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
      return textResponse(result.ok ? `Created composition:\n${prettyJson(result.value)}` : `Could not create comp: ${result.error}`, result as any);
    },
  );

  // ae_list_comps
  server.registerTool(
    "ae_list_comps",
    {
      description: "List compositions in the current After Effects project.",
      inputSchema: {
        executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ executablePath, timeoutMs }: any) => {
      const code = `
if (!app.project) return [];
var comps = [];
for (var i = 1; i <= app.project.items.length; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem) {
        comps.push({
            index: i,
            id: item.id,
            name: item.name,
            width: item.width,
            height: item.height,
            duration: item.duration,
            frameRate: item.frameRate,
            layers: item.layers.length
        });
    }
}
return comps;`;
      const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
      return textResponse(result.ok ? prettyJson(result.value) : `Could not list comps: ${result.error}`, result as any);
    },
  );

  // ae_add_text_layer
  server.registerTool(
    "ae_add_text_layer",
    {
      description: "Add a text layer to a composition, defaulting to the active comp.",
      inputSchema: {
        text: z.string().min(1).describe("Text content for the new layer."),
        compName: z.string().optional().describe("Composition name. Uses active comp when omitted."),
        x: z.number().default(960).describe("Layer position X."),
        y: z.number().default(540).describe("Layer position Y."),
        fontSize: z.number().positive().max(1000).default(96),
        color: z.array(z.number().min(0).max(1)).length(3).default([1, 1, 1]).describe("RGB fill color, each channel 0..1."),
        startTime: z.number().min(0).default(0),
        duration: z.number().positive().optional().describe("Optional layer out point duration in seconds."),
        executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ text, compName, x, y, fontSize, color, startTime, duration, executablePath, timeoutMs }: any) => {
      const sanitizedText = sanitizeInput(text, 1000);
      const sanitizedCompName = compName ? sanitizeInput(compName, 200) : undefined;

      const compSelector = sanitizedCompName
        ? `
var comp = null;
for (var i = 1; i <= app.project.items.length; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem && item.name === "${escapeForJsString(sanitizedCompName ?? "")}") {
        comp = item;
        break;
    }
}`
        : `
var comp = app.project.activeItem instanceof CompItem ? app.project.activeItem : null;`;
      const outPointLine = duration ? `layer.outPoint = ${startTime + duration};` : "";
      const code = `
if (!app.project) throw new Error("No After Effects project is open.");
${compSelector}
if (!(comp instanceof CompItem)) throw new Error("No target composition found.");
app.beginUndoGroup("MCP Add Text Layer");
try {
    var layer = comp.layers.addText("${escapeForJsString(text)}");
    layer.startTime = ${startTime};
    ${outPointLine}
    layer.property("Transform").property("Position").setValue([${x}, ${y}]);
    var doc = layer.property("Source Text").value;
    doc.fontSize = ${fontSize};
    doc.fillColor = [${color[0]}, ${color[1]}, ${color[2]}];
    layer.property("Source Text").setValue(doc);
    return { comp: comp.name, layer: layer.name, index: layer.index, text: "${escapeForJsString(text)}" };
} finally {
    app.endUndoGroup();
}`;
      const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
      return textResponse(result.ok ? `Added text layer:\n${prettyJson(result.value)}` : `Could not add text layer: ${result.error}`, result as any);
    },
  );

  // ae_add_solid
  server.registerTool(
    "ae_add_solid",
    {
      description: "Add a solid layer to a composition, defaulting to the active comp.",
      inputSchema: {
        name: z.string().min(1).default("MCP Solid"),
        compName: z.string().optional().describe("Composition name. Uses active comp when omitted."),
        color: z.array(z.number().min(0).max(1)).length(3).default([0.1, 0.1, 0.1]).describe("RGB solid color, each channel 0..1."),
        width: z.number().int().positive().optional().describe("Solid width. Defaults to comp width."),
        height: z.number().int().positive().optional().describe("Solid height. Defaults to comp height."),
        duration: z.number().positive().optional().describe("Solid duration. Defaults to comp duration."),
        executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ name, compName, color, width, height, duration, executablePath, timeoutMs }: any) => {
      const sanitizedName = sanitizeInput(name, 200);
      const sanitizedCompName = compName ? sanitizeInput(compName, 200) : undefined;

      const compSelector = sanitizedCompName
        ? `
var comp = null;
for (var i = 1; i <= app.project.items.length; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem && item.name === "${escapeForJsString(sanitizedCompName ?? "")}") {
        comp = item;
        break;
    }
}`
        : `
var comp = app.project.activeItem instanceof CompItem ? app.project.activeItem : null;`;
      const code = `
if (!app.project) throw new Error("No After Effects project is open.");
${compSelector}
if (!(comp instanceof CompItem)) throw new Error("No target composition found.");
app.beginUndoGroup("MCP Add Solid");
try {
    var layer = comp.layers.addSolid([${color[0]}, ${color[1]}, ${color[2]}], "${escapeForJsString(name)}", ${width ?? "comp.width"}, ${height ?? "comp.height"}, 1, ${duration ?? "comp.duration"});
    return { comp: comp.name, layer: layer.name, index: layer.index, width: layer.width, height: layer.height };
} finally {
    app.endUndoGroup();
}`;
      const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
      return textResponse(result.ok ? `Added solid layer:\n${prettyJson(result.value)}` : `Could not add solid layer: ${result.error}`, result as any);
    },
  );

  // ae_import_file
  server.registerTool(
    "ae_import_file",
    {
      description: "Import a media or project file into the current After Effects project.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path to the file to import."),
        executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, executablePath, timeoutMs }: any) => {
      const pathValidation = validatePathSecurity(path);
      if (!pathValidation.valid) {
        return textResponse(`Security error: ${pathValidation.reason}`, { ok: false, error: pathValidation.reason });
      }
      const normalized = pathValidation.normalized!;
      const code = `
if (!app.project) app.newProject();
var file = new File("${escapeForJsString(normalized)}");
if (!file.exists) throw new Error("File does not exist: " + file.fsName);
app.beginUndoGroup("MCP Import File");
try {
    var item = app.project.importFile(new ImportOptions(file));
    return { id: item.id, name: item.name, path: file.fsName, typeName: item.typeName || null };
} finally {
    app.endUndoGroup();
}`;
      const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
      return textResponse(result.ok ? `Imported ${basename(normalized)}:\n${prettyJson(result.value)}` : `Could not import file: ${result.error}`, result as any);
    },
  );

  // ae_open_project
  server.registerTool(
    "ae_open_project",
    {
      description: "Open an After Effects project file.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path to an .aep project file."),
        executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, executablePath, timeoutMs }: any) => {
      const pathValidation = validatePathSecurity(path);
      if (!pathValidation.valid) {
        return textResponse(`Security error: ${pathValidation.reason}`, { ok: false, error: pathValidation.reason });
      }
      const normalized = pathValidation.normalized!;
      const code = `
var file = new File("${escapeForJsString(normalized)}");
if (!file.exists) throw new Error("Project file does not exist: " + file.fsName);
var project = app.open(file);
return { file: project.file ? project.file.fsName : file.fsName, items: project.items.length };`;
      const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
      return textResponse(result.ok ? `Opened project:\n${prettyJson(result.value)}` : `Could not open project: ${result.error}`, result as any);
    },
  );

  // ae_save_project
  server.registerTool(
    "ae_save_project",
    {
      description: "Save the current After Effects project, optionally to a new path.",
      inputSchema: {
        path: z.string().optional().describe("Optional absolute .aep path. If omitted, saves the current project file."),
        executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, executablePath, timeoutMs }: any) => {
      let normalized: string | undefined;
      if (path) {
        const pathValidation = validatePathSecurity(path);
        if (!pathValidation.valid) {
          return textResponse(`Security error: ${pathValidation.reason}`, { ok: false, error: pathValidation.reason });
        }
        normalized = pathValidation.normalized!;
      }
      const saveLine = normalized ? `app.project.save(new File("${escapeForJsString(normalized)}"));` : "app.project.save();";
      const code = `
if (!app.project) throw new Error("No After Effects project is open.");
${saveLine}
return { file: app.project.file ? app.project.file.fsName : null, items: app.project.items.length };`;
      const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
      return textResponse(result.ok ? `Saved project:\n${prettyJson(result.value)}` : `Could not save project: ${result.error}`, result as any);
    },
  );

  // ae_queue_render
  server.registerTool(
    "ae_queue_render",
    {
      description: "Add a composition to the render queue and optionally set the output path. This does not start rendering.",
      inputSchema: {
        compName: z.string().min(1).describe("Composition name to add to the render queue."),
        outputPath: z.string().optional().describe("Optional absolute output file path."),
        renderSettingsTemplate: z.string().optional().describe("Optional render settings template name."),
        outputModuleTemplate: z.string().optional().describe("Optional output module template name."),
        executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ compName, outputPath, renderSettingsTemplate, outputModuleTemplate, executablePath, timeoutMs }: any) => {
      if (outputPath) {
        const pathValidation = validatePathSecurity(outputPath);
        if (!pathValidation.valid) {
          return textResponse(`Security error: ${pathValidation.reason}`, { ok: false, error: pathValidation.reason });
        }
      }

      const sanitizedCompName = sanitizeInput(compName, 200);
      const outputLine = outputPath ? `om.file = new File("${escapeForJsString(validatePathSecurity(outputPath).normalized!)}");` : "";
      const renderSettingsLine = renderSettingsTemplate ? `rqItem.applyTemplate("${escapeForJsString(renderSettingsTemplate)}");` : "";
      const outputTemplateLine = outputModuleTemplate ? `om.applyTemplate("${escapeForJsString(outputModuleTemplate)}");` : "";
      const code = `
if (!app.project) throw new Error("No After Effects project is open.");
var comp = null;
for (var i = 1; i <= app.project.items.length; i++) {
    var item = app.project.item(i);
    if (item instanceof CompItem && item.name === "${escapeForJsString(sanitizedCompName ?? "")}") {
        comp = item;
        break;
    }
}
if (!(comp instanceof CompItem)) throw new Error("Composition not found: ${escapeForJsString(sanitizedCompName ?? "")}");
app.beginUndoGroup("MCP Queue Render");
try {
    var rqItem = app.project.renderQueue.items.add(comp);
    ${renderSettingsLine}
    var om = rqItem.outputModule(1);
    ${outputTemplateLine}
    ${outputLine}
    return { comp: comp.name, renderQueueIndex: rqItem.index, output: om.file ? om.file.fsName : null };
} finally {
    app.endUndoGroup();
}`;
      const result = await runAfterEffectsScript({ code, executablePath, timeoutMs });
      return textResponse(result.ok ? `Queued render:\n${prettyJson(result.value)}` : `Could not queue render: ${result.error}`, result as any);
    },
  );

  // ae_run_script_file
  server.registerTool(
    "ae_run_script_file",
    {
      description: "Run an existing JSX file in After Effects using $.evalFile and return the script result when possible.",
      inputSchema: {
        path: z.string().min(1).describe("Absolute path to a JSX or JSXBIN file."),
        executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
        timeoutMs: z.number().int().min(1000).max(300000).optional(),
        keepTempFiles: z.boolean().optional().describe("Keep generated wrapper/result files for debugging."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ path, executablePath, timeoutMs, keepTempFiles }: any) => {
      const pathValidation = validatePathSecurity(path);
      if (!pathValidation.valid) {
        return textResponse(`Security error: ${pathValidation.reason}`, { ok: false, error: pathValidation.reason });
      }
      const normalized = pathValidation.normalized!;
      const code = `
var scriptFile = new File("${escapeForJsString(normalized)}");
if (!scriptFile.exists) throw new Error("Script file does not exist: " + scriptFile.fsName);
return $.evalFile(scriptFile);`;
      const result = await runAfterEffectsScript({ code, executablePath, timeoutMs, keepTempFiles, allowEvalFile: true });
      return textResponse(result.ok ? `Ran ${normalized}:\n${prettyJson(result.value ?? null)}` : `Could not run script file: ${result.error}`, result as any);
    },
  );

  // ae_eval
  server.registerTool(
    "ae_eval",
    {
      description: "Run ExtendScript in the current After Effects instance and return a JSON-serializable result.",
      inputSchema: {
        code: z.string().min(1).describe("ExtendScript body to run. Use ES3 syntax with var/function, not modern JavaScript."),
        executablePath: z.string().optional().describe("Optional explicit AfterFX.exe or afterfx.com path."),
        timeoutMs: z.number().int().min(1000).max(300000).optional().describe("Timeout in milliseconds. Defaults to 30000."),
        keepTempFiles: z.boolean().optional().describe("Keep generated JSX/result files for debugging."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ code, executablePath, timeoutMs, keepTempFiles }: any) => {
      // Security: Validate ExtendScript code
      const validation = validateExtendScriptSecurity(code);
      if (!validation.valid) {
        return textResponse(`Security error: ${validation.reason}`, { ok: false, error: validation.reason });
      }

      // Security: Sanitize input
      const sanitizedCode = sanitizeInput(code, 10000);

      const result = await runAfterEffectsScript({ code: sanitizedCode, executablePath, timeoutMs, keepTempFiles });
      const text = result.ok
        ? `After Effects script completed.\n\n${prettyJson(result.value ?? null)}`
        : `After Effects script failed: ${result.error}\n\nstderr:\n${result.stderr || "(empty)"}`;
      return textResponse(text, result as any);
    },
  );
}
