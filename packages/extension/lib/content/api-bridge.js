// Wraps all chrome.runtime.sendMessage and chrome.storage calls
// Single interface for data operations used by all modules

import { DEFAULT_SERVER_URL, getServerConfig, saveServerConfig, onServerConfigChanged, isLoopbackServer, authHeaders, withTokenParam } from '../server-config.js';

// Configured server (Settings → Server). Loaded async; the default covers the
// first few ms before storage answers.
let serverConfig = { url: DEFAULT_SERVER_URL, token: '' };
getServerConfig().then(c => { serverConfig = c; });
onServerConfigChanged(async () => { serverConfig = await getServerConfig(); clearStatusCache(); });

let statusCache = null;
let statusCacheTime = 0;
const CACHE_TTL = 2000;

// Oldest server this extension build fully supports (variants MCP contract,
// image attachments, and the .html export endpoint all landed by here). A
// connected-but-older server gets a "please update" nudge so new features don't
// fail silently.
const MIN_SERVER_VERSION = '0.5.0';

function isServerOutdated(version) {
  if (!version) return false; // unknown → don't nag
  const a = String(version).split('.').map(Number);
  const b = MIN_SERVER_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) < (b[i] || 0)) return true;
    if ((a[i] || 0) > (b[i] || 0)) return false;
  }
  return false;
}

  function isFileProtocol() {
    return window.location.protocol === 'file:';
  }

  function isLocalOrigin() {
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0'
      || h.endsWith('.local') || h.endsWith('.test') || h.endsWith('.localhost');
  }

  // Can this page fetch the server itself? Only a local page talking to a local
  // server — anything else (non-local page: CORS / mixed content; remote server)
  // goes through the background, which the server always accepts.
  function canReachServerDirectly() {
    return !isFileProtocol() && isLocalOrigin() && isLoopbackServer(serverConfig.url);
  }

  function serverFetch(path, init = {}) {
    return fetch(`${serverConfig.url}${path}`, {
      ...init, headers: { ...(init.headers || {}), ...authHeaders(serverConfig.token) },
    });
  }

  // Relay through the background (see serverRequest there).
  async function serverFetchViaBg(path, { method = 'GET', as = 'json' } = {}) {
    const r = await chrome.runtime.sendMessage({ action: 'serverRequest', path, method, as });
    if (!r || !r.success) throw new Error(r?.error || 'server request failed');
    return r;
  }

  function getServerSettings() {
    return { ...serverConfig, defaultUrl: DEFAULT_SERVER_URL };
  }

  async function saveServerSettings(settings) {
    await saveServerConfig(settings);
    serverConfig = await getServerConfig();
    clearStatusCache();
  }

  // --- Server status ---

  async function checkServerStatus() {
    const now = Date.now();
    if (statusCache && (now - statusCacheTime) < CACHE_TTL) return statusCache;

    let status;

    if (!canReachServerDirectly()) {
      status = await _checkViaBg();
    } else {
      try {
        const res = await serverFetch('/health', {
          method: 'GET',
          signal: AbortSignal.timeout(2000),
          mode: 'cors',
          credentials: 'omit'
        });
        let version = null;
        if (res.ok) { try { version = (await res.json())?.version || null; } catch { /* older server / bad body */ } }
        status = { connected: res.ok, version };
      } catch {
        status = await _checkViaBg();
      }
    }

    status.outdated = !!(status.connected && isServerOutdated(status.version));
    statusCache = status;
    statusCacheTime = now;
    return status;
  }

  async function _checkViaBg() {
    try {
      const r = await chrome.runtime.sendMessage({ action: 'checkMCPStatus' });
      const s = r && r.success && r.status;
      return { connected: !!(s && s.connected), version: s ? s.server_version : null };
    } catch {
      return { connected: false, version: null };
    }
  }

  function clearStatusCache() {
    statusCache = null;
    statusCacheTime = 0;
  }

  // --- Annotations CRUD ---

  async function loadAnnotations() {
    try {
      const result = await chrome.storage.local.get(['annotations']);
      const all = result.annotations || [];
      return all.filter(a => a.url === window.location.href);
    } catch {
      return [];
    }
  }

  async function loadProjectAnnotations() {
    try {
      const result = await chrome.storage.local.get(['annotations']);
      const all = result.annotations || [];
      const origin = window.location.origin;
      return all.filter(a => {
        try { return new URL(a.url).origin === origin; } catch { return false; }
      });
    } catch {
      return [];
    }
  }

  async function saveAnnotation(annotation) {
    const r = await chrome.runtime.sendMessage({ action: 'saveAnnotation', annotation });
    if (!r || !r.success) throw new Error(r?.error || 'save failed');
    return true;
  }

  async function updateAnnotation(id, updates) {
    const r = await chrome.runtime.sendMessage({ action: 'updateAnnotation', id, updates });
    if (!r || !r.success) throw new Error(r?.error || 'update failed');
    return true;
  }

  // Push local changes to the server now (updates only touch chrome.storage; the
  // periodic sync would otherwise lag). Used e.g. after choosing a variant so the
  // agent can finalize immediately.
  async function forceSync() {
    try { await chrome.runtime.sendMessage({ action: 'forceMCPSync' }); } catch { /* ignore */ }
  }

  async function deleteAnnotation(id) {
    const r = await chrome.runtime.sendMessage({ action: 'deleteAnnotation', id });
    if (!r || !r.success) throw new Error(r?.error || 'delete failed');
    return true;
  }

  async function deleteAnnotationsByUrl() {
    const r = await chrome.runtime.sendMessage({ action: 'deleteAnnotationsByUrl', url: window.location.href });
    if (!r || !r.success) throw new Error(r?.error || 'bulk delete failed');
    return r.count || 0;
  }

  // Ask the background to capture+crop+store a real screenshot for this annotation.
  // `crop` is a device-pixel rect { sx, sy, sw, sh } within the visible viewport.
  async function captureScreenshot(id, crop) {
    const r = await chrome.runtime.sendMessage({ action: 'captureAnnotationScreenshot', id, crop });
    if (!r || !r.success) throw new Error(r?.error || 'screenshot capture failed');
    return r;
  }

  // --- Image attachments ---

  // Server URL that serves an attachment's bytes (img src on localhost, open-in-tab anywhere).
  function attachmentUrl(annotationId, attId) {
    return withTokenParam(`${serverConfig.url}/api/annotations/${annotationId}/attachments/${attId}`, serverConfig.token);
  }

  // Attachment bytes as a data URL, fetched by the background — for thumbnails
  // on pages that can't load the server URL directly.
  async function attachmentDataUrl(annotationId, attId) {
    const r = await serverFetchViaBg(`/api/annotations/${annotationId}/attachments/${attId}`, { as: 'dataUrl' });
    return r.ok ? r.body : null;
  }

  // Upload a user image (paste/drop/file-picker). On local origins we POST the
  // blob straight to the server (no base64); on other origins we can't reach
  // localhost directly (mixed content), so we hand the bytes to the background as
  // a transient data URL and it uploads. Either way the background mirrors the new
  // attachment into chrome.storage so the UI can render it immediately.
  async function uploadUserImage(annotationId, blob, mime, kind = 'user') {
    if (canReachServerDirectly()) {
      // Retry on 404: a brand-new annotation's server-side create can lag behind
      // this upload, so the annotation may not exist for a moment.
      let res;
      for (let i = 0; i < 5; i++) {
        res = await serverFetch(`/api/annotations/${annotationId}/attachments`, {
          method: 'POST',
          headers: { 'Content-Type': mime, 'X-Attachment-Kind': kind },
          body: blob,
        });
        if (res.ok) break;
        if (res.status === 404 && i < 4) { await new Promise(r => setTimeout(r, 300)); continue; }
        throw new Error(`attachment upload failed: ${res.status}`);
      }
      const { attachment } = await res.json();
      chrome.runtime.sendMessage({ action: 'recordAttachment', id: annotationId, att: attachment }).catch(() => {});
      return attachment;
    }
    const dataUrl = await blobToDataUrl(blob);
    const r = await chrome.runtime.sendMessage({ action: 'uploadUserImage', id: annotationId, mime, dataUrl, kind });
    if (!r || !r.success) throw new Error(r?.error || 'attachment upload failed');
    return r.attachment;
  }

  // Grab the full visible tab as a PNG data URL (the caller crops it). Needs the
  // screenshot host permission — request it first via requestScreenshotPermission.
  async function captureVisibleTab() {
    const r = await chrome.runtime.sendMessage({ action: 'captureVisibleTab' });
    if (!r || !r.success) throw new Error(r?.error || 'capture failed');
    return r.dataUrl;
  }

  async function removeAttachment(annotationId, attId) {
    const r = await chrome.runtime.sendMessage({ action: 'removeAttachment', id: annotationId, attId });
    if (!r || !r.success) throw new Error(r?.error || 'attachment remove failed');
    return true;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // --- Storage listeners ---

  function onAnnotationsChanged(cb) {
    chrome.storage.onChanged.addListener((changes, ns) => {
      if (ns === 'local' && changes.annotations) {
        cb(changes.annotations.newValue || []);
      }
    });
  }

  // --- Settings ---

  let _screenshotEnabledCache = false; // default OFF (needs all-sites permission for captureVisibleTab)

  async function getScreenshotEnabled() {
    try {
      const r = await chrome.storage.local.get(['screenshotEnabled']);
      _screenshotEnabledCache = r.screenshotEnabled !== undefined ? r.screenshotEnabled : false;
      return _screenshotEnabledCache;
    } catch {
      return false;
    }
  }

  // Screenshots require chrome.tabs.captureVisibleTab, which needs the broad
  // host permission (activeTab is gesture-scoped + revoked on navigation, and the
  // localhost host permission doesn't satisfy it). Request it when the user turns
  // screenshots on. Returns true if granted (or already held).
  async function requestScreenshotPermission() {
    const r = await chrome.runtime.sendMessage({ action: 'requestScreenshotPermission' });
    return !!(r && r.success && r.granted);
  }

  function isScreenshotEnabled() {
    return _screenshotEnabledCache;
  }

  async function saveScreenshotEnabled(enabled) {
    _screenshotEnabledCache = enabled;
    try {
      await chrome.storage.local.set({ screenshotEnabled: enabled });
    } catch { /* ignore */ }
  }

  async function getToolbarPosition() {
    try {
      const r = await chrome.storage.local.get(['vibeToolbarPos']);
      return r.vibeToolbarPos || null;
    } catch {
      return null;
    }
  }

  async function saveToolbarPosition(pos) {
    try {
      await chrome.storage.local.set({ vibeToolbarPos: pos });
    } catch { /* ignore */ }
  }

  async function getToolbarCollapsed() {
    try {
      const r = await chrome.storage.local.get(['vibeToolbarCollapsed']);
      return !!r.vibeToolbarCollapsed;
    } catch {
      return false;
    }
  }

  async function saveToolbarCollapsed(collapsed) {
    try {
      await chrome.storage.local.set({ vibeToolbarCollapsed: collapsed });
    } catch { /* ignore */ }
  }

  async function getClearOnCopy() {
    try {
      const r = await chrome.storage.local.get(['vibeClearOnCopy']);
      return !!r.vibeClearOnCopy;
    } catch {
      return false;
    }
  }

  async function saveClearOnCopy(enabled) {
    try {
      await chrome.storage.local.set({ vibeClearOnCopy: enabled });
    } catch { /* ignore */ }
  }

  async function getBadgeColor() {
    try {
      const r = await chrome.storage.local.get(['vibeBadgeColor']);
      return r.vibeBadgeColor || '#D03D68';
    } catch {
      return '#D03D68';
    }
  }

  async function saveBadgeColor(color) {
    try {
      await chrome.storage.local.set({ vibeBadgeColor: color });
    } catch { /* ignore */ }
  }

  async function getOverlayHidden() {
    try {
      const r = await chrome.storage.local.get(['vibeOverlayHidden']);
      return !!r.vibeOverlayHidden;
    } catch {
      return false;
    }
  }

  async function saveOverlayHidden(hidden) {
    try {
      await chrome.storage.local.set({ vibeOverlayHidden: !!hidden });
    } catch { /* ignore */ }
  }

  async function getSkipDeleteConfirm() {
    try {
      const r = await chrome.storage.local.get(['vibeSkipDeleteConfirm']);
      return !!r.vibeSkipDeleteConfirm;
    } catch {
      return false;
    }
  }

  async function saveSkipDeleteConfirm(skip) {
    try {
      await chrome.storage.local.set({ vibeSkipDeleteConfirm: skip });
    } catch { /* ignore */ }
  }

  async function getCustomShortcut() {
    try {
      const r = await chrome.storage.local.get(['vibeCustomShortcut']);
      return r.vibeCustomShortcut || null;
    } catch {
      return null;
    }
  }

  async function saveCustomShortcut(shortcut) {
    try {
      await chrome.storage.local.set({ vibeCustomShortcut: shortcut });
    } catch { /* ignore */ }
  }

  // Fetch a shareable export (markdown or self-contained HTML) from the server.
  async function getShareExport(urlPattern, format) {
    const path = `/api/export?url=${encodeURIComponent(urlPattern)}&format=${encodeURIComponent(format)}`;
    if (!canReachServerDirectly()) {
      const r = await serverFetchViaBg(path, { as: 'text' });
      if (!r.ok) throw new Error(`export failed: ${r.status}`);
      return { content: r.body, mime: r.mime };
    }
    const res = await serverFetch(path, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`export failed: ${res.status}`);
    return { content: await res.text(), mime: res.headers.get('Content-Type') || 'text/plain' };
  }

  async function stopWatchers() {
    try {
      if (!canReachServerDirectly()) { await serverFetchViaBg('/api/watchers/stop', { method: 'POST' }); return; }
      await serverFetch('/api/watchers/stop', { method: 'POST', signal: AbortSignal.timeout(2000) });
    } catch { /* ignore */ }
  }

  async function getWatchers() {
    try {
      if (!canReachServerDirectly()) {
        const r = await serverFetchViaBg('/api/watchers');
        return r.ok ? r.body : { watchers: [], watching: false };
      }
      const res = await serverFetch('/api/watchers', {
        signal: AbortSignal.timeout(2000),
      });
      if (!res.ok) return { watchers: [], watching: false };
      return await res.json();
    } catch {
      return { watchers: [], watching: false };
    }
  }

const VibeAPI = {
  checkServerStatus,
  clearStatusCache,
  isFileProtocol,
  isLocalOrigin,
  canReachServerDirectly,
  getServerSettings,
  saveServerSettings,
  loadAnnotations,
  loadProjectAnnotations,
  saveAnnotation,
  updateAnnotation,
  forceSync,
  deleteAnnotation,
  deleteAnnotationsByUrl,
  captureScreenshot,
  captureVisibleTab,
  attachmentUrl,
  attachmentDataUrl,
  uploadUserImage,
  removeAttachment,
  onAnnotationsChanged,
  getScreenshotEnabled,
  isScreenshotEnabled,
  saveScreenshotEnabled,
  requestScreenshotPermission,
  getToolbarPosition,
  saveToolbarPosition,
  getToolbarCollapsed,
  saveToolbarCollapsed,
  getClearOnCopy,
  saveClearOnCopy,
  getBadgeColor,
  saveBadgeColor,
  getOverlayHidden,
  saveOverlayHidden,
  getSkipDeleteConfirm,
  saveSkipDeleteConfirm,
  getCustomShortcut,
  saveCustomShortcut,
  getWatchers,
  stopWatchers,
  getShareExport,
};
export default VibeAPI;
