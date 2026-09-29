// Google sign-in: verify a Google OAuth access token and return the company
// account behind it. Used only at sign-in — the server then issues its own token.

export class GoogleAuthError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

export function googleConfig() {
  const clientIds = (process.env.VIBE_GOOGLE_CLIENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return {
    enabled: clientIds.length > 0,
    clientIds,
    domain: (process.env.VIBE_GOOGLE_DOMAIN || 'maitriservices.com').trim().toLowerCase(),
    // Overridable for tests only.
    tokeninfoUrl: process.env.VIBE_GOOGLE_TOKENINFO_URL || 'https://oauth2.googleapis.com/tokeninfo',
    userinfoUrl: process.env.VIBE_GOOGLE_USERINFO_URL || 'https://openidconnect.googleapis.com/v1/userinfo',
  };
}

async function getJson(fetchImpl, url, init) {
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(5000) });
  } catch {
    throw new GoogleAuthError('google_unreachable');
  }
  if (res.status >= 500) throw new GoogleAuthError('google_unreachable');
  if (!res.ok) throw new GoogleAuthError('invalid_token');
  return res.json();
}

export async function verifyGoogleAccessToken(accessToken, cfg = googleConfig(), fetchImpl = fetch) {
  if (!accessToken || typeof accessToken !== 'string') throw new GoogleAuthError('invalid_token');

  const info = await getJson(fetchImpl, `${cfg.tokeninfoUrl}?access_token=${encodeURIComponent(accessToken)}`);
  if (!(Number(info.expires_in) > 0)) throw new GoogleAuthError('invalid_token');
  if (!cfg.clientIds.includes(info.aud) && !cfg.clientIds.includes(info.azp)) throw new GoogleAuthError('wrong_client');

  const me = await getJson(fetchImpl, cfg.userinfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
  const email = String(me.email || '').trim().toLowerCase();
  if (me.email_verified !== true) throw new GoogleAuthError('unverified_email');
  const domain = cfg.domain;
  if (String(me.hd || '').toLowerCase() !== domain || !email.endsWith(`@${domain}`)) throw new GoogleAuthError('wrong_domain');

  return { email, name: String(me.name || '').trim() || email };
}
