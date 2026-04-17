# CC InDesign Bridge — Standalone MCP System

A self-contained replacement for the Sidekick for InDesign MCP plugin.  
**No cloud dependency.** Claude Code talks to this MCP server locally; the MCP server bridges to InDesign via a local WebSocket.

```
Claude Code (stdio MCP) ↔ Node.js MCP Server ↔ WebSocket (localhost:54321) ↔ InDesign UXP Plugin
```

---

## Prerequisites

- Node.js 18 or later
- Adobe InDesign 2023 (v18.0) or later
- Adobe UXP Developer Tools (install from Adobe Creative Cloud)

---

## Part 1 — Install the MCP Server

```bash
cd /Users/tiffanyrussell/Desktop/ClaudeStuff/Sidekick/mcp-server
npm install
```

### Register with Claude Code

Add this block to your Claude Code MCP settings (usually `~/.claude/settings.json` → `mcpServers`):

```json
{
  "mcpServers": {
    "cc-indesign": {
      "command": "node",
      "args": ["/Users/tiffanyrussell/Desktop/ClaudeStuff/Sidekick/mcp-server/index.js"]
    }
  }
}
```

Then restart Claude Code. The MCP server will start automatically and listen on `ws://127.0.0.1:54321` for the InDesign plugin.

---

## Part 2 — Install the UXP Plugin in InDesign

1. Open **Adobe UXP Developer Tools** (from Creative Cloud).
2. Click **Add Plugin** → browse to:
   ```
   /Users/tiffanyrussell/Desktop/ClaudeStuff/Sidekick/indesign-plugin/
   ```
   Select the `manifest.json` file.
3. Click **Load** (or **Load and Watch** for live-reload during development).
4. In InDesign, open **Window → Extensions → CC Bridge**.
5. The panel will show a green dot and "Connected" when the MCP server is running.

> **Note:** The MCP server must already be running (i.e., Claude Code must have launched it) before the plugin shows "Connected". If you open InDesign first, the plugin will keep retrying with exponential back-off — it will connect automatically once the server starts.

---

## Available MCP Tools

| Tool | Description |
|---|---|
| `execute` | Run JavaScript in the InDesign UXP context |
| `snapshot` | Export a page or spread as a base64 JPEG |
| `get_layout` | Get page dimensions, margins, and content areas |
| `get_font_metrics` | Read font metrics from disk (no InDesign required) |

### `execute`

```json
{ "code": "const { app } = require('indesign'); return app.activeDocument.name;",
  "description": "Get document name" }
```

The code runs inside an async IIFE in the UXP context, so top-level `await` and `return` both work.

### `snapshot`

```json
{ "target": "page", "index": 3, "description": "Preview page 4" }
```

Returns `{ "imageData": "<base64 JPEG>" }`.

### `get_layout`

No parameters. Returns page bounds, margins, and pre-calculated `contentArea` for all pages (max 20).

### `get_font_metrics`

```json
{ "fontIdentifier": "Lato", "style": "Black", "refresh": false }
```

Searches system fonts and Adobe CC fonts. Use `refresh: true` after installing a new font.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel shows orange dot "Connecting…" | MCP server is not running — start Claude Code or run `node index.js` manually |
| `execute` returns "plugin is not connected" | Open the CC Bridge panel in InDesign; wait for the green dot |
| Snapshot fails with "No active document" | Open a document in InDesign first |
| Font not found by `get_font_metrics` | Font may be an on-demand Adobe Font. Open CC → Fonts → Download the font locally, then call with `refresh: true` |
| UXP plugin fails to load | Ensure you selected the folder (containing `manifest.json`), not a file |

---

## File Structure

```
Sidekick/
├── README.md
├── mcp-server/
│   ├── package.json        # Node.js dependencies
│   └── index.js            # MCP server + WebSocket bridge + font metrics
└── indesign-plugin/
    ├── manifest.json        # UXP plugin manifest
    ├── index.html           # Panel UI
    └── main.js              # WebSocket client + InDesign command handlers
```
