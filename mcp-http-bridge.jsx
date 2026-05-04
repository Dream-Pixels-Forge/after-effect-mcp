/*
After Effects MCP Connection Panel - HTTP Bridge Version
Place in: Support Files/Scripts/ScriptUI Panels/MCPPanel.jsx

This version communicates via HTTP to a local Node.js bridge server.
*/

#target aftereffects

// ============================================
// Configuration
// ============================================

var CONFIG = {
    host: "localhost",
    port: 7687,
    timeout: 30000,
    retryCount: 3,
    retryDelay: 1000
};

// ============================================
// HTTP Request via app.system (curl simulation)
// ============================================

function httpRequest(method, path, data) {
    var result = {
        ok: false,
        statusCode: 0,
        body: null,
        error: null
    };
    
    var tempDir = Folder.temp.fullName;
    var inFile = new File(tempDir + "/mcp_in.txt");
    var outFile = new File(tempDir + "/mcp_out.txt");
    var errFile = new File(tempDir + "/mcp_err.txt");
    
    // Clean files
    [inFile, outFile, errFile].forEach(function(f) {
        if (f.exists) f.remove();
    });
    
    // Build curl command
    var curlCmd = 'curl -s';
    
    if (method === "POST") {
        // Write body to temp file
        inFile.open("w");
        inFile.write(data);
        inFile.close();
        curlCmd += ' -X POST -H "Content-Type: application/json" -d @"' + inFile.fullName + '"';
    }
    
    curlCmd += ' http://' + CONFIG.host + ':' + CONFIG.port + path;
    curlCmd += ' -o "' + outFile.fullName + '" -e "' + errFile.fullName + '"';
    curlCmd += ' -m ' + (CONFIG.timeout / 1000);
    
    // Execute
    try {
        app.system(curlCmd);
        
        // Read response
        if (outFile.exists) {
            outFile.open("r");
            result.body = outFile.read();
            outFile.close();
            result.ok = true;
            result.statusCode = 200;
        }
        
        // Check for errors
        if (errFile.exists) {
            errFile.open("r");
            var err = errFile.read();
            errFile.close();
            if (err.length > 0 && err.indexOf("Failed") >= 0) {
                result.error = err;
                result.statusCode = 500;
            }
        }
    } catch(e) {
        result.error = e.message;
    }
    
    // Cleanup
    [inFile, outFile, errFile].forEach(function(f) {
        if (f.exists) f.remove();
    });
    
    return result;
}

// Alternative: Direct MCP command via stdin/stdout (for local Node process)
function sendMCPCommand(command) {
    var tempDir = Folder.temp.fullName;
    var inFile = new File(tempDir + "/mcp_cmd_in.txt");
    var outFile = new File(tempDir + "/mcp_cmd_out.txt");
    
    // Clean
    if (inFile.exists) inFile.remove();
    if (outFile.exists) outFile.remove();
    
    // Write command
    inFile.open("w");
    inFile.write(command);
    inFile.close();
    
    // This would need a local Node.js process running
    // For now, return a simulation
    return {
        ok: true,
        result: "Simulated: " + command
    };
}

// ============================================
// UI Panel
// ============================================

var mcpWindow = null;
var statusLabel = null;
var connectBtn = null;
var outputText = null;
var isConnected = false;

