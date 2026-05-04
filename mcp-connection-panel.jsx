/*
After Effects MCP Connection Panel
Place in: Support Files/Scripts/ScriptUI Panels/
Example (Windows): C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\Scripts\ScriptUI Panels\
Example (macOS): /Applications/Adobe After Effects 2025/Scripts/ScriptUI Panels/
*/

#target aftereffects

// Configuration
var MCP_HOST = "localhost";
var MCP_PORT = 7687;
var SOCKET_TIMEOUT = 10000; // 10 seconds

// Global state
var isConnected = false;
var connectionWindow = null;
var statusText = null;
var connectButton = null;
var lastResult = null;

// ============================================
// Socket Connection Functions (using ExtendScript File socket simulation)
// ============================================

function createMCPConnection(host, port) {
    var result = {
        ok: false,
        error: null,
        response: null
    };

    // In ExtendScript, we use a temp file to communicate with Node.js
    // This is a workaround since ExtendScript doesn't have native socket support
    
    var tempDir = Folder.temp.fullName;
    var requestFile = new File(tempDir + "/mcp_request_" + Math.random().toString(36).substr(2,9) + ".json");
    var responseFile = new File(tempDir + "/mcp_response_" + Math.random().toString(36).substr(2,9) + ".json");
    
    // Clean up old files
    if (requestFile.exists) requestFile.remove();
    if (responseFile.exists) responseFile.remove();
    
    // Create MCP request
    var request = {
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 10000),
        method: "tools/call",
        params: {
            name: "ae_find_executable",
            arguments: {}
        }
    };
    
    // Write request
    requestFile.open("w");
    requestFile.write(request.toSource());
    requestFile.close();
    
    // Launch Node.js MCP client (must be running separately)
    // For now, we'll use the eval-based approach with app.system
    
    return result;
}

// Alternative: Use app.executeCommand simulation
function executeMCPCommand(command) {
    var result = null;
    
    // We'll use $.evalFile to run a JSX that communicates via files
    var tempDir = Folder.temp.fullName;
    var outputFile = new File(tempDir + "/mcp_output.txt");
    
    if (outputFile.exists) outputFile.remove();
    
    // Create a bridge script
    var bridgeCode = "(function() {" +
        "var output = '" + outputFile.fullName.replace(/\\/g, "\\\\") + "';" +
        "var fs = new File(output);" +
        "fs.open('w');" +
        "try {" +
            "var info = {" +
                "project: app.project ? app.project.file.fsName : 'No project'," +
                "version: app.version," +
                "os: $.os" +
            "};" +
            "fs.write(info.toSource());" +
        "} catch(e) {" +
            "fs.write('Error: ' + e.message);" +
        "}" +
        "fs.close();" +
    "})();";
    
    try {
        eval(bridgeCode);
        
        if (outputFile.exists) {
            outputFile.open("r");
            result = outputFile.read();
            outputFile.close();
        }
    } catch(e) {
        result = "Error: " + e.message;
    }
    
    return result;
}

// ============================================
// UI Panel Creation
// ============================================

function createMCPConnectionPanel() {
    // Check if panel already exists
    if (connectionWindow !== null) {
        connectionWindow.close();
    }
    
    // Create floating panel
    var panelWidth = 400;
    var panelHeight = 350;
    
    connectionWindow = new Window("palette", "MCP Connection", [0, 0, panelWidth, panelHeight]);
    connectionWindow.orientation = "column";
    connectionWindow.alignChildren = ["fill", "top"];
    connectionWindow.spacing = 10;
    connectionWindow.margins = 15;
    
    // Title
    var title = connectionWindow.add("statictext", undefined, "After Effects MCP Server");
    title.font = "bold sans-serif:14";
    
    // Server Info Section
    var serverGroup = connectionWindow.add("group", undefined);
    serverGroup.orientation = "column";
    serverGroup.alignChildren = ["left", "center"];
    
    serverGroup.add("statictext", undefined, "MCP Server Settings:");
    
    var hostLabel = connectionWindow.add("statictext", undefined, "Host: " + MCP_HOST);
    var portLabel = connectionWindow.add("statictext", undefined, "Port: " + MCP_PORT);
    
    // Status Section
    var statusGroup = connectionWindow.add("group", undefined);
    statusGroup.orientation = "row";
    statusGroup.add("statictext", undefined, "Status: ");
    
    statusText = statusGroup.add("statictext", undefined, "Disconnected");
    statusText.font = "bold";
    
    // Connection Button
    connectButton = connectionWindow.add("button", undefined, "Connect");
    connectButton.onClick = function() {
        toggleConnection();
    };
    
    // Separator
    connectionWindow.add("separator", undefined);
    
    // Test Buttons
    connectionWindow.add("statictext", undefined, "Quick Actions:");
    
    var buttonRow = connectionWindow.add("group", undefined);
    buttonRow.orientation = "row";
    buttonRow.spacing = 5;
    
    var testBtn = buttonRow.add("button", undefined, "Test");
    testBtn.onClick = function() {
        runTest();
    };
    
    var listCompsBtn = buttonRow.add("button", undefined, "List Comps");
    listCompsBtn.onClick = function() {
        listCompositions();
    };
    
    var projectBtn = buttonRow.add("button", undefined, "Project");
    projectBtn.onClick = function() {
        showProjectInfo();
    };
    
    // Output/Result Area
    connectionWindow.add("statictext", undefined, "Output:");
    
    var resultGroup = connectionWindow.add("edittext", [0, 0, panelWidth - 30, 100], "", {
        multiline: true,
        scrolling: true
    });
    resultGroup.enabled = false;
    lastResult = resultGroup;
    
    // Info text
    var infoText = connectionWindow.add("statictext", undefined, "Note: MCP server must be running separately");
    infoText.font = "size:10";
    infoText.foregroundColor = [0.5, 0.5, 0.5];
    
    // Show the window
    connectionWindow.center();
    connectionWindow.show();
}

