#!/usr/bin/env node
/**
 * CC InDesign MCP Server
 *
 * Standalone MCP server that bridges Claude Code to Adobe InDesign via a UXP plugin.
 * The server starts a WebSocket server on localhost:54321 and waits for the
 * InDesign UXP plugin to connect. Claude Code talks to this server via stdio MCP.
 *
 * Architecture:
 *   Claude Code (stdio) <-> MCP Server <-> WebSocket <-> InDesign UXP Plugin
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import opentype from 'opentype.js';

// ---------------------------------------------------------------------------
// WebSocket Bridge — manages the single InDesign plugin connection
// ---------------------------------------------------------------------------

const WS_PORT = 54322;

class InDesignBridge {
  constructor() {
    this.pluginSocket = null;   // connected UXP plugin WebSocket
    this.pendingRequests = new Map(); // id -> { resolve, reject, timer }
    this.REQUEST_TIMEOUT_MS = 30_000;
    this._startServer();
  }

  _startServer(attempt = 1) {
    this.wss = new WebSocketServer({ port: WS_PORT, host: '127.0.0.1' });

    this.wss.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt <= 10) {
        // Port is busy (e.g. old Sidekick process still running). Retry after a delay.
        const delay = Math.min(attempt * 2000, 20000);
        process.stderr.write(`[MCP] Port ${WS_PORT} in use — retrying in ${delay / 1000}s (attempt ${attempt})\n`);
        setTimeout(() => this._startServer(attempt + 1), delay);
      } else {
        process.stderr.write(`[MCP] WebSocket server error: ${err.message}\n`);
      }
    });

    this.wss.on('connection', (ws) => {
      // Only one plugin connection at a time; drop the old one if present
      if (this.pluginSocket) {
        try { this.pluginSocket.close(); } catch (_) {}
      }
      this.pluginSocket = ws;

      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (_) { return; }
        const pending = this.pendingRequests.get(msg.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if (msg.success) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(msg.error || 'Unknown plugin error'));
        }
      });

      ws.on('close', () => {
        if (this.pluginSocket === ws) this.pluginSocket = null;
        // Reject any requests that were waiting on this connection
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timer);
          pending.reject(new Error('InDesign plugin disconnected'));
          this.pendingRequests.delete(id);
        }
      });

      ws.on('error', (err) => {
        // Errors are surfaced through pending request rejections above
        void err;
      });
    });

  }

  /**
   * Send a command to the plugin and wait for the response.
   * @param {string} type  - 'execute' | 'snapshot'
   * @param {object} params
   * @returns {Promise<any>}
   */
  sendToPlugin(type, params) {
    return new Promise((resolve, reject) => {
      if (!this.pluginSocket || this.pluginSocket.readyState !== 1 /* OPEN */) {
        return reject(new Error(
          'InDesign plugin is not connected. ' +
          'Open the "CC Bridge" panel in InDesign (Window > Extensions > CC Bridge).'
        ));
      }
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`InDesign plugin timed out after ${this.REQUEST_TIMEOUT_MS / 1000}s`));
      }, this.REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, { resolve, reject, timer });
      this.pluginSocket.send(JSON.stringify({ id, type, params }));
    });
  }

  get isConnected() {
    return this.pluginSocket !== null && this.pluginSocket.readyState === 1;
  }
}

const bridge = new InDesignBridge();

// ---------------------------------------------------------------------------
// Font Metrics helpers (runs locally — no InDesign needed)
// ---------------------------------------------------------------------------

function getFontDirectories() {
  const home = homedir();
  const os = platform();
  if (os === 'darwin') {
    return [
      '/Library/Fonts',
      '/System/Library/Fonts',
      '/System/Library/Fonts/Supplemental',
      join(home, 'Library/Fonts'),
      // Adobe Fonts (Creative Cloud synced)
      join(home, 'Library/Application Support/Adobe/CoreSync/plugins/livetype/.r'),
    ];
  }
  if (os === 'win32') {
    const winDir = process.env.WINDIR || 'C:\\Windows';
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    return [
      join(winDir, 'Fonts'),
      join(localAppData, 'Microsoft', 'Windows', 'Fonts'),
      join(appData, 'Adobe', 'CoreSync', 'plugins', 'livetype', '.r'),
    ];
  }
  return [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    join(home, '.fonts'),
    join(home, '.local/share/fonts'),
  ];
}

