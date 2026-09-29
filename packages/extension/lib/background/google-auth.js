// Google sign-in for the background worker. Google is only used to obtain a
// server token (POST /api/auth/google); everything else uses that token.
import { getServerConfig, getAuthState, saveGoogleSession, clearGoogleSession, authHeaders } from '../server-config.js';

export const SIGN_IN_MESSAGES = {
  wrong_domain: 'Sign in with your @maitriservices.com account.',
  wrong_domain_chrome_profile: 'Sign in with your @maitriservices.com account.'
    + ' Chrome is signed in with another account — add your work account to Chrome, or use the Advanced token option.',
  unverified_email: "Google sign-in isn't set up correctly for this server — tell the admin.",
  wrong_client: "Google sign-in isn't set up correctly for this server — tell the admin.",
  invalid_token: "Google sign-in isn't set up correctly for this server — tell the admin.",
  google_unreachable: "Couldn't reach Google — try again.",
  google_sign_in_disabled: "This server doesn't have Google sign-in enabled — use a token (Advanced).",
  rate_limited: 'Too many attempts — wait a minute and try again.',
  server_unreachable: "Can't reach the server — is Tailscale/VPN connected?",
  unavailable: 'Google sign-in is not available in this build.',
  cancelled: '',
};

const WEB_CLIENT_ID = import.meta.env.WXT_GOOGLE_WEB_CLIENT_ID || '';
let webToken = null; // { token, expiresAt } for the pop-up flow
// Last token Chrome's getAuthToken handed us, so sign-out / account switching can
// evict it from Chrome's cache (module state: lost if the worker restarts, which
// only means Chrome keeps a cached token for the same profile account).
let lastChromeToken = null;

async function tokenViaChrome(interactive) {
  const r = await chrome.identity.getAuthToken({ interactive });
  const token = typeof r === 'string' ? r : r?.token;
  lastChromeToken = token || null;
  return token;
}

async function tokenViaWebFlow(interactive) {
  if (webToken && webToken.expiresAt > Date.now() + 60_000) return webToken.token;
  if (!WEB_CLIENT_ID) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: WEB_CLIENT_ID, response_type: 'token', redirect_uri: chrome.identity.getRedirectURL(),
    scope: 'openid email profile', prompt: interactive ? 'select_account' : 'none',
  });
  const redirect = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive });
  const params = new URLSearchParams(new URL(redirect).hash.slice(1));
  const token = params.get('access_token');
  if (!token) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
  webToken = { token, expiresAt: Date.now() + Number(params.get('expires_in') || 3600) * 1000 };
  return token;
}

export async function getGoogleAccessToken({ interactive }) {
  if (!chrome.identity) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
  try {
    // getAuthToken exists only in Google Chrome; other Chromium browsers throw.
    return await tokenViaChrome(interactive);
  } catch (err) {
    if (/not supported|getAuthToken/i.test(String(err?.message))) return tokenViaWebFlow(interactive);
    throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
  }
}

async function dropCachedGoogleToken(token) {
  webToken = null;
  if (token && token === lastChromeToken) lastChromeToken = null;
  if (!token) return;
  try { await chrome.identity.removeCachedAuthToken({ token }); } catch { /* web flow / unsupported */ }
}

async function exchange(accessToken) {
  const { url } = await getServerConfig();
  let res;
  try {
    res = await fetch(`${url}/api/auth/google`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken }), signal: AbortSignal.timeout(10000),
    });
  } catch {
    return { ok: false, error: 'server_unreachable' };
  }
  const body = await res.json().catch(() => ({}));
  if (res.ok) return { ok: true, ...body };
  return { ok: false, error: body.error || 'server_unreachable' };
}

export async function signInWithGoogle({ interactive }) {
  const fail = (error) => ({ ok: false, error, message: SIGN_IN_MESSAGES[error] ?? SIGN_IN_MESSAGES.invalid_token });
  let access;
  try { access = await getGoogleAccessToken({ interactive }); } catch (e) { return fail(e.code || 'cancelled'); }
  let r = await exchange(access);
  if (!r.ok && r.error === 'invalid_token') {
    // Chrome may hand back a revoked cached token — drop it and retry once.
    await dropCachedGoogleToken(access);
    try { access = await getGoogleAccessToken({ interactive }); } catch (e) { return fail(e.code || 'cancelled'); }
    r = await exchange(access);
  }
  if (!r.ok && r.error === 'wrong_domain' && access === lastChromeToken) {
    // Chrome's token belongs to the browser profile's account, which isn't the work
    // account. Forget it, and let the user pick another account in the pop-up flow.
    await dropCachedGoogleToken(access);
    if (!interactive || !WEB_CLIENT_ID) return { ok: false, error: 'wrong_domain', message: SIGN_IN_MESSAGES.wrong_domain_chrome_profile };
    try { access = await tokenViaWebFlow(true); } catch (e) { return fail(e.code || 'cancelled'); }
    r = await exchange(access);
  }
  if (!r.ok) return fail(r.error);
  await saveGoogleSession({ token: r.token, expiresAt: Date.parse(r.expires_at), user: r.user });
  return { ok: true, user: r.user };
}

async function serverCall(path, init = {}) {
  const { url, token } = await getServerConfig();
  try {
    const res = await fetch(`${url}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...authHeaders(token) }, signal: AbortSignal.timeout(10000) });
    if (res.status === 204) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, ...body } : { ok: false, status: res.status, error: body.error || `http_${res.status}` };
  } catch {
    return { ok: false, error: 'server_unreachable' };
  }
}

export const myTokens = {
  list: () => serverCall('/api/me/tokens'),
  create: (label) => serverCall('/api/me/tokens', { method: 'POST', body: JSON.stringify({ label }) }),
  revoke: (id) => serverCall(`/api/me/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};

export async function signOut() {
  const list = await myTokens.list();
  const current = list.ok && list.tokens?.find(t => t.current);
  if (current) await myTokens.revoke(current.id);
  await clearGoogleSession();
  // Forget Google's token too, so the next sign-in asks Google again (and can
  // pick up a different account) instead of silently reusing this one.
  await dropCachedGoogleToken(lastChromeToken);
}

const DAY = 24 * 60 * 60 * 1000;
const REFRESH_RETRY_MS = 10 * 60 * 1000;
let lastRefreshAttempt = 0;
export async function ensureFreshToken() {
  const s = await getAuthState();
  if (s.mode !== 'google' || !s.expiresAt || s.expiresAt - Date.now() > DAY) return;
  // Runs on every connection check; don't hammer Google if silent sign-in keeps failing.
  if (Date.now() - lastRefreshAttempt < REFRESH_RETRY_MS) return;
  lastRefreshAttempt = Date.now();
  await signInWithGoogle({ interactive: false });
}

// Several connection checks can hit the same 401 at once (config-change listener,
// periodic sync, the setup page). They share one silent re-sign-in; a check that
// arrives just after a successful one is told to retry with the new token.
let lastRecovery = 0;
let lastRecoveryOk = false;
let recovering = null;
export function recoverFromAuthError() {
  // Assigned synchronously, before any await, so concurrent callers always share it.
  if (recovering) return recovering;
  recovering = (async () => {
    const s = await getAuthState();
    if (s.mode !== 'google') return false;
    if (Date.now() - lastRecovery < 60_000) return lastRecoveryOk;
    lastRecovery = Date.now();
    lastRecoveryOk = (await signInWithGoogle({ interactive: false })).ok;
    return lastRecoveryOk;
  })().finally(() => { recovering = null; });
  return recovering;
}
