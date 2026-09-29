// Google sign-in (public) and self-serve token management (authenticated).
import { googleConfig, verifyGoogleAccessToken } from './google-auth.js';
import { findOrCreateGoogleUser, issueToken, listTokens, revokeToken, isGoogleUser, currentUser, userForToken } from './users.js';

const STATUS = { invalid_token: 401, wrong_client: 401, unverified_email: 401, wrong_domain: 403, google_unreachable: 502 };

// 10 sign-in attempts per minute per IP.
const hits = new Map();
function rateLimited(ip, now = Date.now()) {
  const recent = (hits.get(ip) || []).filter(t => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 10;
}

// Must be registered BEFORE the /api authenticate middleware.
export function registerPublicAuthRoutes(app) {
  app.post('/api/auth/google', async (req, res) => {
    if (rateLimited(req.ip)) return res.status(429).json({ error: 'rate_limited' });
    const cfg = googleConfig();
    if (!cfg.enabled) return res.status(404).json({ error: 'google_sign_in_disabled' });
    const accessToken = req.body?.access_token;
    if (!accessToken || typeof accessToken !== 'string') return res.status(400).json({ error: 'invalid_request' });
    try {
      const { email, name } = await verifyGoogleAccessToken(accessToken, cfg);
      const user = findOrCreateGoogleUser({ email, name });
      // previous_token = this browser's old server token: replace just that one so
      // other browsers of the same person stay signed in. Only honoured for the same user.
      const prev = typeof req.body?.previous_token === 'string' ? userForToken(req.body.previous_token) : null;
      const replaceTokenId = prev && prev.id === user.id && prev.tokenId ? prev.tokenId : undefined;
      const { token, expires_at } = issueToken(user.id, { kind: 'extension', label: 'Chrome extension', replaceTokenId });
      res.json({ token, expires_at, user });
    } catch (err) {
      const status = STATUS[err.code];
      if (!status) { console.error('[auth/google]', err); return res.status(500).json({ error: 'internal_error' }); }
      res.status(status).json({ error: err.code });
    }
  });
}

// Registered AFTER authenticate: req.auth.extra = { user, tokenId, kind }.
// Creating/revoking tokens needs the extension's (Google sign-in) token — a
// Claude Code token can list but not mint or revoke.
const extensionOnly = (req, res) => {
  if (req.auth?.extra?.kind === 'extension') return false;
  res.status(403).json({ error: 'extension_only' });
  return true;
};

export function registerMeRoutes(app) {
  app.get('/api/me/tokens', (req, res) => {
    const user = currentUser();
    if (!user || !isGoogleUser(user.id)) return res.json({ google: false, tokens: [] });
    const current = req.auth?.extra?.tokenId;
    res.json({ google: true, tokens: listTokens(user.id).map(t => ({ ...t, current: t.id === current })) });
  });

  app.post('/api/me/tokens', (req, res) => {
    const user = currentUser();
    if (!user || !isGoogleUser(user.id)) return res.status(403).json({ error: 'google_only' });
    if (extensionOnly(req, res)) return;
    const label = String(req.body?.label ?? '').trim();
    if (label.length < 1 || label.length > 40) return res.status(400).json({ error: 'invalid_label' });
    try {
      const { id, token } = issueToken(user.id, { kind: 'mcp', label });
      res.status(201).json({ id, label, token });
    } catch (err) {
      if (err.code === 'too_many_tokens') return res.status(409).json({ error: 'too_many_tokens' });
      throw err;
    }
  });

  app.delete('/api/me/tokens/:id', (req, res) => {
    const user = currentUser();
    if (!user || !isGoogleUser(user.id)) return res.status(403).json({ error: 'google_only' });
    if (extensionOnly(req, res)) return;
    if (!revokeToken(user.id, req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });
}