function isFontFile(filename) {
  const lower = filename.toLowerCase();
  if (['.otf', '.ttf', '.ttc', '.woff', '.woff2'].some((ext) => lower.endsWith(ext))) return true;
  // Adobe CoreSync fonts have no extension — just a hex-ish name
  if (!filename.includes('.') && /^[a-f0-9-]{8,}$/i.test(filename)) return true;
  return false;
}

async function scanDirectory(dirPath, maxDepth = 3) {
  const results = [];
  if (maxDepth <= 0) return results;
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        results.push(...await scanDirectory(fullPath, maxDepth - 1));
      } else if (entry.isFile() && isFontFile(entry.name)) {
        results.push(fullPath);
      }
    }
  } catch (_) {}
  return results;
}

async function extractFontInfo(filePath) {
  try {
    const font = await opentype.load(filePath);
    const familyName = font.names.fontFamily?.en || font.names.fontFamily?.['en-US'] || '';
    const subfamilyName = font.names.fontSubfamily?.en || font.names.fontSubfamily?.['en-US'] || 'Regular';
    const postScriptName = font.names.postScriptName?.en || font.names.postScriptName?.['en-US'] || '';
    const fullName = font.names.fullName?.en || font.names.fullName?.['en-US'] || '';
    if (!familyName && !postScriptName) return null;
    return { filePath, familyName, subfamilyName, postScriptName, fullName };
  } catch (_) {
    return null;
  }
}

async function buildFontIndex(fontDirs) {
  const entries = [];
  for (const dir of fontDirs) {
    const files = await scanDirectory(dir);
    for (const file of files) {
      const info = await extractFontInfo(file);
      if (info) entries.push(info);
    }
  }
  return entries;
}

// Simple disk cache — 24h TTL
const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CACHE_DIR = join(homedir(), '.cache', 'cc-indesign-mcp');
const CACHE_FILE = join(CACHE_DIR, 'font-index.json');

let _memCache = null;

function loadDiskCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
  } catch (_) { return null; }
}

function saveDiskCache(index) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(index));
  } catch (err) {
    process.stderr.write(`[MCP] Failed to save font cache: ${err.message}\n`);
  }
}

function invalidateFontCache() {
  _memCache = null;
  try { if (existsSync(CACHE_FILE)) unlinkSync(CACHE_FILE); } catch (_) {}
}

async function getFontIndex() {
  if (_memCache && _memCache.version === CACHE_VERSION &&
      Date.now() - _memCache.timestamp < CACHE_MAX_AGE_MS) {
    return _memCache;
  }
  const disk = loadDiskCache();
  if (disk && disk.version === CACHE_VERSION &&
      Date.now() - disk.timestamp < CACHE_MAX_AGE_MS) {
    _memCache = disk;
    return disk;
  }
  const entries = await buildFontIndex(getFontDirectories());
  const idx = { version: CACHE_VERSION, timestamp: Date.now(), entries };
  saveDiskCache(idx);
  _memCache = idx;
  return idx;
}

