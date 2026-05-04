/*
AE MCP Bridge - CEP Extension
Monitors a folder for command files and executes them in After Effects
*/

#target aftereffects

var g = {
    commissionId: "com.dreampixels.ae-mcp-bridge",
    mcpVersion: "1.0.0"
};

var PERSIST_PREFIX = "AE_MCP_Bridge_v1_";

var state = {
    watchDir: null,
    autoProcess: true,
    lastProcessed: null,
    commandCount: 0,
    errorCount: 0
};

function getWatchFolder() {
    var userData = Folder.userData;
    var mcpDir = new Folder(userData.fullName + "/AE-MCP");
    if (!mcpDir.exists) mcpDir.create();
    
    var commandsDir = new Folder(mcpDir.fullName + "/commands");
    if (!commandsDir.exists) commandsDir.create();
    
    var resultsDir = new Folder(mcpDir.fullName + "/results");
    if (!resultsDir.exists) resultsDir.create();
    
    return commandsDir;
}

function getResultsFolder() {
    var userData = Folder.userData;
    return new Folder(userData.fullName + "/AE-MCP/results");
}

function escapeForJsString(value) {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}

function makeWrapper(userCode, resultPath) {
    var escapedUserCode = userCode
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\r/g, "\\r")
        .replace(/\$/g, "\\$");

    return "#target aftereffects\n" +
        "(function afterEffectMcpWrapper() {\n" +
        "    function stringify(value) {\n" +
        "        var type = typeof value;\n" +
        "        if (value === null) return \"null\";\n" +
        "        if (type === \"number\" || type === \"boolean\") return String(value);\n" +
        "        if (type === \"string\") {\n" +
        "            var escaped = \"\";\n" +
        "            for (var s = 0; s < value.length; s++) {\n" +
        "                var ch = value.charAt(s);\n" +
        "                var code = value.charCodeAt(s);\n" +
        "                if (ch === \"\\\\\") escaped += \"\\\\\\\\\";\n" +
        "                else if (ch === '\"') escaped += '\\\\\"';\n" +
        "                else if (ch === \"\\b\") escaped += \"\\\\b\";\n" +
        "                else if (ch === \"\\f\") escaped += \"\\\\f\";\n" +
        "                else if (ch === \"\\n\") escaped += \"\\\\n\";\n" +
        "                else if (ch === \"\\r\") escaped += \"\\\\r\";\n" +
        "                else if (ch === \"\\t\") escaped += \"\\\\t\";\n" +
        "                else if (code < 16) escaped += \"\\\\u000\" + code.toString(16);\n" +
        "                else if (code < 32) escaped += \"\\\\u00\" + code.toString(16);\n" +
        "                else escaped += ch;\n" +
        "            }\n" +
        "            return '\"' + escaped + '\"';\n" +
        "        }\n" +
        "        if (value instanceof Array) {\n" +
        "            var arr = [];\n" +
        "            for (var i = 0; i < value.length; i++) arr.push(stringify(value[i]));\n" +
        "            return \"[\" + arr.join(\",\") + \"]\";\n" +
        "        }\n" +
        "        if (type === \"object\") {\n" +
        "            var props = [];\n" +
        "            for (var key in value) {\n" +
        "                if (value.hasOwnProperty(key) && typeof value[key] !== \"function\") {\n" +
        "                    props.push(stringify(key) + \":\" + stringify(value[key]));\n" +
        "                }\n" +
        "            }\n" +
        "            return \"{\" + props.join(\",\") + \"}\";\n" +
        "        }\n" +
        "        return stringify(String(value));\n" +
        "    }\n" +
        "    function writeResult(payload) {\n" +
        "        var f = new File(\"" + escapeForJsString(resultPath) + "\");\n" +
        "        f.encoding = \"UTF-8\";\n" +
        "        f.open(\"w\");\n" +
        "        f.write(stringify(payload));\n" +
        "        f.close();\n" +
        "    }\n" +
        "    app.beginSuppressDialogs();\n" +
        "    try {\n" +
        "        var __mcpResult = (function () {\n" +
        escapedUserCode.split("\\n").map(function(line) { return "            " + line; }).join("\\n") +
        "        })();\n" +
        "        writeResult({ ok: true, value: __mcpResult });\n" +
        "    } catch (e) {\n" +
        "        writeResult({ ok: false, error: String(e && e.message ? e.message : e), line: e && e.line ? e.line : null });\n" +
        "    } finally {\n" +
        "        app.endSuppressDialogs(false);\n" +
        "    }\n" +
        "})();";
}

