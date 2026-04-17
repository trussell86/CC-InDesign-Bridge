# CC InDesign Bridge — Install Guide

Lets Claude Code drive Adobe InDesign. Two pieces work together:

1. **UXP plugin** — loads inside InDesign, exposes a panel, listens on a local WebSocket
2. **MCP server** — Claude Code talks to this; it forwards commands to the plugin

---

## Requirements

- macOS or Windows
- Adobe InDesign 18.0 or newer
- Node.js 18+ (`node --version` to check; install from https://nodejs.org if missing)
- Claude Code CLI
- Adobe UXP Developer Tool (free, from Creative Cloud desktop app → Marketplace → search "UXP Developer Tool")

---

## Step 1 — Install the MCP server

Unzip `cc-indesign-mcp-server-1.0.0.zip` somewhere permanent, e.g. `~/tools/cc-indesign-mcp/`.

```bash
cd ~/tools/cc-indesign-mcp/mcp-server
npm install
```

Register it with Claude Code. Edit `~/.claude/mcp.json` (create if missing):

```json
{
  "mcpServers": {
    "cc-indesign": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/mcp-server/index.js"]
    }
  }
}
```

Replace the path with the actual location. Restart Claude Code.

---

## Step 2 — Install the InDesign plugin

Two options:

### Option A — UXP Developer Tool (recommended for shared development)

1. Open **UXP Developer Tool**
2. Click **Add Plugin…** → select the `manifest.json` inside the unzipped plugin folder
   (or unzip `CC-InDesign-Bridge-1.0.0.ccx` first — it's a plain zip)
3. Make sure InDesign is running
4. In UXP Developer Tool, click **Load** next to the plugin row
5. In InDesign: **Window → Plug-ins → CC Bridge** to show the panel

### Option B — Double-click the .ccx

1. Double-click `CC-InDesign-Bridge-1.0.0.ccx`
2. Creative Cloud desktop will install it
3. Restart InDesign; show the panel via **Window → Plug-ins → CC Bridge**

*(Option A is easier when iterating on the plugin; Option B is cleaner for non-dev coworkers.)*

---

## Step 3 — Connect

1. Launch InDesign, open any document
2. Open the **CC Bridge** panel (Window → Plug-ins → CC Bridge)
3. The panel should show **Connected** once the MCP server is running
   (the MCP server starts automatically the first time Claude Code uses a cc-indesign tool)
4. In Claude Code, try: *"Take a snapshot of page 1 of the active InDesign document."*

---

## Troubleshooting

**Panel says "Disconnected"**
The MCP server isn't running yet. Ask Claude Code to do anything InDesign-related — that spawns the server and the panel will reconnect within a second or two.

**"Port 54321 in use"**
Another instance is already running. `lsof -i :54321` then kill the stale node process.

**Plugin won't load in UXP Developer Tool**
Make sure InDesign is running *before* you click Load. Toggle off/on if needed.

**Commands run but nothing happens in InDesign**
Confirm the CC Bridge panel is actually visible (not just loaded). The plugin only listens while the panel is open.

---

## Files in this bundle

| File | What it is |
|---|---|
| `CC-InDesign-Bridge-1.0.0.ccx` | The UXP plugin (zip w/ manifest.json, index.html, main.js) |
| `cc-indesign-mcp-server-1.0.0.zip` | Node MCP server source (run `npm install` after unzipping) |
| `INSTALL.md` | This file |

---

## Sharing with coworkers

Zip the whole `dist/` folder and send it. Everything they need to install is in here.