function findFont(index, identifier, style) {
  const id = identifier.toLowerCase();
  const sty = style?.toLowerCase();

  // 1. Exact PostScript name
  const ps = index.entries.find((e) => e.postScriptName.toLowerCase() === id);
  if (ps) return ps;

  // 2. Full name (when no style given)
  if (!sty) {
    const fn = index.entries.find((e) => e.fullName.toLowerCase() === id);
    if (fn) return fn;
  }

  // 3. Family name
  const family = index.entries.filter((e) => e.familyName.toLowerCase() === id);
  if (family.length === 0) {
    // 4. Partial match
    const partial = index.entries.filter(
      (e) => e.familyName.toLowerCase().includes(id) ||
              e.postScriptName.toLowerCase().includes(id) ||
              e.fullName.toLowerCase().includes(id)
    );
    if (partial.length === 1) return partial[0];
    if (partial.length > 1 && sty) {
      const exact = partial.find((e) => e.subfamilyName.toLowerCase() === sty);
      if (exact) return exact;
      const loose = partial.find((e) => e.subfamilyName.toLowerCase().includes(sty));
      if (loose) return loose;
    }
    return null;
  }
  if (family.length === 1) return family[0];
  if (sty) {
    const exact = family.find((e) => e.subfamilyName.toLowerCase() === sty);
    if (exact) return exact;
    const loose = family.find((e) => e.subfamilyName.toLowerCase().includes(sty));
    if (loose) return loose;
  }
  return family.find((e) => e.subfamilyName.toLowerCase() === 'regular') ?? family[0];
}

function measureGlyphHeight(font, char) {
  const glyph = font.charToGlyph(char);
  if (!glyph || glyph.index === 0) return null;
  return glyph.getBoundingBox().y2;
}

function detectMonospace(font) {
  const testChars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const widths = new Set();
  for (const char of testChars) {
    const g = font.charToGlyph(char);
    if (g && g.index !== 0 && g.advanceWidth !== undefined) widths.add(g.advanceWidth);
  }
  return widths.size === 1;
}

async function parseFontMetrics(filePath) {
  const buffer = await readFile(filePath);
  const font = opentype.parse(buffer.buffer);
  const os2 = font.tables.os2;
  const hhea = font.tables.hhea;
  const head = font.tables.head;
  const post = font.tables.post;

  let xHeight = null;
  let xHeightSource = 'os2';
  if (os2?.sxHeight && os2.sxHeight > 0) {
    xHeight = os2.sxHeight;
  } else {
    xHeight = measureGlyphHeight(font, 'x');
    xHeightSource = 'measured';
  }

  let capHeight = null;
  let capHeightSource = 'os2';
  if (os2?.sCapHeight && os2.sCapHeight > 0) {
    capHeight = os2.sCapHeight;
  } else {
    capHeight = measureGlyphHeight(font, 'H');
    capHeightSource = 'measured';
  }

  const lineGap = hhea?.lineGap ?? os2?.sTypoLineGap ?? 0;

  return {
    fontFamily: font.names.fontFamily?.en || font.names.fontFamily?.['en-US'] || '',
    fontSubfamily: font.names.fontSubfamily?.en || font.names.fontSubfamily?.['en-US'] || 'Regular',
    postScriptName: font.names.postScriptName?.en || font.names.postScriptName?.['en-US'] || '',
    fullName: font.names.fullName?.en || font.names.fullName?.['en-US'] || '',
    version: font.names.version?.en || font.names.version?.['en-US'] || '',
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    descender: font.descender,
    lineGap,
    xHeight,
    capHeight,
    xHeightSource,
    capHeightSource,
    bbox: { xMin: head.xMin, yMin: head.yMin, xMax: head.xMax, yMax: head.yMax },
    underlinePosition: post?.underlinePosition ?? 0,
    underlineThickness: post?.underlineThickness ?? 0,
    strikeoutPosition: os2?.yStrikeoutPosition ?? null,
    strikeoutSize: os2?.yStrikeoutSize ?? null,
    subscriptXSize: os2?.ySubscriptXSize ?? null,
    subscriptYSize: os2?.ySubscriptYSize ?? null,
    subscriptXOffset: os2?.ySubscriptXOffset ?? null,
    subscriptYOffset: os2?.ySubscriptYOffset ?? null,
    superscriptXSize: os2?.ySuperscriptXSize ?? null,
    superscriptYSize: os2?.ySuperscriptYSize ?? null,
    superscriptXOffset: os2?.ySuperscriptXOffset ?? null,
    superscriptYOffset: os2?.ySuperscriptYOffset ?? null,
    isMonospace: detectMonospace(font),
    filePath,
  };
}

// ---------------------------------------------------------------------------
// InDesign layout script (executed inside the UXP plugin context)
// ---------------------------------------------------------------------------

