/**
 * CC InDesign Bridge — UXP plugin main script
 *
 * Connects as a WebSocket CLIENT to the MCP server running on localhost:54321.
 * Receives commands (execute / snapshot), runs them via the InDesign UXP DOM,
 * and sends back results.
 *
 * Message protocol (JSON):
 *   Server → Plugin:  { id, type: "execute"|"snapshot", params: { ... } }
 *   Plugin → Server:  { id, success: true,  result: any }
 *                     { id, success: false, error: "message" }
 */

(function () {
  'use strict';

  // --------------------------------------------------------------------------
  // Config
  // --------------------------------------------------------------------------
  const WS_URL = 'ws://localhost:54322';
  const RECONNECT_BASE_MS  = 2_000;
  const RECONNECT_MAX_MS   = 30_000;
  // JPEG quality is set via JPEGOptionsQuality.HIGH enum in takeSnapshot

  // --------------------------------------------------------------------------
  // UI helpers
  // --------------------------------------------------------------------------
  const dot        = document.getElementById('dot');
  const statusText = document.getElementById('status-text');
  const lastCmd    = document.getElementById('last-cmd');
  const cmdCount   = document.getElementById('cmd-count');
  const reconnBtn  = document.getElementById('reconnect-btn');

  let handledCount = 0;

  function setStatus(state, text) {
    dot.className = state; // 'connected' | 'connecting' | 'disconnected'
    statusText.textContent = text;
  }

  function showLastCommand(description, type) {
    const label = description || type || '(no description)';
    lastCmd.textContent = label.length > 60 ? label.slice(0, 57) + '…' : label;
    handledCount += 1;
    cmdCount.textContent = String(handledCount);
  }

  // --------------------------------------------------------------------------
  // WebSocket management with auto-reconnect
  // --------------------------------------------------------------------------
  let ws = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_BASE_MS;
  let intentionallyClosed = false;

  function connect() {
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) {
      return; // already in flight
    }
    intentionallyClosed = false;
    setStatus('connecting', 'Connecting…');

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      reconnectDelay = RECONNECT_BASE_MS; // reset back-off
      setStatus('connected', 'Connected');
    };

    ws.onclose = (evt) => {
      ws = null;
      if (intentionallyClosed) return;
      const reason = evt.reason ? ` (${evt.reason})` : '';
      setStatus('disconnected', `Disconnected${reason} — retrying…`);
      scheduleReconnect();
    };

    ws.onerror = () => {
      // onerror is always followed by onclose, so we handle UI there
      setStatus('disconnected', 'Connection error');
    };

    ws.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch (_) { return; }
      if (!msg.id || !msg.type) return;

      showLastCommand(msg.params?.description, msg.type);

      let response;
      try {
        const result = await dispatch(msg.type, msg.params || {});
        response = { id: msg.id, success: true, result };
      } catch (err) {
        response = { id: msg.id, success: false, error: String(err?.message ?? err) };
      }

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(response));
      }
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connect();
      reconnectDelay = Math.min(reconnectDelay * 1.5, RECONNECT_MAX_MS);
    }, reconnectDelay);
  }

  reconnBtn.addEventListener('click', () => {
    clearTimeout(reconnectTimer);
    if (ws) { intentionallyClosed = true; ws.close(); ws = null; }
    reconnectDelay = RECONNECT_BASE_MS;
    connect();
  });

  // --------------------------------------------------------------------------
  // Command dispatcher
  // --------------------------------------------------------------------------
  async function dispatch(type, params) {
    if (type === 'execute') return executeCode(params);
    if (type === 'snapshot') return takeSnapshot(params);
    throw new Error(`Unknown command type: ${type}`);
  }

  // --------------------------------------------------------------------------
  // execute — run arbitrary JS in UXP context
  // --------------------------------------------------------------------------
  async function executeCode({ code }) {
    if (typeof code !== 'string' || !code.trim()) {
      throw new Error('code must be a non-empty string');
    }

    // Wrap the code in an async IIFE so top-level await and return work
    const wrapped = `(async function() { ${code} })()`;
    // eslint-disable-next-line no-new-func
    const fn = new Function('require', `return ${wrapped}`);

    // Provide the UXP require function so code can do require('indesign')
    const result = await fn(require);

    // Serialize safely — handle circular references and non-JSON types
    return safeSerialize(result);
  }

  /**
   * Serialize a value for JSON transport. Handles common InDesign DOM objects
   * by converting them to plain JS values.
   */
  function safeSerialize(value, depth = 0) {
    if (depth > 8) return '[max depth]';
    if (value === null || value === undefined) return value;
    const t = typeof value;
    if (t === 'boolean' || t === 'number' || t === 'string') return value;
    if (Array.isArray(value)) return value.map((v) => safeSerialize(v, depth + 1));
    if (t === 'object') {
      // Plain serializable object
      try {
        JSON.stringify(value); // test if it's already safe
        return value;
      } catch (_) {
        // Has circular refs or non-serializable props — shallow copy
        const out = {};
        for (const key of Object.keys(value)) {
          try { out[key] = safeSerialize(value[key], depth + 1); } catch (_) {}
        }
        return out;
      }
    }
    return String(value);
  }

  // --------------------------------------------------------------------------
  // snapshot — export a page or spread as base64 JPEG
  // --------------------------------------------------------------------------
  async function takeSnapshot({ target, index }) {
    const { app, ExportFormat, ExportRangeOrAllPages, JPEGOptionsQuality } = require('indesign');
    const doc = app.activeDocument;
    if (!doc) throw new Error('No active document open in InDesign');

    // Resolve the page/spread object
    let exportTarget;
    let pageString;
    if (target === 'spread') {
      exportTarget = doc.spreads.item(index);
      if (!exportTarget || !exportTarget.isValid) {
        throw new Error(`Spread at index ${index} does not exist`);
      }
      const spreadPages = exportTarget.pages.everyItem().getElements();
      pageString = spreadPages.map((p) => p.name).join(',');
    } else {
      exportTarget = doc.pages.item(index);
      if (!exportTarget || !exportTarget.isValid) {
        throw new Error(`Page at index ${index} does not exist`);
      }
      pageString = exportTarget.name;
    }

    // Export options — jpegExportPreferences lives on app in UXP (not doc)
    const jpegExportPrefs = app.jpegExportPreferences;
    jpegExportPrefs.jpegQuality    = JPEGOptionsQuality.HIGH;
    jpegExportPrefs.exportResolution = 96; // screen resolution
    jpegExportPrefs.antiAlias      = true;
    jpegExportPrefs.jpegExportRange = ExportRangeOrAllPages.EXPORT_RANGE;
    jpegExportPrefs.pageString     = pageString;

    // Create a UXP File object in the temp folder
    const { storage } = require('uxp');
    const tempFolder = await storage.localFileSystem.getTemporaryFolder();
    const fileName = `cc-bridge-snapshot-${Date.now()}.jpg`;
    const file = await tempFolder.createFile(fileName, { overwrite: true });

    // Export
    doc.exportFile(ExportFormat.JPG, file, false);

    // Read back and base64-encode
    const fileData = await file.read({ format: storage.formats.binary });
    const base64 = bufferToBase64(fileData);

    // Attempt cleanup (non-fatal if it fails)
    try { await file.delete(); } catch (_) {}

    return { imageData: base64 };
  }

  /**
   * Convert a binary ArrayBuffer / Uint8Array to a base64 string.
   * UXP does not have btoa for binary, so we do it manually.
   */
  function bufferToBase64(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const CHUNK = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  // --------------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------------
  connect();
})();
