// Options / setup page. A teammate's setup link opens it as
//   chrome-extension://<id>/options.html#url=<server>&token=<token>
// The values ride in the hash so they never leave the browser; they only pre-fill
// the form — nothing is saved until the user clicks Connect.
import { DEFAULT_SERVER_URL, getServerConfig, saveServerConfig, normalizeServerUrl } from '../../lib/server-config.js';

const form = document.getElementById('form');
const urlInput = document.getElementById('url');
const tokenInput = document.getElementById('token');
const saveBtn = document.getElementById('save');
const statusEl = document.getElementById('status');

function showStatus(kind, text) {
  statusEl.className = `status show ${kind}`;
  statusEl.textContent = text;
}

// Also runs on hashchange: pasting a setup link into a tab that already shows
// this page only changes the hash, which doesn't reload it.
function applySetupLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has('url') && !params.has('token')) return;
  urlInput.value = params.get('url') || '';
  tokenInput.value = params.get('token') || '';
  // Drop the token from the address bar and history.
  history.replaceState(null, '', location.pathname);
  statusEl.className = 'status';
  document.getElementById('lead').textContent = 'Your setup link filled these in. Check the server URL, then click Connect.';
  saveBtn.focus();
}

async function init() {
  const current = await getServerConfig();
  urlInput.value = current.url === DEFAULT_SERVER_URL ? '' : current.url;
  tokenInput.value = current.token;
  applySetupLink();
  window.addEventListener('hashchange', applySetupLink);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (url && !normalizeServerUrl(url)) {
    showStatus('err', 'Enter a full URL, e.g. http://my-vps.tailnet.ts.net:3846');
    return;
  }
  saveBtn.disabled = true;
  showStatus('info', 'Connecting…');
  try {
    await saveServerConfig({ url, token: tokenInput.value });
    const r = await chrome.runtime.sendMessage({ action: 'checkMCPStatus' });
    const s = r?.status;
    if (s?.connected) {
      showStatus('ok', s.user
        ? `Connected as ${s.user.name}. Open your app and press the toolbar icon to start annotating.`
        : 'Connected. Open your app and press the toolbar icon to start annotating.');
    } else {
      showStatus('err', `Saved, but not connected: ${s?.problem || r?.error || 'unknown error'}`);
    }
  } catch (err) {
    showStatus('err', `Could not save: ${err.message}`);
  } finally {
    saveBtn.disabled = false;
  }
});

init();
