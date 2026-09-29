// API sync — health checks, bidirectional merge, individual CRUD sync
import { isSupportedUrl } from './url-filter.js';
import { updateAllBadges } from './badge.js';
import { getServerConfig, getAuthState, authHeaders, describeConnectionProblem } from '../server-config.js';
import { ensureFreshToken, recoverFromAuthError } from './google-auth.js';

let connected = false;

// fetch() against the configured server, with the auth token attached when set.
export async function apiFetch(path, init = {}) {
  const { url, token } = await getServerConfig();
  return fetch(`${url}${path}`, { ...init, headers: { ...(init.headers || {}), ...authHeaders(token) } });
}

export function isConnected() { return connected; }

export async function checkConnection() {
  await ensureFreshToken().catch(() => {});
  let status = await checkOnce();
  if (status.auth_error && await recoverFromAuthError().catch(() => false)) status = await checkOnce();
  if (status.auth_error && (await getAuthState()).mode === 'google') {
    status.problem = "Signed out — open the extension's setup page and sign in with Google.";
  }
  return status;
}

async function checkOnce() {
  const { url: API_URL } = await getServerConfig();
  try {
    const response = await apiFetch('/health', { method: 'GET', signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = await response.json();
      connected = true;
      const extensionVersion = chrome.runtime.getManifest().version;
      let versionCompatible = true;
      let compatibilityMessage = null;
      if (data.minExtensionVersion) {
        const extensionParts = extensionVersion.split('.').map(Number);
        const minParts = data.minExtensionVersion.split('.').map(Number);
        for (let i = 0; i < 3; i++) {
          if ((extensionParts[i] || 0) < (minParts[i] || 0)) {
            versionCompatible = false;
            compatibilityMessage = `Extension update required. Minimum version: ${data.minExtensionVersion}`;
            break;
          }
          if ((extensionParts[i] || 0) > (minParts[i] || 0)) break;
        }
      }
      // /health is public; whoami proves the token works and names its owner.
      // Older servers have no whoami (404) — treat as connected, no identity.
      const who = await apiFetch('/api/whoami', { signal: AbortSignal.timeout(5000) });
      if (who.status === 401) {
        connected = false;
        return { connected: false, auth_error: true, server_url: API_URL, server_version: data.version, error: 'Invalid or missing token', problem: describeConnectionProblem('auth', API_URL), last_check: new Date().toISOString() };
      }
      const user = who.ok ? (await who.json()).user || null : null;
      return { connected: true, user, server_url: API_URL, server_version: data.version, server_status: data.status, version_compatible: versionCompatible, compatibility_message: compatibilityMessage, last_check: new Date().toISOString() };
    } else {
      connected = false;
      return { connected: false, server_url: API_URL, error: `Server returned ${response.status}`, problem: describeConnectionProblem('http', API_URL, response.status), last_check: new Date().toISOString() };
    }
  } catch (error) {
    connected = false;
    return { connected: false, server_url: API_URL, error: error.message, problem: describeConnectionProblem('network', API_URL, error), last_check: new Date().toISOString() };
  }
}

export async function syncAll(annotations) {
  try {
    const response = await apiFetch(`/api/annotations/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ annotations })
    });
    if (!response.ok) throw new Error(`API sync error: ${response.status}`);
    const result = await response.json();
    if (!result.success) throw new Error(result.error || 'Failed to sync annotations');
    await chrome.storage.local.set({ apiSyncPending: false, apiLastSync: Date.now(), apiSyncCount: annotations.length });
  } catch (error) {
    console.error('Error syncing annotations to API:', error);
    await chrome.storage.local.set({ apiSyncPending: true, apiSyncError: error.message, apiLastSync: Date.now() });
    throw error;
  }
}

export async function saveOne(annotation) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await apiFetch(`/api/annotations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(annotation), signal: controller.signal
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`API server error: ${response.status}`);
    const result = await response.json();
    if (!result.success) throw new Error(result.error || 'Failed to save annotation to API');
  } catch (error) {
    console.warn('Failed to save to API server, annotation saved locally:', error.message);
    throw error;
  }
}

// Upload an image attachment as a raw binary blob (no base64). kind is 'capture'
// (the auto element screenshot) or 'user' (paste/upload). The server writes it to
// ~/.vibe-annotations/attachments/ and records { id, kind, mime } on the annotation.
// Retries on 404: for a brand-new annotation the attachment can race ahead of the
// server-side create (saveOne is fire-and-forget), so the annotation may not exist
// for a moment. Backs off and retries rather than losing the image.
export async function uploadAttachment(id, blob, kind, mime) {
  const attempts = 5;
  for (let i = 0; i < attempts; i++) {
    const response = await apiFetch(`/api/annotations/${id}/attachments`, {
      method: 'POST',
      headers: { 'Content-Type': mime, 'X-Attachment-Kind': kind },
      body: blob,
    });
    if (response.ok) return await response.json();
    if (response.status === 404 && i < attempts - 1) {
      await new Promise(r => setTimeout(r, 300));
      continue;
    }
    throw new Error(`attachment upload error: ${response.status}`);
  }
}

// Remove a single attachment (unlinks the file server-side).
export async function deleteAttachment(id, attId) {
  const response = await apiFetch(`/api/annotations/${id}/attachments/${attId}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`attachment delete error: ${response.status}`);
  return await response.json();
}

export async function deleteOne(id) {
  try {
    const response = await apiFetch(`/api/annotations/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
    if (!response.ok) throw new Error(`API delete error: ${response.status}`);
    const result = await response.json();
    if (!result.success) throw new Error(result.error || 'Failed to delete annotation from API');
  } catch (error) {
    console.error('[Background] Error deleting annotation from API:', error);
    throw error;
  }
}

export async function smartSync(storageLockFn) {
  let serverAnnotations;
  try {
    const response = await apiFetch(`/api/annotations?limit=0`);
    if (!response.ok) return;
    const serverResult = await response.json();
    if (!Array.isArray(serverResult.annotations)) return;
    serverAnnotations = serverResult.annotations;
  } catch { return; }

  return storageLockFn(async () => {
    try {
      const localResult = await chrome.storage.local.get(['annotations', 'deletedAnnotationIds']);
      const localAnnotations = localResult.annotations || [];
      const deletedIds = new Set(localResult.deletedAnnotationIds || []);
      const localMap = new Map(localAnnotations.map(a => [a.id, a]));
      const serverMap = new Map(serverAnnotations.map(a => [a.id, a]));
      const allIds = new Set([...localMap.keys(), ...serverMap.keys()]);
      const merged = [];
      let changed = false, flagsChanged = false;

      for (const id of allIds) {
        if (deletedIds.has(id)) { if (serverMap.has(id)) changed = true; continue; }
        const local = localMap.get(id);
        const server = serverMap.get(id);
        if (local && server) {
          const lt = new Date(local.updated_at || local.created_at || 0).getTime();
          const st = new Date(server.updated_at || server.created_at || 0).getTime();
          if (st > lt) { server._synced = true; merged.push(server); changed = true; }
          else { if (!local._synced) flagsChanged = true; local._synced = true; merged.push(local); if (lt > st) changed = true; }
        } else if (local && !server) {
          if (local._synced) { changed = true; } else { merged.push(local); changed = true; }
        } else if (!local && server) { server._synced = true; merged.push(server); changed = true; }
      }

      if (!changed && !flagsChanged) return;
      await chrome.storage.local.set({ annotations: merged, lastServerSync: Date.now() });

      if (changed) {
        try {
          await apiFetch(`/api/annotations/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ annotations: merged }) });
          let needsUpdate = false;
          for (const a of merged) { if (!a._synced) { a._synced = true; needsUpdate = true; } }
          if (needsUpdate) await chrome.storage.local.set({ annotations: merged });
        } catch (e) { console.warn('Failed to push merged annotations to server:', e.message); }
      }

      for (const id of deletedIds) { if (serverMap.has(id)) deleteOne(id).catch(() => {}); }
      await chrome.storage.local.set({ deletedAnnotationIds: [...deletedIds].filter(id => serverMap.has(id)) });
      console.log(`[Vibe] Sync complete — merged: ${merged.length} annotations`);
      await updateAllBadges();

      try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (await isSupportedUrl(tab.url)) chrome.tabs.sendMessage(tab.id, { action: 'annotationsUpdated' }).catch(() => {});
        }
      } catch { /* ignore */ }
    } catch (error) { console.error('Error during smart sync:', error); }
  });
}

export async function fetchAnnotations(url) {
  try {
    let apiPath = '/api/annotations';
    if (url) apiPath += `?url=${encodeURIComponent(url)}`;
    const response = await apiFetch(apiPath);
    if (!response.ok) throw new Error(`API server error: ${response.status}`);
    const result = await response.json();
    return result.annotations || [];
  } catch (error) {
    console.error('[Background] Error getting annotations from API:', error);
    const result = await chrome.storage.local.get(['annotations']);
    const annotations = result.annotations || [];
    if (url) return annotations.filter(a => a.url === url);
    return annotations;
  }
}