function validateExtendScriptSecurity(code) {
    var forbiddenPatterns = [
        /app\.system/i,
        /app\.exit/i,
        /File\.write/i,
        /File\.copy/i,
        /File\.save/i,
        /File\.remove/i,
        /File\.rename/i,
        /Folder\.create/i,
        /Folder\.remove/i,
        /eval\s*\(/i,
        /include\s*\(/i,
        /\$\.(?:evalFile|eval|write|writeln)/i
    ];
    
    for (var i = 0; i < forbiddenPatterns.length; i++) {
        if (forbiddenPatterns[i].test(code)) {
            return { valid: false, reason: "Forbidden pattern: " + forbiddenPatterns[i].source };
        }
    }
    return { valid: true };
}

function executeCommand(commandFile, resultFile) {
    var command = null;
    var commandText = "";
    
    try {
        commandFile.open("r");
        commandText = commandFile.read();
        commandFile.close();
        
        command = eval("(" + commandText + ")");
    } catch (e) {
        writeResult(resultFile, { ok: false, error: "Invalid JSON: " + e.message });
        return;
    }
    
    if (!command || !command.code) {
        writeResult(resultFile, { ok: false, error: "Missing 'code' in command" });
        return;
    }
    
    var validation = validateExtendScriptSecurity(command.code);
    if (!validation.valid) {
        writeResult(resultFile, { ok: false, error: "Security: " + validation.reason });
        return;
    }
    
    var jsxFile = new File(state.watchDir.fullName + "/temp_" + Math.random().toString(36).substr(2, 9) + ".jsx");
    var resultPath = state.watchDir.parent.fullName + "/results/" + resultFile.name;
    
    jsxFile.open("w");
    jsxFile.write(makeWrapper(command.code, resultPath));
    jsxFile.close();
    
    try {
        $.evalFile(jsxFile);
        
        var resultFilePath = new File(resultPath);
        var maxWait = command.timeout || 30000;
        var waited = 0;
        var interval = 200;
        
        while (!resultFilePath.exists && waited < maxWait) {
            $.sleep(interval);
            waited += interval;
        }
        
        if (resultFilePath.exists) {
            resultFilePath.open("r");
            var resultText = resultFilePath.read();
            resultFilePath.close();
            resultFilePath.remove();
            
            commandFile.remove();
            jsxFile.remove();
            
            writeResult(resultFile, eval("(" + resultText + ")"));
        } else {
            writeResult(resultFile, { ok: false, error: "Script timeout after " + (maxWait/1000) + "s" });
        }
    } catch (e) {
        writeResult(resultFile, { ok: false, error: "Execute: " + e.message });
    }
    
    if (jsxFile.exists) jsxFile.remove();
}

function writeResult(resultFile, data) {
    resultFile.open("w");
    resultFile.write(data.toSource());
    resultFile.close();
}

function processCommands() {
    if (!state.watchDir || !state.watchDir.exists) {
        state.watchDir = getWatchFolder();
    }
    
    try {
        var files = state.watchDir.getFiles("*.json");
        
        for (var i = 0; i < files.length; i++) {
            var cmdFile = files[i];
            var resultFileName = cmdFile.name.replace(".json", "_result.json");
            var resultFile = new File(state.watchDir.parent.fullName + "/results/" + resultFileName);
            
            if (!resultFile.exists) {
                executeCommand(cmdFile, resultFile);
                state.lastProcessed = cmdFile.name;
                state.commandCount++;
            }
        }
    } catch (e) {
        state.errorCount++;
        $.writeln("AE MCP Error: " + e.message);
    }
}

var pollInterval = null;

function startPolling() {
    if (pollInterval) return;
    
    state.watchDir = getWatchFolder();
    pollInterval = setInterval(processCommands, 500);
}

function stopPolling() {
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
}

function getCEPState() {
    return {
        watchFolder: state.watchDir ? state.watchDir.fullName : null,
        autoProcess: state.autoProcess,
        commandCount: state.commandCount,
        errorCount: state.errorCount,
        lastProcessed: state.lastProcessed,
        hasProject: !!app.project,
        aeVersion: app.version,
        aePath: app.path
    };
}

function setAutoProcess(enabled) {
    state.autoProcess = enabled;
    if (enabled && !pollInterval) {
        startPolling();
    } else if (!enabled && pollInterval) {
        stopPolling();
    }
}

function init() {
    startPolling();
    $.writeln("AE MCP Bridge started - watching: " + getWatchFolder().fullName);
}

init();