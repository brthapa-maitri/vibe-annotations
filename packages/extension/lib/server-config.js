// Where the vibe-annotations-server lives. Defaults to the local server; users
// running their dev stack (and the server + agent) on a remote box — e.g. a VPS
// reachable over Tailscale — can point the extension at it from Settings.
// Shared by the background service worker and the content scripts.

export const DEFAULT_SERVER_URL = 'http://127.0.0.1:3846';
const KEYS = ['vibeServerUrl', 'vibeServerToken'];
const AUTH_KEYS = ['vibeAuthMode', 'vibeTokenExpiresAt', 'vibeUser'];

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
  const newToken = String(token || '').trim();
  const { vibeServerToken: stored } = await chrome.storage.local.get('vibeServerToken');
  const update = {
    vibeServerUrl: normalized && normalized !== DEFAULT_SERVER_URL ? normalized : '',
    vibeServerToken: newToken,
  };
  // A URL-only save keeps the token, so it must not demote a Google session.
  if (newToken !== String(stored || '').trim()) {
    Object.assign(update, { vibeAuthMode: '', vibeTokenExpiresAt: null, vibeUser: null });
  }
  await chrome.storage.local.set(update);
}

export function onServerConfigChanged(cb) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEYS.some(k => k in changes)) cb();
  });
}

// Human-readable reason a connection attempt failed, so "offline" tells the user
// what to fix. `kind`: 'network' (fetch threw), 'http' (non-2xx), 'auth' (401).
export function describeConnectionProblem(kind, url, detail) {
  let host = url;
  try { host = new URL(url).host; } catch { /* keep raw */ }
  const local = isLoopbackServer(url);
  if (kind === 'auth') return `${host} rejected the token — re-run your setup link or ask for a new token.`;
  if (kind === 'http') return `${host} answered HTTP ${detail} — the server may be misconfigured or restarting.`;
  const timedOut = detail && (detail.name === 'TimeoutError' || detail.name === 'AbortError');
  const what = timedOut ? `${host} timed out` : `Can't reach ${host}`;
  return local
    ? `${what} — is vibe-annotations-server running?`
    : `${what} — is Tailscale/VPN connected and the server up?`;
}

export function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// For URLs that can't carry headers (img src, window.open).
export function withTokenParam(url, token) {
  if (!token) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

export function googleSignInAvailable() {
  return !!chrome.runtime.getManifest().oauth2?.client_id;
}

export async function getAuthState() {
  const r = await chrome.storage.local.get([...KEYS, ...AUTH_KEYS]);
  const mode = r.vibeAuthMode === 'google' && r.vibeServerToken ? 'google' : (r.vibeServerToken ? 'token' : 'none');
  return { mode, user: mode === 'google' ? r.vibeUser || null : null, expiresAt: mode === 'google' ? r.vibeTokenExpiresAt || null : null };
}

export async function saveGoogleSession({ token, expiresAt, user }) {
  await chrome.storage.local.set({ vibeServerToken: token, vibeAuthMode: 'google', vibeTokenExpiresAt: expiresAt, vibeUser: user });
}

export async function clearGoogleSession() {
  await chrome.storage.local.set({ vibeServerToken: '', vibeAuthMode: '', vibeTokenExpiresAt: null, vibeUser: null });
}