const LAYOUT_SCRIPT = `
  const { app, MeasurementUnits, PageSideOptions } = require("indesign");
  const doc = app.activeDocument;
  if (!doc) return { hasActiveDocument: false };

  function getUnitName(unit) { return String(unit); }
  function getPageSide(page) { return String(page.side); }

  const facingPages = doc.documentPreferences.facingPages;
  const hUnits = doc.viewPreferences.horizontalMeasurementUnits;
  const vUnits = doc.viewPreferences.verticalMeasurementUnits;
  const maxPages = Math.min(doc.pages.length, 20);
  const pages = [];

  for (let i = 0; i < maxPages; i++) {
    const page = doc.pages.item(i);
    const bounds = page.bounds; // [top, left, bottom, right]
    const mb = page.marginPreferences;
    const side = getPageSide(page);

    const pageWidth  = bounds[3] - bounds[1];
    const pageHeight = bounds[2] - bounds[0];
    const marginTop    = parseFloat(String(mb.top));
    const marginBottom = parseFloat(String(mb.bottom));
    const marginLeft   = parseFloat(String(mb.left));
    const marginRight  = parseFloat(String(mb.right));

    let contentLeft, contentRight;
    if (side === "LEFT_HAND") {
      contentLeft  = marginRight;
      contentRight = pageWidth - marginLeft;
    } else if (side === "RIGHT_HAND") {
      contentLeft  = marginLeft;
      contentRight = pageWidth - marginRight;
    } else {
      contentLeft  = marginLeft;
      contentRight = pageWidth - marginRight;
    }

    pages.push({
      index: i, side,
      bounds: { top: 0, left: 0, bottom: pageHeight, right: pageWidth },
      margins: { top: marginTop, bottom: marginBottom, inside: marginLeft, outside: marginRight },
      contentArea: { top: marginTop, left: contentLeft, bottom: pageHeight - marginBottom, right: contentRight }
    });
  }

  return {
    hasActiveDocument: true, facingPages,
    measurementUnits: { horizontal: getUnitName(hUnits), vertical: getUnitName(vUnits) },
    pageCount: doc.pages.length, pagesIncluded: maxPages,
    geometricBoundsFormat: "[top, left, bottom, right]",
    pages
  };
`;

// ---------------------------------------------------------------------------
// MCP Server setup
// ---------------------------------------------------------------------------

const server = new Server(
  { name: 'cc-indesign-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// --- Tool definitions -------------------------------------------------------

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'execute',
      description: `Execute JavaScript in the InDesign UXP context.
The code has access to \`require('indesign')\`, \`app\`, and all InDesign UXP DOM APIs.
Returns the JSON-serialized return value of the script.

Use \`const { app } = require('indesign');\` at the top of your code.`,
      inputSchema: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to execute in InDesign' },
          description: { type: 'string', description: 'Human-readable description of what this code does' },
        },
        required: ['code'],
      },
    },
    {
      name: 'snapshot',
      description: `Export a page or spread from the active InDesign document as a JPEG image.
Returns the image as a base64-encoded string.`,
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['page', 'spread'], description: "Export a single page or a full spread" },
          index: { type: 'number', description: 'Zero-based index of the page or spread to export' },
          description: { type: 'string', description: 'Human-readable description' },
        },
        required: ['target', 'index'],
      },
    },
    {
      name: 'get_layout',
      description: `Get page dimensions, margins, and content-area coordinates for every page in the active document.
Use this before placing text frames to get exact coordinates.
Returns measurement units, facingPages flag, and per-page bounds/margins/contentArea.`,
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_font_metrics',
      description: `Get comprehensive font metrics (unitsPerEm, ascender, descender, xHeight, capHeight, bbox, etc.) for a named font.
Searches system fonts and Adobe Fonts (Creative Cloud). Does NOT require InDesign to be open.

All metric values are in font units. Divide by unitsPerEm and multiply by point size to get actual measurements.
Example: 12pt font, unitsPerEm=1000, xHeight=500 → actual x-height = (500/1000)*12 = 6pt

Note: Some Adobe Fonts are only loaded on-demand and may not be in the local cache.
If a font is available in InDesign but not found here, open Adobe CC → Fonts, find the font, click Download, then retry with refresh=true.`,
      inputSchema: {
        type: 'object',
        properties: {
          fontIdentifier: {
            type: 'string',
            description: "Font family name (e.g. 'Helvetica'), PostScript name, or full name",
          },
          style: {
            type: 'string',
            description: "Optional style to disambiguate (e.g. 'Bold', 'Italic')",
          },
          refresh: {
            type: 'boolean',
            description: 'Force rebuild of the font index from disk',
          },
        },
        required: ['fontIdentifier'],
      },
    },
  ],
}));

