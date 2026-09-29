// Setup page: server URL, Google sign-in (or a manual token), and per-machine
// Claude Code tokens. A setup link pre-fills it: options.html#url=<server>[&token=<t>].
import { DEFAULT_SERVER_URL, getServerConfig, saveServerConfig, normalizeServerUrl } from '../../lib/server-config.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const el = {
  url: $('server-url'), state: $('server-state'), serverErr: $('server-err'), loading: $('loading'),
  signin: $('signin'), googleBtn: $('google-btn'), googleErr: $('google-err'),
  signedIn: $('signed-in'), who: $('who'), whoEmail: $('who-email'), avatar: $('avatar'), signout: $('signout'),
  advanced: $('advanced'), token: $('manual-token'), manualSave: $('manual-save'), manualErr: $('manual-err'),
  cc: $('cc'), ccNote: $('cc-token-note'), ccLabel: $('cc-label'), ccCreate: $('cc-create'), ccErr: $('cc-err'),
  ccResult: $('cc-result'), ccCommand: $('cc-command'), ccCopy: $('cc-copy'), ccList: $('cc-list'), status: $('status'),
};
let authMode = 'none';
let googleAvailable = false;
const BAD_URL = 'Enter a full URL, e.g. http://my-vps.tailnet.ts.net:3846';

function busy(btn, on, label) {
  btn.disabled = on;
  btn.setAttribute('aria-busy', String(on));
  if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = `<span class="spin" aria-hidden="true"></span><span>${label}</span>`; }
  else if (btn.dataset.label) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
}
const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function setServerState(kind, text) {
  el.state.innerHTML = `<span class="dot ${kind}"></span><span></span>`;
  el.state.lastChild.textContent = text;
}

function urlError(text) {
  el.serverErr.textContent = text;
  el.url.setAttribute('aria-invalid', String(!!text));
}

// Persist the URL field (keeping the current token) before any server call.
async function commitUrl() {
  const raw = el.url.value.trim();
  if (raw && !normalizeServerUrl(raw)) { urlError(BAD_URL); el.url.focus(); return false; }
  urlError('');
  const cur = await getServerConfig();
  const next = normalizeServerUrl(raw) || DEFAULT_SERVER_URL;
  if (next !== cur.url) await chrome.storage.local.set({ vibeServerUrl: next === DEFAULT_SERVER_URL ? '' : next });
  return true;
}

async function refreshStatus() {
  setServerState('', 'Checking…');
  const r = await send({ action: 'checkMCPStatus' });
  const s = r?.status;
  if (s?.connected) { setServerState('ok', 'Online'); urlError(''); }
  // Reachable, just not signed in yet — that's what the sign-in button is for.
  else if (s?.auth_error && authMode === 'none') { setServerState('ok', 'Online'); urlError(''); }
  else { setServerState('err', 'Offline'); el.serverErr.textContent = s?.problem || r?.error || ''; }
  // "You're connected with a token" only when that token actually works.
  el.ccNote.hidden = authMode !== 'token' || !googleAvailable || !s?.connected;
  return s;
}

async function render() {
  const auth = await send({ action: 'getAuthState' });
  authMode = auth.mode;
  googleAvailable = !!auth.googleAvailable;
  const google = auth.mode === 'google';
  el.loading.hidden = true;
  el.signin.hidden = google || !auth.googleAvailable;
  el.signedIn.hidden = !google;
  el.advanced.hidden = google;
  el.cc.hidden = !google;
  if (!auth.googleAvailable) el.advanced.open = true;
  if (google && auth.user) {
    el.who.textContent = auth.user.name;
    el.whoEmail.textContent = auth.user.id;
    el.avatar.textContent = initials(auth.user.name);
  }
  if (google) await renderTokens();
}

async function renderTokens() {
  const r = await send({ action: 'listMyTokens' });
  el.ccList.replaceChildren();
  if (!r.ok) { el.ccErr.textContent = r.error === 'server_unreachable' ? "Can't reach the server." : 'Could not load your tokens.'; return; }
  el.ccErr.textContent = '';
  const tokens = [...r.tokens].sort((a, b) => (b.current - a.current) || a.label.localeCompare(b.label));
  for (const t of tokens) {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.innerHTML = '<div class="title"></div><div class="meta"></div>';
    main.firstChild.textContent = t.kind === 'extension' ? 'Chrome extension' : t.label;
    main.firstChild.title = main.firstChild.textContent;
    main.lastChild.textContent = t.current ? 'Renews automatically while you use Chrome' : `created ${fmtDate(t.created_at)}`;
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (t.current) {
      const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'This browser';
      actions.append(tag);
    } else if (t.kind === 'mcp') {
      const revoke = document.createElement('button');
      revoke.className = 'link danger'; revoke.type = 'button'; revoke.textContent = 'Revoke';
      revoke.setAttribute('aria-label', `Revoke ${t.label}`);
      revoke.addEventListener('click', () => confirmRevoke(actions, t));
      actions.append(revoke);
    }
    li.append(main, actions);
    el.ccList.append(li);
  }
}