function createMCPPanel() {
    if (mcpWindow !== null) {
        mcpWindow.close();
    }
    
    mcpWindow = new Window("palette", "MCP Connection", [0, 0, 400, 420]);
    mcpWindow.orientation = "column";
    mcpWindow.alignChildren = ["fill", "top"];
    mcpWindow.spacing = 8;
    mcpWindow.margins = 15;
    
    // Header
    var header = mcpWindow.add("statictext", undefined, "🎬 After Effects MCP Server");
    header.font = "bold sans-serif:14";
    header.justify = "center";
    
    mcpWindow.add("statictext", undefined, "────────────────────────────────");
    
    // Server Config
    mcpWindow.add("statictext", undefined, "Server: " + CONFIG.host + ":" + CONFIG.port);
    
    // Status
    var statusRow = mcpWindow.add("group", [0, 0, 200, 25]);
    statusRow.add("statictext", undefined, "Status:");
    statusLabel = statusRow.add("statictext", [60, 0, 180, 20], "Disconnected");
    statusLabel.font = "bold";
    statusLabel.foregroundColor = [1, 0, 0];
    
    // Connect Button
    connectBtn = mcpWindow.add("button", [0, 0, 100, 30], "Connect");
    connectBtn.onClick = function() {
        if (isConnected) {
            disconnect();
        } else {
            connect();
        }
    };
    
    // Quick Actions
    mcpWindow.add("statictext", undefined, "────────── Quick Actions ──────────");
    
    var btnRow = mcpWindow.add("group");
    btnRow.orientation = "row";
    btnRow.spacing = 5;
    
    var actions = [
        ["Find AE", "ae_find_executable"],
        ["Project", "ae_project_summary"],
        ["Comps", "ae_list_comps"],
        ["New Comp", "ae_create_comp"]
    ];
    
    for (var i = 0; i < actions.length; i++) {
        var btn = btnRow.add("button", undefined, actions[i][0]);
        btn.onClick = (function(name) {
            return function() { runAction(name); };
        })(actions[i][1]);
    }
    
    // Output
    mcpWindow.add("statictext", undefined, "────────────── Output ──────────────");
    
    outputText = mcpWindow.add("edittext", [0, 0, 370, 120], "", {
        multiline: true,
        scrolling: true,
        readOnly: true
    });
    
    // Clear button
    var clearBtn = mcpWindow.add("button", undefined, "Clear Output");
    clearBtn.onClick = function() {
        outputText.text = "";
    };
    
    // Instructions
    var helpText = mcpWindow.add("statictext", undefined, "Tip: Start MCP server first: node build/index.js");
    helpText.font = "size:9";
    helpText.foregroundColor = [0.5, 0.5, 0.5];
    
    mcpWindow.center();
    mcpWindow.show();
}

function connect() {
    log("Attempting to connect to MCP server...");
    
    // Try HTTP request to check if server is running
    var testCmd = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"AE-MCP-Panel","version":"1.0"}}}';
    var response = httpRequest("POST", "/rpc", testCmd);
    
    if (response.ok) {
        isConnected = true;
        statusLabel.text = "Connected";
        statusLabel.foregroundColor = [0, 0.8, 0];
        connectBtn.text = "Disconnect";
        log("✓ Connected to MCP server!");
        
        // Send test request
        setTimeout(function() {
            var listCmd = '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}';
            var listResp = httpRequest("POST", "/rpc", listCmd);
            if (listResp.ok) {
                log("✓ MCP tools available");
            }
        }, 500);
    } else {
        statusLabel.text = "Failed";
        statusLabel.foregroundColor = [1, 0, 0];
        log("✗ Connection failed: " + (response.error || "Server not running"));
        log("Make sure MCP server is running: node build/index.js");
    }
}

function disconnect() {
    isConnected = false;
    statusLabel.text = "Disconnected";
    statusLabel.foregroundColor = [1, 0, 0];
    connectBtn.text = "Connect";
    log("Disconnected from MCP server");
}

function runAction(toolName) {
    if (!isConnected) {
        log("Not connected! Click Connect first.");
        return;
    }
    
    log("── Running: " + toolName + " ──");
    
    var request = {
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 10000),
        method: "tools/call",
        params: {
            name: toolName,
            arguments: {}
        }
    };
    
    var response = httpRequest("POST", "/rpc", request.toSource());
    
    if (response.ok && response.body) {
        // Parse response
        try {
            // Safer JSON parse for ExtendScript
            var json = null;
            try {
                json = eval("(" + response.body + ")");
            } catch(e) {
                // Try to clean up response if it has trailing/leading whitespace
                var cleaned = response.body.replace(/^\s+|\s+$/g, "");
                json = eval("(" + cleaned + ")");
            }

            if (json && json.result && json.result.content) {
                var text = json.result.content[0].text;
                log("✓ " + (text.length > 500 ? text.substring(0, 500) + "..." : text));
            } else if (json && json.error) {
                log("✗ Error: " + (json.error.message || json.error));
            } else {
                log("✓ Success (no content)");
            }
        } catch(e) {
            log("✗ Parse Error: " + e.message);
            if (response.body.length > 0) {
                log("Raw: " + response.body.substring(0, 100));
            }
        }
    } else {
        log("✗ Request failed: " + (response.error || "Unknown error (check if bridge is running)"));
    }
}

function log(msg) {
    var timestamp = new Date().toTimeString().substring(0, 8);
    outputText.text = "[" + timestamp + "] " + msg + "\n" + (outputText.text || "");
}

// Initialize
createMCPPanel();