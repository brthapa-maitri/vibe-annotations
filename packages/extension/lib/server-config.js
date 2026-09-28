// Where the vibe-annotations-server lives. Defaults to the local server; users
// running their dev stack (and the server + agent) on a remote box — e.g. a VPS
// reachable over Tailscale — can point the extension at it from Settings.
// Shared by the background service worker and the content scripts.

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:3846';
const KEYS = ['vibeServerUrl', 'vibeServerToken'];

// Trim, drop trailing slashes, require http(s). Returns '' for invalid input.
export function normalizeServerUrl(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.origin + u.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}

export function isLoopbackServer(url) {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '0.0.0.0' || h === '[::1]';
  } catch {
    return false;
  }
}

export async function getServerConfig() {
  try {
    const r = await chrome.storage.local.get(KEYS);
    return {
      url: normalizeServerUrl(r.vibeServerUrl) || DEFAULT_SERVER_URL,
      token: String(r.vibeServerToken || '').trim(),
    };
  } catch {
    return { url: DEFAULT_SERVER_URL, token: '' };
  }
}

export async function saveServerConfig({ url, token }) {
  const normalized = normalizeServerUrl(url);
  await chrome.storage.local.set({
    vibeServerUrl: normalized && normalized !== DEFAULT_SERVER_URL ? normalized : '',
    vibeServerToken: String(token || '').trim(),
  });
}

export function onServerConfigChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEYS.some(k => k in changes)) cb();
  });
}

export function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// For URLs that can't carry headers (img src, window.open).
export function withTokenParam(url, token) {
  if (!token) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}