function confirmRevoke(actions, t) {
  actions.replaceChildren();
  const q = document.createElement('span'); q.className = 'meta'; q.textContent = `Revoke ${t.label}?`;
  const yes = document.createElement('button'); yes.className = 'link danger'; yes.type = 'button'; yes.textContent = 'Revoke';
  const no = document.createElement('button'); no.className = 'link'; no.type = 'button'; no.textContent = 'Cancel';
  no.addEventListener('click', renderTokens);
  yes.addEventListener('click', async () => {
    busy(yes, true, 'Revoking');
    no.disabled = true;
    const r = await send({ action: 'revokeMyToken', id: t.id });
    if (!r.ok) el.ccErr.textContent = 'Could not revoke — try again.';
    else el.status.textContent = `Revoked ${t.label}.`;
    await renderTokens();
  });
  actions.append(q, yes, no);
  yes.focus();
}

el.googleBtn.addEventListener('click', async () => {
  el.status.textContent = '';
  el.googleErr.textContent = '';
  if (!(await commitUrl())) return;
  busy(el.googleBtn, true, 'Signing in…');
  const r = await send({ action: 'googleSignIn', interactive: true });
  busy(el.googleBtn, false);
  if (!r.ok) {
    el.googleErr.textContent = r.message || r.error || '';
    el.status.textContent = '';
    await refreshStatus(); // the URL is saved now
    return;
  }
  el.status.textContent = `Signed in as ${r.user.name}.`;
  await render();
  await refreshStatus();
});

el.signout.addEventListener('click', async () => {
  busy(el.signout, true, 'Signing out');
  await send({ action: 'googleSignOut' });
  busy(el.signout, false);
  el.ccResult.hidden = true;
  el.ccCommand.textContent = '';
  el.status.textContent = 'Signed out.';
  await render();
  await refreshStatus();
  el.googleBtn.focus();
});

el.manualSave.addEventListener('click', async () => {
  el.status.textContent = '';
  el.manualErr.textContent = '';
  const raw = el.url.value.trim();
  if (raw && !normalizeServerUrl(raw)) { urlError(BAD_URL); el.url.focus(); return; }
  urlError('');
  busy(el.manualSave, true, 'Saving');
  await saveServerConfig({ url: raw, token: el.token.value });
  await render();
  const s = await refreshStatus();
  busy(el.manualSave, false);
  // Show the problem once, under the token field that caused it.
  if (!s?.connected) { el.manualErr.textContent = el.serverErr.textContent || 'Saved, but not connected.'; el.serverErr.textContent = ''; }
  else el.status.textContent = s.user ? `Connected as ${s.user.name}.` : 'Connected.';
});

el.ccCreate.addEventListener('click', async () => {
  el.ccErr.textContent = '';
  const label = el.ccLabel.value.trim();
  if (!label) { el.ccErr.textContent = 'Give this machine a name, e.g. "laptop".'; el.ccLabel.focus(); return; }
  busy(el.ccCreate, true, 'Creating');
  const r = await send({ action: 'createMyToken', label });
  busy(el.ccCreate, false);
  if (!r.ok) {
    el.ccErr.textContent = r.error === 'too_many_tokens' ? 'You have 20 tokens — revoke one first.'
      : r.error === 'server_unreachable' ? "Can't reach the server." : 'Could not create a token — try again.';
    return;
  }
  const { url } = await getServerConfig();
  el.ccCommand.textContent = `claude mcp add --scope user --transport http vibe-annotations ${url}/mcp --header "Authorization: Bearer ${r.token}"`;
  el.ccResult.hidden = false;
  el.ccCopy.textContent = 'Copy';
  el.ccCopy.focus();
  await renderTokens();
});

let copyTimer;
el.ccCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el.ccCommand.textContent);
    el.ccCopy.textContent = 'Copied';
  } catch {
    // Clipboard blocked: select the command so Ctrl/Cmd+C works.
    getSelection().selectAllChildren(el.ccCommand);
    el.ccCopy.textContent = 'Press Ctrl+C';
  }
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { el.ccCopy.textContent = 'Copy'; }, 1500);
});

// Enter submits the field's action.
const onEnter = (input, btn) => input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btn.disabled) { e.preventDefault(); btn.click(); } });
onEnter(el.ccLabel, el.ccCreate);
onEnter(el.token, el.manualSave);
el.url.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.url.blur(); });
el.url.addEventListener('change', async () => { if (await commitUrl()) await refreshStatus(); });

// Setup link: pre-fill only; nothing is saved until the user acts.
// Returns true when it filled in something.
function applySetupLink() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has('url') && !p.has('token')) return false;
  if (p.has('url')) el.url.value = p.get('url');
  if (p.get('token')) { el.token.value = p.get('token'); el.advanced.open = true; }
  history.replaceState(null, '', location.pathname);
  el.status.textContent = p.get('token') || !googleAvailable
    ? 'Your setup link filled in the server. Click Save to connect.'
    : 'Your setup link filled in the server. Sign in to connect.';
  setServerState('', 'Not saved');
  urlError('');
  return true;
}

async function init() {
  const cfg = await getServerConfig();
  el.url.value = cfg.url === DEFAULT_SERVER_URL ? '' : cfg.url;
  const auth = await send({ action: 'getAuthState' });
  googleAvailable = !!auth.googleAvailable;
  el.token.value = auth.mode === 'token' ? cfg.token : '';
  const prefilled = applySetupLink();
  window.addEventListener('hashchange', applySetupLink);
  await render();
  // A pre-filled URL isn't saved yet, so checking the old one would only mislead.
  const filled = normalizeServerUrl(el.url.value) || DEFAULT_SERVER_URL;
  if (!prefilled || filled === cfg.url) await refreshStatus();
}
init();