// --- Tool handlers ----------------------------------------------------------

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── execute ──────────────────────────────────────────────────────────────
  if (name === 'execute') {
    const { code, description } = args;
    if (typeof code !== 'string' || !code.trim()) {
      return { content: [{ type: 'text', text: 'Error: code must be a non-empty string' }], isError: true };
    }
    try {
      const result = await bridge.sendToPlugin('execute', { code, description });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }

  // ── snapshot ─────────────────────────────────────────────────────────────
  if (name === 'snapshot') {
    const { target, index, description } = args;
    if (target !== 'page' && target !== 'spread') {
      return { content: [{ type: 'text', text: 'Error: target must be "page" or "spread"' }], isError: true };
    }
    const indexNum = typeof index === 'number' ? index : parseInt(index, 10);
    if (isNaN(indexNum)) {
      return { content: [{ type: 'text', text: 'Error: index must be a number' }], isError: true };
    }
    try {
      const result = await bridge.sendToPlugin('snapshot', { target, index: indexNum, description });
      const imageData = result?.imageData;
      if (!imageData) {
        return { content: [{ type: 'text', text: 'Error: plugin did not return imageData' }], isError: true };
      }
      return {
        content: [
          { type: 'image', data: imageData, mimeType: 'image/jpeg' },
        ],
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }

  // ── get_layout ────────────────────────────────────────────────────────────
  if (name === 'get_layout') {
    try {
      const result = await bridge.sendToPlugin('execute', { code: LAYOUT_SCRIPT, description: 'get_layout' });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }

  // ── get_font_metrics ──────────────────────────────────────────────────────
  if (name === 'get_font_metrics') {
    const { fontIdentifier, style, refresh } = args;
    if (typeof fontIdentifier !== 'string' || !fontIdentifier.trim()) {
      return { content: [{ type: 'text', text: 'Error: fontIdentifier must be a non-empty string' }], isError: true };
    }
    try {
      if (refresh) invalidateFontCache();
      const index = await getFontIndex();
      const entry = findFont(index, fontIdentifier, style);
      if (!entry) {
        const searchTerm = fontIdentifier.toLowerCase().slice(0, 4);
        const suggestions = index.entries
          .filter((e) => e.familyName.toLowerCase().includes(searchTerm) ||
                         e.postScriptName.toLowerCase().includes(searchTerm))
          .slice(0, 5)
          .map((e) => `${e.familyName} (${e.subfamilyName})`);
        let msg = `Font not found: "${fontIdentifier}"\n`;
        if (suggestions.length > 0) msg += `\nDid you mean one of these?\n${suggestions.map((s) => `  - ${s}`).join('\n')}`;
        msg += `\n\nTotal fonts indexed: ${index.entries.length}`;
        msg += '\n\nNote: Adobe Fonts loaded on-demand may not be in the local cache.';
        msg += '\nTo fix: open Adobe Creative Cloud → Fonts → find the font → click Download, then retry with refresh=true.';
        return { content: [{ type: 'text', text: msg }], isError: true };
      }
      const metrics = await parseFontMetrics(entry.filePath);
      return { content: [{ type: 'text', text: JSON.stringify(metrics, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[MCP] cc-indesign-mcp started. WebSocket bridge listening on ws://127.0.0.1:${WS_PORT}\n`);
