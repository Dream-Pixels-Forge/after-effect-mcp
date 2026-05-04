#!/usr/bin/env node
/*
MCP HTTP Bridge Server
Wraps MCP stdio commands in HTTP endpoints for After Effects ExtendScript

Usage:
  node mcp-http-bridge.js

Then in After Effects:
  - Run the UI script (MCPPanel.jsx)
  - Click Connect to test
*/

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MCP_PORT = process.env.MCP_PORT || 7687;
const MCP_SERVER = process.env.MCP_SERVER || "./build/index.js";

// Track running MCP process
let mcpProcess = null;
let mcpReady = false;

// Request registry for MCP communication
const pendingRequests = new Map();

// Start MCP server as child process
async function startMCPServer() {
  console.log("Starting MCP server...");
  
  mcpProcess = spawn("node", [MCP_SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd()
  });

  let buffer = "";
  mcpProcess.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const response = JSON.parse(line);
        
        // MCP server is ready when we see a JSON-RPC response
        if (!mcpReady && response.jsonrpc) {
          mcpReady = true;
          console.log("MCP server ready!");
        }

        if (response.id !== undefined && pendingRequests.has(response.id)) {
          const { resolve, timeout } = pendingRequests.get(response.id);
          clearTimeout(timeout);
          pendingRequests.delete(response.id);
          resolve(response);
        }
      } catch (err) {
        // Skip non-JSON or partial lines
      }
    }
  });

  mcpProcess.stderr.on("data", (data) => {
    console.error("MCP stderr:", data.toString());
  });

  mcpProcess.on("error", (err) => {
    console.error("MCP process error:", err);
    mcpReady = false;
  });

  // Wait for ready
  return new Promise((resolve) => {
    const checkReady = setInterval(() => {
      if (mcpReady) {
        clearInterval(checkReady);
        resolve();
      }
    }, 100);
    
    // Fallback timeout
    setTimeout(() => {
      clearInterval(checkReady);
      mcpReady = true; // Assume ready after 5s
      resolve();
    }, 5000);
  });
}

// Send request to MCP via stdin/stdout bridge
function sendMCPRequest(request) {
  return new Promise((resolve, reject) => {
    if (!mcpProcess || !mcpProcess.stdin) {
      reject(new Error("MCP server not ready"));
      return;
    }

    const requestId = request.id;

    // Timeout after 30 seconds
    const timeout = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error(`MCP request timeout (ID: ${requestId})`));
      }
    }, 30000);

    // Register pending request
    pendingRequests.set(requestId, { resolve, reject, timeout });

    // Send request via stdin
    const requestLine = JSON.stringify(request) + "\n";
    mcpProcess.stdin.write(requestLine);
  });
}

// Create HTTP server
const server = createServer(async (req, res) => {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: mcpReady ? "ready" : "starting" }));
    return;
  }

  // MCP RPC endpoint
  if (req.url === "/rpc" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      try {
        const request = JSON.parse(body);
        console.log("Received:", request.method);
        
        const response = await sendMCPRequest(request);
        
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(response));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { message: err.message }
        }));
      }
    });
    return;
  }

  // List available tools
  if (req.url === "/tools" && req.method === "GET") {
    try {
      const response = await sendMCPRequest({
        jsonrpc: "2.0",
        id: Math.floor(Math.random() * 1000000),
        method: "tools/list",
        params: {}
      });
      
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response.result || { tools: [] }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// Start server
async function main() {
  await startMCPServer();
  
  server.listen(MCP_PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║     After Effects MCP HTTP Bridge               ║
║                                               ║
║   Server running on: http://localhost:${MCP_PORT}    ║
║   MCP Status: ${mcpReady ? "Ready" : "Starting"}                         ║
║                                               ║
║   Endpoints:                                    ║
║   - GET  /health   - Health check               ║
║   - GET  /tools    - List available tools      ║
║   - POST /rpc      - Send MCP command          ║
║                                               ║
║   In After Effects:                             ║
║   1. Run MCPPanel.jsx from Scripts UI         ║
║   2. Click Connect                             ║
╚═══════════════════════════════════════════════════╝
`);
  });
}

main().catch(console.error);