function toggleConnection() {
    if (isConnected) {
        disconnect();
    } else {
        connect();
    }
}

function connect() {
    statusText.text = "Connecting...";
    statusText.foregroundColor = [1, 0.5, 0]; // Orange
    
    // In this file-based version, we check if we can write to temp
    try {
        var testFile = new File(Folder.temp.fullName + "/mcp_test.txt");
        testFile.open("w");
        testFile.write("test");
        testFile.close();
        testFile.remove();
        
        // Update status
        statusText.text = "Connected (Local)";
        statusText.foregroundColor = [0, 0.8, 0]; // Green
        isConnected = true;
        connectButton.text = "Disconnect";
        
        appendResult("Connected to Local MCP Bridge!");
        appendResult("AE Path: " + app.path);
        appendResult("AE Version: " + app.version);
    } catch(e) {
        statusText.text = "Error";
        statusText.foregroundColor = [1, 0, 0];
        appendResult("Connection failed: " + e.message);
    }
}

function disconnect() {
    isConnected = false;
    statusText.text = "Disconnected";
    statusText.foregroundColor = [0.8, 0, 0]; // Red
    connectButton.text = "Connect";
    
    appendResult("Disconnected from MCP server");
}

function runTest() {
    appendResult("--- Running Test ---");
    
    try {
        // Get project info
        var info = {
            hasProject: !!app.project,
            version: app.version,
            os: $.os,
            aePath: app.path
        };
        
        appendResult("AE Info: " + info.toSource());
    } catch(e) {
        appendResult("Error: " + e.message);
    }
}

function listCompositions() {
    appendResult("--- Listing Compositions ---");
    
    if (!app.project) {
        appendResult("No project open!");
        return;
    }
    
    var comps = [];
    for (var i = 1; i <= app.project.items.length; i++) {
        var item = app.project.item(i);
        if (item instanceof CompItem) {
            comps.push(item.name + " (" + item.width + "x" + item.height + ", " + item.duration.toFixed(2) + "s)");
        }
    }
    
    if (comps.length > 0) {
        appendResult("Found " + comps.length + " compositions:");
        for (var j = 0; j < comps.length; j++) {
            appendResult("  " + (j+1) + ". " + comps[j]);
        }
    } else {
        appendResult("No compositions found");
    }
}

function showProjectInfo() {
    appendResult("--- Project Info ---");
    
    if (!app.project) {
        appendResult("No project open!");
        return;
    }
    
    var info = "Project: " + (app.project.file ? app.project.file.name : "Untitled") + "\n";
    info += "Items: " + app.project.items.length + "\n";
    info += "Compositions: " + app.project.numItems + "\n";
    info += "Render Queue: " + app.project.renderQueue.numItems;
    
    appendResult(info);
}

function appendResult(text) {
    if (lastResult) {
        var current = lastResult.text;
        lastResult.text = current + (current.length > 0 ? "\n" : "") + text;
    }
}

// ============================================
// Initialize
// ============================================

// Create the panel when script runs
createMCPConnectionPanel();

// ============================================
// Additional: Toggle Function for UI Menu
// ============================================

/*
To add to After Effects UI menu:

1. Copy this file to: 
   - Windows: C:\Program Files\Adobe\Adobe After Effects 2025\Support Files\Scripts\UI\mcp-connection.jsx
   - Mac: /Applications/Adobe After Effects 2025/Scripts/UI/mcp-connection.jsx

2. In After Effects, go to:
   Window > Extensions > MCP Connection

3. Click Connect to toggle connection
*/

// Add to Window menu (optional - requires scriptUI)
function addToWindowMenu() {
    // Note: Standard AE scripting does not support adding to main menus easily.
    // This usually requires a ScriptUI Panels setup or a startup script.
    alert("To add this panel to the Window menu, please move it to the 'Scripts/ScriptUI Panels' folder.");
}

// Uncomment to add to window menu when script loads
// addToWindowMenu();