# Google Sign-in + Self-serve Claude Code Tokens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teammates sign in to the extension with their `@maitriservices.com` Google account (no token pasting) and create per-machine Claude Code MCP tokens from the extension's setup page.

**Architecture:** Google is used only at sign-in. The server verifies a Google access token once (tokeninfo + userinfo), auto-creates the user and issues its own `vat_…` token. Every other request keeps using today's bearer-token path, which is extended to a per-user `tokens[]` list with expiry. The extension's Options page gets the sign-in flow and a "Claude Code" token manager; the background worker owns `chrome.identity` and refreshes the 7-day extension token silently.

**Tech Stack:** Node 24 + Express 4 (server, ESM), `node:test` (no new deps), WXT 0.20 MV3 extension (vanilla JS), `chrome.identity`, `chrome.alarms`, Playwright-core + bundled Chromium for the extension check.

**Spec:** `docs/superpowers/specs/2026-09-29-google-sign-in-design.md`

## Global Constraints

- Allowed domain: `VIBE_GOOGLE_DOMAIN`, default `maitriservices.com`; require `email_verified === true`, `hd === domain`, AND the email ending in `@domain`.
- Google sign-in is enabled only when `VIBE_GOOGLE_CLIENT_IDS` (comma-separated) is set; the token's `aud` or `azp` must be one of them.
- Extension tokens: `kind: "extension"`, label `"Chrome extension"`, expire after 7 days, at most one live per user (older ones removed on sign-in).
- MCP tokens: `kind: "mcp"`, no expiry, label 1–40 chars trimmed, max 20 per user → 409.
- `POST /api/auth/google` is public and rate-limited to 10 requests per minute per IP (429).
- Server stores only SHA-256 hashes of tokens; a new MCP token is returned exactly once.
- Legacy users (`token_sha256`, no `auth`) keep working unchanged and are never linked to Google users.
- Google user id = lower-cased email.
- No new npm dependencies.
- Extension builds without Google env vars: no `identity`/`oauth2` in the manifest, and the sign-in UI is hidden.
- UI copy is taken verbatim from the spec's "Error messages" table.

## Review Focus

1. **Email case / whitespace**: `Jane@MaitriServices.com` and `jane@maitriservices.com` must be the same user → test in Task 1 (`findOrCreateGoogleUser` lower-cases).
2. **A token from another Google app** (right domain, wrong `aud`) must be refused, not accepted → test in Task 2 (`wrong_client`).
3. **Subdomain / lookalike domains** (`evil-maitriservices.com`, `maitriservices.com.evil.io`, `hd` missing) must be refused → tests in Task 2.
4. **Revoked or expired token in the extension**: the extension must try one silent re-sign-in and then show "Signed out…", not loop or spam Google → test in Task 5 (refresh called once per 401).
5. **Legacy token user opening the Claude Code section**: must see a clear "only for Google sign-in accounts" state, not a broken list → test in Task 3 (`POST /api/me/tokens` → 403 for legacy) and UI in Task 6.

---

## File Structure

**Server (`packages/server`)**
- `lib/google-auth.js` *(new)*: config (`googleConfig()`) and `verifyGoogleAccessToken()`. Knows Google, not users.
- `lib/users.js` *(modify)*: Google users, per-user `tokens[]`, lookup with expiry, token create/revoke/list.
- `lib/auth-routes.js` *(new)*: `registerAuthRoutes(app)`: `/api/auth/google` (public, rate-limited) and `/api/me/tokens*`.
- `lib/server.js` *(modify)*: mount the public route before `authenticate`, put `tokenId` on `req.auth.extra`, add `google_sign_in` to `/health`.
- `bin/cli.js` *(modify)*: `users list` shows the Google-user token count.
- `test/fake-google.js` *(new)*: tiny HTTP fake for tokeninfo/userinfo (used by server tests and the extension check).
- `test/users.test.js`, `test/google-auth.test.js`, `test/auth-endpoints.test.js` *(new)*.
- `package.json` *(modify)*: `"test": "node --test test/"`.

**Extension (`packages/extension`)**
- `lib/background/google-auth.js` *(new)*: `getGoogleAccessToken`, `signInWithGoogle`, `signOut`, `ensureFreshToken`, `recoverFromAuthError`, `myTokens` API calls.
- `lib/server-config.js` *(modify)*: add `vibeAuthMode`, `vibeTokenExpiresAt`, `vibeUser` to stored keys; `getAuthState()`.
- `lib/background/api-sync.js` *(modify)*: `checkConnection` calls `ensureFreshToken()` first and `recoverFromAuthError()` once on 401.
- `entrypoints/background.js` *(modify)*: message cases + `chrome.alarms` refresh.
- `wxt.config.js` *(modify)*: `identity` + `alarms` permissions and `oauth2` from build env; inject `import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID`.
- `entrypoints/options/index.html`, `entrypoints/options/main.js`, `entrypoints/options/style.css` *(rewrite / new)*: the setup page UI.
- `PUBLISHING.md` *(modify)*: GCP admin setup.

---

### Task 1: Users — Google users and per-user tokens

**Files:**
- Modify: `packages/server/lib/users.js`
- Modify: `packages/server/package.json` (test script)
- Test: `packages/server/test/users.test.js`

**Interfaces:**
- Produces (all exported from `lib/users.js`):
  - `findOrCreateGoogleUser({ email, name }) → { id, name }` (id = lower-cased email)
  - `issueToken(userId, { kind: 'extension'|'mcp', label }) → { id, token, expires_at|null }`; for `extension`, replaces the user's other extension tokens; for `mcp`, throws `Error` with `code = 'too_many_tokens'` beyond 20.
  - `listTokens(userId) → [{ id, label, kind, created_at, expires_at }]` (no hashes; expired filtered out)
  - `revokeToken(userId, tokenId) → boolean`
  - `userForToken(token, now = Date.now()) → { id, name, tokenId, auth } | null` (`tokenId` null and `auth` `'legacy'` for legacy users)
  - `isGoogleUser(userId) → boolean`
  - constants `EXTENSION_TOKEN_TTL_MS = 604800000`, `MAX_MCP_TOKENS = 20`
  - `teamModeEnabled()` is now true when users exist **or** Google sign-in is configured (imports `googleConfig` from Task 2's module; create the module stub in this task, see Step 3).

- [ ] **Step 1: Add the test script**

In `packages/server/package.json` replace the `"test"` script:

```json
    "test": "node --test test/"
```

- [ ] **Step 2: Write the failing tests** — `packages/server/test/users.test.js`

```js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const dir = mkdtempSync(path.join(tmpdir(), 'vibe-users-'));
process.env.VIBE_USERS_FILE = path.join(dir, 'users.json');
const U = await import('../lib/users.js');

beforeEach(() => writeFileSync(process.env.VIBE_USERS_FILE, JSON.stringify({ users: [] })));

test('google user is created once, keyed by lower-cased email', () => {
  const a = U.findOrCreateGoogleUser({ email: 'Jane@MaitriServices.com ', name: 'Jane Doe' });
  const b = U.findOrCreateGoogleUser({ email: 'jane@maitriservices.com', name: 'Jane D.' });
  assert.equal(a.id, 'jane@maitriservices.com');
  assert.equal(b.id, a.id);
  assert.equal(U.loadUsers().length, 1);
  assert.equal(U.isGoogleUser(a.id), true);
});

test('extension token authenticates and a new sign-in replaces the old one', () => {
  const u = U.findOrCreateGoogleUser({ email: 'jane@maitriservices.com', name: 'Jane' });
  const first = U.issueToken(u.id, { kind: 'extension', label: 'Chrome extension' });
  assert.match(first.token, /^vat_/);
  assert.ok(first.expires_at);
  assert.deepEqual(U.userForToken(first.token), { id: u.id, name: 'Jane', tokenId: first.id, auth: 'google' });
  const second = U.issueToken(u.id, { kind: 'extension', label: 'Chrome extension' });
  assert.equal(U.userForToken(first.token), null);
  assert.equal(U.userForToken(second.token).tokenId, second.id);
});

test('expired tokens are rejected and not listed', () => {
  const u = U.findOrCreateGoogleUser({ email: 'jane@maitriservices.com', name: 'Jane' });
  const t = U.issueToken(u.id, { kind: 'extension', label: 'Chrome extension' });
  const later = Date.now() + U.EXTENSION_TOKEN_TTL_MS + 1000;
  assert.equal(U.userForToken(t.token, later), null);
  assert.equal(U.listTokens(u.id, later).length, 0);
});

test('mcp tokens: list without hashes, revoke one, cap at 20', () => {
  const u = U.findOrCreateGoogleUser({ email: 'jane@maitriservices.com', name: 'Jane' });
  const laptop = U.issueToken(u.id, { kind: 'mcp', label: 'laptop' });
  const server = U.issueToken(u.id, { kind: 'mcp', label: 'dev server' });
  const list = U.listTokens(u.id);
  assert.deepEqual(list.map(t => t.label).sort(), ['dev server', 'laptop']);
  assert.ok(list.every(t => !('sha256' in t)));
  assert.equal(U.revokeToken(u.id, laptop.id), true);
  assert.equal(U.userForToken(laptop.token), null);
  assert.equal(U.userForToken(server.token).id, u.id);
  assert.equal(U.revokeToken(u.id, 'nope'), false);
  for (let i = 0; i < 19; i++) U.issueToken(u.id, { kind: 'mcp', label: `m${i}` });
  assert.throws(() => U.issueToken(u.id, { kind: 'mcp', label: 'one too many' }), e => e.code === 'too_many_tokens');
});

test('revokeToken cannot touch another user\'s token', () => {
  const jane = U.findOrCreateGoogleUser({ email: 'jane@maitriservices.com', name: 'Jane' });
  const bob = U.findOrCreateGoogleUser({ email: 'bob@maitriservices.com', name: 'Bob' });
  const t = U.issueToken(jane.id, { kind: 'mcp', label: 'laptop' });
  assert.equal(U.revokeToken(bob.id, t.id), false);
  assert.ok(U.userForToken(t.token));
});

test('legacy users keep working and are untouched', () => {
  const token = U.addUser('bhesh', 'Bhesh');
  U.findOrCreateGoogleUser({ email: 'bhesh@maitriservices.com', name: 'Bhesh' });
  assert.deepEqual(U.userForToken(token), { id: 'bhesh', name: 'Bhesh', tokenId: null, auth: 'legacy' });
  assert.equal(U.isGoogleUser('bhesh'), false);
  const raw = JSON.parse(readFileSync(process.env.VIBE_USERS_FILE, 'utf8'));
  assert.equal(raw.users.length, 2);
});

test('removeUser removes a google user and all their tokens', () => {
  const u = U.findOrCreateGoogleUser({ email: 'jane@maitriservices.com', name: 'Jane' });
  const t = U.issueToken(u.id, { kind: 'mcp', label: 'laptop' });
  U.removeUser(u.id);
  assert.equal(U.userForToken(t.token), null);
});
```

- [ ] **Step 3: Run to verify failure**

Create the stub `packages/server/lib/google-auth.js` so the import resolves (Task 2 fills it in):

```js
export function googleConfig() {
  const clientIds = (process.env.VIBE_GOOGLE_CLIENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return { enabled: clientIds.length > 0, clientIds, domain: (process.env.VIBE_GOOGLE_DOMAIN || 'maitriservices.com').toLowerCase() };
}
```

Run: `cd packages/server && pnpm test`
Expected: FAIL (`U.findOrCreateGoogleUser is not a function`).

- [ ] **Step 4: Implement in `lib/users.js`**

Add `import { googleConfig } from './google-auth.js';` to the imports. Replace `teamModeEnabled` and `userForToken`, and add the new functions after `removeUser`:

```js
export function teamModeEnabled() {
  return loadUsers().length > 0 || googleConfig().enabled;
}

const live = (t, now) => !t.expires_at || Date.parse(t.expires_at) > now;

// Token → { id, name, tokenId, auth } or null. Legacy users have one token_sha256;
// Google users have a tokens[] list whose entries may expire.
export function userForToken(token, now = Date.now()) {
  if (!token) return null;
  const h = sha256(token);
  for (const u of loadUsers()) {
    if (u.token_sha256 && hashesMatch(u.token_sha256, h)) {
      return { id: u.id, name: u.name || u.id, tokenId: null, auth: 'legacy' };
    }
    const t = (u.tokens || []).find(t => live(t, now) && hashesMatch(t.sha256, h));
    if (t) return { id: u.id, name: u.name || u.id, tokenId: t.id, auth: u.auth || 'legacy' };
  }
  return null;
}
```

```js
// --- Google users (self-serve) ---

export const EXTENSION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_MCP_TOKENS = 20;

export function isGoogleUser(id) {
  return loadUsers().some(u => u.id === id && u.auth === 'google');
}

export function findOrCreateGoogleUser({ email, name }) {
  const id = String(email || '').trim().toLowerCase();
  if (!id.includes('@')) throw new Error('Google user needs an email.');
  const users = loadUsers();
  const existing = users.find(u => u.id === id && u.auth === 'google');
  if (existing) return { id, name: existing.name || id };
  const user = { id, name: name || id, email: id, auth: 'google', created_at: new Date().toISOString(), tokens: [] };
  writeUsers([...users, user]);
  return { id, name: user.name };
}

export function issueToken(userId, { kind, label }) {
  const users = loadUsers();
  const u = users.find(x => x.id === userId && x.auth === 'google');
  if (!u) throw new Error(`No Google user "${userId}".`);
  const now = Date.now();
  let tokens = (u.tokens || []).filter(t => live(t, now));
  if (kind === 'extension') tokens = tokens.filter(t => t.kind !== 'extension');
  if (kind === 'mcp' && tokens.filter(t => t.kind === 'mcp').length >= MAX_MCP_TOKENS) {
    throw Object.assign(new Error(`At most ${MAX_MCP_TOKENS} Claude Code tokens — revoke one first.`), { code: 'too_many_tokens' });
  }
  const token = newToken();
  const entry = {
    id: 't_' + randomBytes(6).toString('hex'),
    label, kind, sha256: sha256(token),
    created_at: new Date(now).toISOString(),
    expires_at: kind === 'extension' ? new Date(now + EXTENSION_TOKEN_TTL_MS).toISOString() : null,
  };
  writeUsers(users.map(x => x === u ? { ...u, tokens: [...tokens, entry] } : x));
  return { id: entry.id, token, expires_at: entry.expires_at };
}

export function listTokens(userId, now = Date.now()) {
  const u = loadUsers().find(x => x.id === userId);
  return (u?.tokens || []).filter(t => live(t, now))
    .map(({ id, label, kind, created_at, expires_at }) => ({ id, label, kind, created_at, expires_at }));
}

export function revokeToken(userId, tokenId) {
  const users = loadUsers();
  const u = users.find(x => x.id === userId);
  if (!u || !(u.tokens || []).some(t => t.id === tokenId)) return false;
  writeUsers(users.map(x => x === u ? { ...u, tokens: u.tokens.filter(t => t.id !== tokenId) } : x));
  return true;
}
```

Note: `writeUsers` writes the file; `loadUsers` re-reads by mtime. Two writes in the same millisecond can share an mtime, so make `writeUsers` also refresh the cache:

```js
function writeUsers(users) {
  mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2) + '\n', { mode: 0o600 });
  cache = { mtimeMs: statSync(USERS_FILE).mtimeMs, users };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/server && pnpm test`
Expected: all 7 tests in `users.test.js` PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/lib/users.js packages/server/lib/google-auth.js packages/server/test/users.test.js packages/server/package.json
git commit -m "feat(server): google users with per-user expiring tokens"
```

---

### Task 2: Google token verification

**Files:**
- Modify: `packages/server/lib/google-auth.js`
- Create: `packages/server/test/fake-google.js`
- Test: `packages/server/test/google-auth.test.js`

**Interfaces:**
- Consumes: `googleConfig()` (stub from Task 1).
- Produces:
  - `googleConfig() → { enabled, clientIds: string[], domain, tokeninfoUrl, userinfoUrl }`
  - `verifyGoogleAccessToken(accessToken, cfg = googleConfig(), fetchImpl = fetch) → Promise<{ email, name }>`; rejects with `GoogleAuthError` whose `.code` ∈ `invalid_token | wrong_client | wrong_domain | unverified_email | google_unreachable`.
  - `test/fake-google.js`: `startFakeGoogle({ clientId }) → Promise<{ url, close() }>` serving `GET /tokeninfo?access_token=` and `GET /userinfo`, with fixed tokens: `good` (jane@maitriservices.com, Jane Doe), `good-upper` (Jane@MaitriServices.com), `outsider` (sam@gmail.com, no hd), `lookalike` (eve@evil-maitriservices.com, hd evil-maitriservices.com), `suffix-trick` (eve@maitriservices.com.evil.io, hd maitriservices.com.evil.io), `unverified` (email_verified false), `other-app` (aud other-client), anything else → 400 `invalid_token`.

- [ ] **Step 1: Write the fake Google** — `packages/server/test/fake-google.js`

```js
// Minimal stand-in for Google's tokeninfo + userinfo endpoints (tests only).
import http from 'http';

export async function startFakeGoogle({ clientId = 'test-client.apps.googleusercontent.com' } = {}) {
  const people = {
    good: { email: 'jane@maitriservices.com', hd: 'maitriservices.com', name: 'Jane Doe' },
    'good-upper': { email: 'Jane@MaitriServices.com', hd: 'maitriservices.com', name: 'Jane Doe' },
    outsider: { email: 'sam@gmail.com', name: 'Sam' },
    lookalike: { email: 'eve@evil-maitriservices.com', hd: 'evil-maitriservices.com', name: 'Eve' },
    'suffix-trick': { email: 'eve@maitriservices.com.evil.io', hd: 'maitriservices.com.evil.io', name: 'Eve' },
    unverified: { email: 'jo@maitriservices.com', hd: 'maitriservices.com', name: 'Jo', email_verified: false },
    'other-app': { email: 'jane@maitriservices.com', hd: 'maitriservices.com', name: 'Jane Doe', aud: 'other-client' },
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const token = url.pathname === '/tokeninfo'
      ? url.searchParams.get('access_token')
      : (req.headers.authorization || '').replace(/^Bearer /, '');
    const p = people[token];
    res.setHeader('Content-Type', 'application/json');
    if (!p) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid_token' })); }
    if (url.pathname === '/tokeninfo') {
      const aud = p.aud || clientId;
      return res.end(JSON.stringify({ aud, azp: aud, expires_in: '3599', email: p.email }));
    }
    if (url.pathname === '/userinfo') {
      return res.end(JSON.stringify({ email: p.email, email_verified: p.email_verified ?? true, name: p.name, ...(p.hd ? { hd: p.hd } : {}) }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, clientId, close: () => new Promise(r => server.close(r)) };
}
```

- [ ] **Step 2: Write the failing tests** — `packages/server/test/google-auth.test.js`

```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeGoogle } from './fake-google.js';
import { verifyGoogleAccessToken } from '../lib/google-auth.js';

let g, cfg;
before(async () => {
  g = await startFakeGoogle();
  cfg = { enabled: true, clientIds: [g.clientId], domain: 'maitriservices.com',
    tokeninfoUrl: `${g.url}/tokeninfo`, userinfoUrl: `${g.url}/userinfo` };
});
after(() => g.close());

const code = (c) => (e) => e.code === c;

test('accepts a verified company account', async () => {
  assert.deepEqual(await verifyGoogleAccessToken('good', cfg), { email: 'jane@maitriservices.com', name: 'Jane Doe' });
});
test('lower-cases the email', async () => {
  assert.equal((await verifyGoogleAccessToken('good-upper', cfg)).email, 'jane@maitriservices.com');
});
test('rejects other domains', async () => {
  await assert.rejects(verifyGoogleAccessToken('outsider', cfg), code('wrong_domain'));
  await assert.rejects(verifyGoogleAccessToken('lookalike', cfg), code('wrong_domain'));
  await assert.rejects(verifyGoogleAccessToken('suffix-trick', cfg), code('wrong_domain'));
});
test('rejects unverified email', async () => {
  await assert.rejects(verifyGoogleAccessToken('unverified', cfg), code('unverified_email'));
});
test('rejects tokens issued to another app', async () => {
  await assert.rejects(verifyGoogleAccessToken('other-app', cfg), code('wrong_client'));
});
test('rejects unknown tokens', async () => {
  await assert.rejects(verifyGoogleAccessToken('garbage', cfg), code('invalid_token'));
  await assert.rejects(verifyGoogleAccessToken('', cfg), code('invalid_token'));
});
test('reports Google being unreachable', async () => {
  const down = { ...cfg, tokeninfoUrl: 'http://127.0.0.1:1/tokeninfo' };
  await assert.rejects(verifyGoogleAccessToken('good', down), code('google_unreachable'));
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd packages/server && node --test test/google-auth.test.js`
Expected: FAIL (`verifyGoogleAccessToken` not exported).

- [ ] **Step 4: Implement** — replace `packages/server/lib/google-auth.js`

```js
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
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/server && pnpm test`
Expected: all tests in `users.test.js` and `google-auth.test.js` PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/lib/google-auth.js packages/server/test/fake-google.js packages/server/test/google-auth.test.js
git commit -m "feat(server): verify Google access tokens (client, domain, verified email)"
```

---

### Task 3: Auth endpoints, server wiring, CLI

**Files:**
- Create: `packages/server/lib/auth-routes.js`
- Modify: `packages/server/lib/server.js` (`authenticate` ~line 67, `setupExpress` ~lines 187–201)
- Modify: `packages/server/bin/cli.js` (`users list`, ~line 303)
- Test: `packages/server/test/auth-endpoints.test.js`

**Interfaces:**
- Consumes: `verifyGoogleAccessToken`, `googleConfig`, `GoogleAuthError` (Task 2); `findOrCreateGoogleUser`, `issueToken`, `listTokens`, `revokeToken`, `isGoogleUser` (Task 1).
- Produces (HTTP):
  - `POST /api/auth/google {access_token}` → `200 {token, expires_at, user:{id,name}}` | `400 {error:'invalid_request'}` | `401 {error:'invalid_token'|'wrong_client'|'unverified_email'}` | `403 {error:'wrong_domain'}` | `404 {error:'google_sign_in_disabled'}` | `429 {error:'rate_limited'}` | `502 {error:'google_unreachable'}`
  - `GET /api/me/tokens` → `200 {google: bool, tokens:[{id,label,kind,created_at,expires_at,current}]}`
  - `POST /api/me/tokens {label}` → `201 {id,label,token}` | `400 {error:'invalid_label'}` | `403 {error:'google_only'}` | `409 {error:'too_many_tokens'}`
  - `DELETE /api/me/tokens/:id` → `204` | `403 {error:'google_only'}` | `404 {error:'not_found'}`
  - `/health` gains `google_sign_in: boolean`.
  - `req.auth.extra` gains `tokenId`.

- [ ] **Step 1: Write the failing endpoint tests** — `packages/server/test/auth-endpoints.test.js`

```js
// Runs the real server as a child process against the fake Google.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { startFakeGoogle } from './fake-google.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let g, proc, base;

before(async () => {
  g = await startFakeGoogle();
  const home = mkdtempSync(path.join(tmpdir(), 'vibe-srv-'));
  // A legacy token user, to check google-only endpoints refuse it.
  const { createHash } = await import('crypto');
  writeFileSync(path.join(home, 'users.json'), JSON.stringify({ users: [
    { id: 'bhesh', name: 'Bhesh', token_sha256: createHash('sha256').update('vat_legacy').digest('hex') },
  ] }));
  const port = 40000 + Math.floor(Math.random() * 20000);
  base = `http://127.0.0.1:${port}`;
  proc = spawn(process.execPath, [path.join(here, '../lib/server.js')], {
    env: { ...process.env, HOME: home, VIBE_PORT: String(port), VIBE_HOST: '127.0.0.1',
      VIBE_USERS_FILE: path.join(home, 'users.json'),
      VIBE_GOOGLE_CLIENT_IDS: g.clientId,
      VIBE_GOOGLE_TOKENINFO_URL: `${g.url}/tokeninfo`, VIBE_GOOGLE_USERINFO_URL: `${g.url}/userinfo` },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(async () => { proc.kill(); await g.close(); });

const post = (p, body, token) => fetch(base + p, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body) });
const get = (p, token) => fetch(base + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('health reports google sign-in', async () => {
  assert.equal((await (await get('/health')).json()).google_sign_in, true);
});

test('sign in, whoami, create/list/revoke mcp tokens', async () => {
  const r = await post('/api/auth/google', { access_token: 'good' });
  assert.equal(r.status, 200);
  const { token, user, expires_at } = await r.json();
  assert.equal(user.id, 'jane@maitriservices.com');
  assert.ok(Date.parse(expires_at) > Date.now());
  assert.deepEqual((await (await get('/api/whoami', token)).json()).user, { id: 'jane@maitriservices.com', name: 'Jane Doe' });

  const created = await post('/api/me/tokens', { label: '  laptop  ' }, token);
  assert.equal(created.status, 201);
  const mcp = await created.json();
  assert.equal(mcp.label, 'laptop');
  assert.equal((await get('/api/whoami', mcp.token)).status, 200);

  const list = await (await get('/api/me/tokens', token)).json();
  assert.equal(list.google, true);
  assert.deepEqual(list.tokens.map(t => [t.kind, t.current]).sort(), [['extension', true], ['mcp', false]]);

  const del = await fetch(`${base}/api/me/tokens/${mcp.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(del.status, 204);
  assert.equal((await get('/api/whoami', mcp.token)).status, 401);
  const again = await fetch(`${base}/api/me/tokens/${mcp.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(again.status, 404);
});

test('sign-in errors map to the documented statuses', async () => {
  assert.equal((await post('/api/auth/google', {})).status, 400);
  assert.equal((await post('/api/auth/google', { access_token: 'outsider' })).status, 403);
  assert.equal((await post('/api/auth/google', { access_token: 'other-app' })).status, 401);
  assert.equal((await post('/api/auth/google', { access_token: 'garbage' })).status, 401);
});

test('label validation', async () => {
  const { token } = await (await post('/api/auth/google', { access_token: 'good' })).json();
  assert.equal((await post('/api/me/tokens', { label: '' }, token)).status, 400);
  assert.equal((await post('/api/me/tokens', { label: 'x'.repeat(41) }, token)).status, 400);
});

test('legacy token users get google_only on token management', async () => {
  const list = await (await get('/api/me/tokens', 'vat_legacy')).json();
  assert.deepEqual(list, { google: false, tokens: [] });
  assert.equal((await post('/api/me/tokens', { label: 'laptop' }, 'vat_legacy')).status, 403);
});

test('rate limit on sign-in', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await post('/api/auth/google', { access_token: 'garbage' });
  assert.equal(last.status, 429);
});
```

(Order matters: `rate limit on sign-in` must stay the last test in the file.)

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/server && node --test test/auth-endpoints.test.js`
Expected: FAIL (`google_sign_in` undefined; `/api/auth/google` 401 from `authenticate`).

- [ ] **Step 3: Implement `lib/auth-routes.js`**

```js
// Google sign-in (public) and self-serve token management (authenticated).
import { googleConfig, verifyGoogleAccessToken } from './google-auth.js';
import { findOrCreateGoogleUser, issueToken, listTokens, revokeToken, isGoogleUser, currentUser } from './users.js';

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
      const { token, expires_at } = issueToken(user.id, { kind: 'extension', label: 'Chrome extension' });
      res.json({ token, expires_at, user });
    } catch (err) {
      const status = STATUS[err.code];
      if (!status) { console.error('[auth/google]', err); return res.status(500).json({ error: 'internal_error' }); }
      res.status(status).json({ error: err.code });
    }
  });
}

// Registered AFTER authenticate: req.auth.extra = { user, tokenId }.
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
    if (!revokeToken(user.id, req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });
}
```

- [ ] **Step 4: Wire into `lib/server.js`**

Imports: add `import { registerPublicAuthRoutes, registerMeRoutes } from './auth-routes.js';` and `import { googleConfig } from './google-auth.js';`.

In `authenticate`, keep the request-context user minimal and carry the token id separately:

```js
    const found = userForToken(token);
    if (!found) return res.status(401).json({ error: 'unauthorized', error_description: 'Missing or invalid user token.' });
    const user = { id: found.id, name: found.name };
    // req.auth reaches MCP tool handlers as extra.authInfo.
    req.auth = { token, clientId: user.id, scopes: [], extra: { user, tokenId: found.tokenId } };
    return requestContext.run({ user, scope: 'own' }, next);
```

In `/health` add `google_sign_in: googleConfig().enabled,`.

Directly before `this.app.use(['/api', '/mcp', '/sse', '/messages'], authenticate);` add `registerPublicAuthRoutes(this.app);`, and directly after the `/api/whoami` route add `registerMeRoutes(this.app);`.

In `start()`'s log block add: `if (googleConfig().enabled) console.log(`Google sign-in: ${googleConfig().domain}`);`

- [ ] **Step 5: CLI list** — in `bin/cli.js` `users list` action replace the loop:

```js
    for (const u of all) {
      const how = u.auth === 'google' ? chalk.gray(`google · ${(u.tokens || []).length} token(s)`) : chalk.gray('token');
      console.log(`${u.id.padEnd(34)} ${(u.name || '').padEnd(24)} ${how}`);
    }
```

- [ ] **Step 6: Run all server tests**

Run: `cd packages/server && pnpm test`
Expected: all PASS (users, google-auth, auth-endpoints).

- [ ] **Step 7: Commit**

```bash
git add packages/server/lib/auth-routes.js packages/server/lib/server.js packages/server/bin/cli.js packages/server/test/auth-endpoints.test.js
git commit -m "feat(server): Google sign-in endpoint and self-serve token API"
```

---

### Task 4: Extension build config and stored auth state

**Files:**
- Modify: `packages/extension/wxt.config.js`
- Modify: `packages/extension/lib/server-config.js`

**Interfaces:**
- Produces:
  - Manifest: when `VIBE_GOOGLE_CLIENT_ID` is set at build time → permissions add `identity`, `alarms`; `oauth2: { client_id, scopes: ['openid','email','profile'] }`. `alarms` is always added (cheap; used for refresh).
  - `import.meta.env.WXT_GOOGLE_WEB_CLIENT_ID` (string, may be empty) and `import.meta.env.WXT_GOOGLE_CLIENT_ID`.
  - `server-config.js`: `getAuthState() → Promise<{ mode: 'google'|'token'|'none', user: {id,name}|null, expiresAt: number|null }>`, `saveGoogleSession({ token, expiresAt, user })`, `clearGoogleSession()`, `googleSignInAvailable() → boolean` (true when the manifest has `oauth2`).

- [ ] **Step 1: Manifest from env** — in `wxt.config.js`, above `export default`:

```js
// Google sign-in is compiled in only when the OAuth client ids are provided:
//   VIBE_GOOGLE_CLIENT_ID      — "Chrome Extension" client (chrome.identity.getAuthToken)
//   VIBE_GOOGLE_WEB_CLIENT_ID  — "Web application" client (pop-up fallback for non-Chrome browsers)
const GOOGLE_CLIENT_ID = process.env.VIBE_GOOGLE_CLIENT_ID || '';
const GOOGLE_WEB_CLIENT_ID = process.env.VIBE_GOOGLE_WEB_CLIENT_ID || '';
```

Change `permissions` and add `oauth2`, plus a `vite` block exposing the web client id:

```js
    permissions: ['activeTab', 'storage', 'scripting', 'alarms', ...(GOOGLE_CLIENT_ID ? ['identity'] : [])],
    ...(GOOGLE_CLIENT_ID ? { oauth2: { client_id: GOOGLE_CLIENT_ID, scopes: ['openid', 'email', 'profile'] } } : {}),
```

```js
  vite: () => ({
    define: {
      'import.meta.env.WXT_GOOGLE_CLIENT_ID': JSON.stringify(GOOGLE_CLIENT_ID),
      'import.meta.env.WXT_GOOGLE_WEB_CLIENT_ID': JSON.stringify(GOOGLE_WEB_CLIENT_ID),
    },
  }),
```

- [ ] **Step 2: Stored auth state** — in `lib/server-config.js`, extend storage keys and add helpers:

```js
const AUTH_KEYS = ['vibeAuthMode', 'vibeTokenExpiresAt', 'vibeUser'];

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
```

In `saveServerConfig` (manual token entry) also clear Google mode so a hand-entered token isn't "refreshed" away:

```js
    vibeAuthMode: '', vibeTokenExpiresAt: null, vibeUser: null,
```

- [ ] **Step 3: Build both variants**

Run: `cd packages/extension && npx wxt build && node -e "const m=require('./.output/chrome-mv3/manifest.json');console.log(m.permissions, !!m.oauth2)"`
Expected: `[ 'activeTab', 'storage', 'scripting', 'alarms' ] false`

Run: `VIBE_GOOGLE_CLIENT_ID=test-client.apps.googleusercontent.com npx wxt build && node -e "const m=require('./.output/chrome-mv3/manifest.json');console.log(m.permissions, m.oauth2)"`
Expected: permissions include `identity`; `oauth2.client_id` is `test-client.apps.googleusercontent.com`.

- [ ] **Step 4: Commit**

```bash
git add packages/extension/wxt.config.js packages/extension/lib/server-config.js
git commit -m "feat(extension): optional Google OAuth manifest + stored session state"
```

---

### Task 5: Background — sign-in, refresh, token API

**Files:**
- Create: `packages/extension/lib/background/google-auth.js`
- Modify: `packages/extension/lib/background/api-sync.js` (`checkConnection`)
- Modify: `packages/extension/entrypoints/background.js` (message switch ~line 118; `init()`)

**Interfaces:**
- Consumes: `getServerConfig`, `getAuthState`, `saveGoogleSession`, `clearGoogleSession`, `authHeaders` (Task 4 / existing).
- Produces:
  - `signInWithGoogle({ interactive }) → Promise<{ ok: true, user } | { ok: false, error: string, message: string }>`; `error` ∈ server error codes plus `cancelled`, `unavailable`.
  - `signOut() → Promise<void>` (best-effort `DELETE` of the current extension token, then clear the session)
  - `ensureFreshToken() → Promise<void>` (silent refresh if google mode and expiry < 24h)
  - `recoverFromAuthError() → Promise<boolean>` (one silent re-sign-in; at most once per 60s)
  - `myTokens: { list(), create(label), revoke(id) }` → server JSON or `{ error }`
  - Background messages: `googleSignIn {interactive}`, `googleSignOut`, `getAuthState`, `listMyTokens`, `createMyToken {label}`, `revokeMyToken {id}`; responses `{ success: true, ...result }`.
  - `SIGN_IN_MESSAGES` (exported map from error code → UI copy, verbatim from spec).

- [ ] **Step 1: Implement `lib/background/google-auth.js`**

```js
// Google sign-in for the background worker. Google is only used to obtain a
// server token (POST /api/auth/google); everything else uses that token.
import { getServerConfig, getAuthState, saveGoogleSession, clearGoogleSession, authHeaders } from '../server-config.js';

export const SIGN_IN_MESSAGES = {
  wrong_domain: 'Sign in with your @maitriservices.com account.',
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

async function tokenViaChrome(interactive) {
  const r = await chrome.identity.getAuthToken({ interactive });
  return typeof r === 'string' ? r : r?.token;
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
}

const DAY = 24 * 60 * 60 * 1000;
export async function ensureFreshToken() {
  const s = await getAuthState();
  if (s.mode !== 'google' || !s.expiresAt || s.expiresAt - Date.now() > DAY) return;
  await signInWithGoogle({ interactive: false });
}

let lastRecovery = 0;
export async function recoverFromAuthError() {
  const s = await getAuthState();
  if (s.mode !== 'google' || Date.now() - lastRecovery < 60_000) return false;
  lastRecovery = Date.now();
  return (await signInWithGoogle({ interactive: false })).ok;
}
```

- [ ] **Step 2: Hook refresh into `checkConnection`** (`lib/background/api-sync.js`)

Import: `import { ensureFreshToken, recoverFromAuthError } from './google-auth.js';` and `getAuthState` from `../server-config.js`.

Rename the current `checkConnection` body to `async function checkOnce()` (unchanged), and add:

```js
export async function checkConnection() {
  await ensureFreshToken().catch(() => {});
  let status = await checkOnce();
  if (status.auth_error && await recoverFromAuthError().catch(() => false)) status = await checkOnce();
  if (status.auth_error && (await getAuthState()).mode === 'google') {
    status.problem = "Signed out — open the extension's setup page and sign in with Google.";
  }
  return status;
}
```

- [ ] **Step 3: Background messages + alarm** (`entrypoints/background.js`)

Import: `import { signInWithGoogle, signOut, myTokens, ensureFreshToken } from '../lib/background/google-auth.js';` and `import { getAuthState, googleSignInAvailable } from '../lib/server-config.js';` (merge with the existing `server-config` import).

In `init()` add `this.setupTokenRefresh();` and the method:

```js
  setupTokenRefresh() {
    chrome.alarms.create('vibe-token-refresh', { periodInMinutes: 360 });
    chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'vibe-token-refresh') ensureFreshToken().catch(() => {}); });
  }
```

In the message `switch`, before `default:`:

```js
        case 'getAuthState':
          getAuthState()
            .then(state => sendResponse({ success: true, ...state, googleAvailable: googleSignInAvailable() }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'googleSignIn':
          signInWithGoogle({ interactive: !!request.interactive })
            .then(r => sendResponse({ success: true, ...r }))
            .catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'googleSignOut':
          signOut().then(() => sendResponse({ success: true })).catch(error => sendResponse({ success: false, error: error.message }));
          break;
        case 'listMyTokens':
          myTokens.list().then(r => sendResponse({ success: true, ...r }));
          break;
        case 'createMyToken':
          myTokens.create(request.label).then(r => sendResponse({ success: true, ...r }));
          break;
        case 'revokeMyToken':
          myTokens.revoke(request.id).then(r => sendResponse({ success: true, ...r }));
          break;
```

(Check that the listener returns `true` after the switch so async `sendResponse` works — it already does for existing async cases; keep the same pattern.)

- [ ] **Step 4: Build**

Run: `cd packages/extension && VIBE_GOOGLE_CLIENT_ID=test-client.apps.googleusercontent.com npx wxt build`
Expected: builds with no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/lib/background/google-auth.js packages/extension/lib/background/api-sync.js packages/extension/entrypoints/background.js
git commit -m "feat(extension): Google sign-in, silent token refresh and token API in background"
```

(The behaviour is verified end to end in Task 6, including Review Focus #4: one silent re-sign-in per 401.)

---

### Task 6: Setup page UI + end-to-end check

**Files:**
- Rewrite: `packages/extension/entrypoints/options/index.html`
- Create: `packages/extension/entrypoints/options/style.css`
- Rewrite: `packages/extension/entrypoints/options/main.js`
- Test script (scratchpad, not committed): `e2e-google.cjs`

**Interfaces:**
- Consumes: background messages from Task 5; `getServerConfig`, `saveServerConfig`, `normalizeServerUrl`, `DEFAULT_SERVER_URL`.
- Produces: the page states described below, with stable ids for the e2e script: `#signin`, `#signed-in`, `#who`, `#signout`, `#server-url`, `#advanced`, `#manual-token`, `#manual-save`, `#cc`, `#cc-label`, `#cc-create`, `#cc-result`, `#cc-command`, `#cc-copy`, `#cc-list`, `#status`.

**UI design** (dark, matches the toolbar tokens: bg `#141414`, card `#1e1e1e`, border `#2e2e2e`, accent gradient `#E85B5C→#D03D68`, text `#ececec` / muted `#a3a3a3`; Inter/system font; 480px card, 16px gutter on phones):

```
┌──────────────────────────────────────────────┐
│ ◆ Maitri Annotations                         │  header: icon-hq.png 28px + name
│ Connect to your team's annotation server     │  muted subtitle
├──────────────────────────────────────────────┤
│ SERVER                                        │  section label (11px, caps, muted)
│ [ http://vmi3364039…:3846              ] ● Online │  url input + live status dot/text
│                                              │
│ ── signed out ─────────────────────────────  │
│ [ G  Sign in with Google                ]    │  white button, Google "G" svg, full width
│ Use your @maitriservices.com account.        │  muted hint
│ ▸ Advanced: use a token instead              │  <details id="advanced">: token + Save
│                                              │
│ ── signed in ──────────────────────────────  │
│ (JD) Jane Doe                    [Sign out]  │  initials avatar, name, email muted
│      jane@maitriservices.com                 │
├──────────────────────────────────────────────┤
│ CLAUDE CODE                                   │  only when signed in with Google
│ Give each machine its own token.              │
│ [ laptop            ] [ Create command ]      │
│ ┌ result (shown once) ───────────────────┐   │  mono block, Copy button, warning:
│ │ claude mcp add --scope user …          │   │  "Copy it now — it won't be shown again."
│ └────────────────────────────────────────┘   │  + tip for --scope local on shared server
│ laptop · created 29 Sep            [Revoke]  │  list rows; "this browser" row has no
│ Chrome extension · this browser             │  Revoke button, expires date instead
└──────────────────────────────────────────────┘
│ #status toast area (aria-live=polite)        │
```

States: `loading` (skeleton: buttons disabled), `signed-out`, `signed-in-google`, `signed-in-token` (legacy/manual token: shows "Connected with a token" + note "Claude Code tokens are managed with Google sign-in" and a Sign in with Google button to switch), `google-unavailable` (build without client id: hide Google button, open Advanced by default).

Interaction rules: buttons show a spinner and disable while working; errors appear inline under the control that caused them (red text), not as alerts; Revoke asks inline ("Revoke laptop? [Revoke] [Cancel]") rather than `confirm()`; Copy button flips to "Copied" for 1.5s; everything keyboard reachable with visible focus ring (`outline: 2px solid #d97757`); status dot uses text too (not colour alone).

- [ ] **Step 1: Write `style.css`**

```css
:root { color-scheme: dark; --bg:#141414; --card:#1e1e1e; --line:#2e2e2e; --text:#ececec; --muted:#a3a3a3;
  --faint:#7a7a7a; --accent:#d97757; --ok:#86efac; --err:#fca5a5; --grad:linear-gradient(90deg,#E85B5C,#D03D68); }
* { box-sizing: border-box; }
body { margin:0; min-height:100vh; background:var(--bg); color:var(--text);
  font:14px/1.5 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; display:flex; justify-content:center; padding:48px 16px; }
main { width:100%; max-width:480px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:14px; overflow:hidden; }
.head { display:flex; gap:12px; align-items:center; padding:22px 24px 18px; border-bottom:1px solid var(--line); }
.head img { width:28px; height:28px; border-radius:7px; }
.head h1 { font-size:16px; margin:0; }
.head p { margin:0; color:var(--muted); font-size:13px; }
section { padding:20px 24px; border-bottom:1px solid var(--line); }
section:last-child { border-bottom:0; }
.label { font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--faint); margin:0 0 10px; }
.row { display:flex; gap:8px; align-items:center; }
input { flex:1; min-width:0; padding:10px 12px; border-radius:8px; border:1px solid #333; background:var(--bg); color:inherit;
  font:13px ui-monospace,SFMono-Regular,Menlo,monospace; }
input:focus-visible, button:focus-visible, summary:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.pill { display:inline-flex; gap:6px; align-items:center; font-size:12px; color:var(--muted); white-space:nowrap; }
.dot { width:8px; height:8px; border-radius:50%; background:#555; }
.dot.ok { background:#4ade80; } .dot.err { background:#f87171; }
button { font:inherit; border-radius:8px; cursor:pointer; padding:10px 14px; border:1px solid var(--line); background:#262626; color:var(--text); }
button:disabled { opacity:.55; cursor:default; }
button.primary { border:0; background:var(--grad); color:#fff; font-weight:600; }
button.google { width:100%; display:flex; gap:10px; justify-content:center; align-items:center; background:#fff; color:#1f1f1f; border:0; font-weight:600; padding:11px; }
button.link { background:none; border:0; color:var(--muted); padding:4px 6px; }
button.danger { color:var(--err); }
.hint { color:var(--faint); font-size:12px; margin:8px 0 0; }
.err { color:var(--err); font-size:12px; margin:8px 0 0; min-height:0; }
.err:empty { display:none; }
.user { display:flex; gap:12px; align-items:center; }
.avatar { width:36px; height:36px; border-radius:50%; background:var(--grad); display:grid; place-items:center; font-weight:700; font-size:13px; color:#fff; }
.user .name { font-weight:600; } .user .email { color:var(--muted); font-size:12px; }
.user button { margin-left:auto; }
details { margin-top:14px; } summary { cursor:pointer; color:var(--muted); font-size:13px; }
details .row { margin-top:10px; }
.result { margin-top:14px; border:1px solid #3a3a3a; border-radius:10px; background:var(--bg); padding:12px; }
.result code { display:block; font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; color:#e5e5e5; }
.result .warn { color:#fcd34d; font-size:12px; margin:0 0 8px; }
.result .row { justify-content:space-between; margin-top:10px; }
ul.tokens { list-style:none; margin:14px 0 0; padding:0; }
ul.tokens li { display:flex; align-items:center; gap:10px; padding:10px 0; border-top:1px solid var(--line); font-size:13px; }
ul.tokens .meta { color:var(--faint); font-size:12px; }
ul.tokens .actions { margin-left:auto; display:flex; gap:6px; align-items:center; }
.spin { width:14px; height:14px; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation:s .7s linear infinite; }
@keyframes s { to { transform:rotate(360deg); } }
[hidden] { display:none !important; }
@media (prefers-reduced-motion: reduce) { .spin { animation:none; } }
```

- [ ] **Step 2: Write `index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="manifest.open_in_tab" content="true">
  <title>Annotations Setup</title>
  <link rel="stylesheet" href="./style.css">
</head>
<body>
  <main>
    <div class="card">
      <div class="head">
        <img src="/assets/icons/icon-hq.png" alt="">
        <div><h1>Maitri Annotations</h1><p>Connect to your team's annotation server</p></div>
      </div>

      <section aria-labelledby="l-server">
        <p class="label" id="l-server">Server</p>
        <div class="row">
          <input id="server-url" type="url" spellcheck="false" autocomplete="off" placeholder="http://127.0.0.1:3846" aria-label="Server URL">
          <span class="pill" id="server-state"><span class="dot"></span><span>Checking…</span></span>
        </div>
        <p class="err" id="server-err"></p>

        <div id="signin" hidden>
          <div style="height:16px"></div>
          <button class="google" id="google-btn" type="button">
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.28-3.14.76-4.59l-7.98-6.19A23.94 23.94 0 0 0 0 24c0 3.87.92 7.53 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            <span>Sign in with Google</span>
          </button>
          <p class="hint">Use your @maitriservices.com account.</p>
          <p class="err" id="google-err"></p>
        </div>

        <div id="signed-in" hidden>
          <div style="height:16px"></div>
          <div class="user">
            <div class="avatar" id="avatar"></div>
            <div><div class="name" id="who"></div><div class="email" id="who-email"></div></div>
            <button class="link" id="signout" type="button">Sign out</button>
          </div>
        </div>

        <details id="advanced">
          <summary>Advanced: use a token instead</summary>
          <div class="row">
            <input id="manual-token" type="password" spellcheck="false" autocomplete="off" placeholder="vat_…" aria-label="Token">
            <button id="manual-save" type="button">Save</button>
          </div>
          <p class="hint">Leave the URL empty for a server on this machine.</p>
          <p class="err" id="manual-err"></p>
        </details>
      </section>

      <section id="cc" hidden aria-labelledby="l-cc">
        <p class="label" id="l-cc">Claude Code</p>
        <p class="hint" style="margin:0 0 12px">Give each machine its own token — revoking one never breaks another.</p>
        <div class="row">
          <input id="cc-label" maxlength="40" value="laptop" aria-label="Machine name" style="font-family:inherit">
          <button class="primary" id="cc-create" type="button">Create command</button>
        </div>
        <p class="err" id="cc-err"></p>
        <div class="result" id="cc-result" hidden>
          <p class="warn">Copy it now — it won't be shown again.</p>
          <code id="cc-command"></code>
          <div class="row">
            <span class="hint" style="margin:0">On the shared dev server, run it inside your worktree with <b>--scope local</b>.</span>
            <button id="cc-copy" type="button">Copy</button>
          </div>
        </div>
        <ul class="tokens" id="cc-list"></ul>
      </section>

      <section id="cc-token-note" hidden>
        <p class="label">Claude Code</p>
        <p class="hint" style="margin:0">You're connected with a token. Sign in with Google to create Claude Code commands here.</p>
      </section>
    </div>
    <p class="hint" id="status" role="status" aria-live="polite" style="text-align:center"></p>
  </main>
  <script type="module" src="./main.js"></script>
</body>
</html>
```

- [ ] **Step 3: Write `main.js`**

```js
// Setup page: server URL, Google sign-in (or a manual token), and per-machine
// Claude Code tokens. A setup link pre-fills it: options.html#url=<server>[&token=<t>].
import { DEFAULT_SERVER_URL, getServerConfig, saveServerConfig, normalizeServerUrl } from '../../lib/server-config.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const el = {
  url: $('server-url'), state: $('server-state'), serverErr: $('server-err'),
  signin: $('signin'), googleBtn: $('google-btn'), googleErr: $('google-err'),
  signedIn: $('signed-in'), who: $('who'), whoEmail: $('who-email'), avatar: $('avatar'), signout: $('signout'),
  advanced: $('advanced'), token: $('manual-token'), manualSave: $('manual-save'), manualErr: $('manual-err'),
  cc: $('cc'), ccNote: $('cc-token-note'), ccLabel: $('cc-label'), ccCreate: $('cc-create'), ccErr: $('cc-err'),
  ccResult: $('cc-result'), ccCommand: $('cc-command'), ccCopy: $('cc-copy'), ccList: $('cc-list'), status: $('status'),
};

function busy(btn, on, label) {
  btn.disabled = on;
  if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = `<span class="spin" aria-hidden="true"></span><span>${label}</span>`; }
  else if (btn.dataset.label) { btn.innerHTML = btn.dataset.label; delete btn.dataset.label; }
}
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('') || '?';
const fmtDate = (iso) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

function setServerState(kind, text) {
  el.state.innerHTML = `<span class="dot ${kind}"></span><span></span>`;
  el.state.lastChild.textContent = text;
}

// Persist the URL field (keeping the current token) before any server call.
async function commitUrl() {
  const raw = el.url.value.trim();
  if (raw && !normalizeServerUrl(raw)) { el.serverErr.textContent = 'Enter a full URL, e.g. http://my-vps.tailnet.ts.net:3846'; return false; }
  el.serverErr.textContent = '';
  const cur = await getServerConfig();
  const next = normalizeServerUrl(raw) || DEFAULT_SERVER_URL;
  if (next !== cur.url) await chrome.storage.local.set({ vibeServerUrl: next === DEFAULT_SERVER_URL ? '' : next });
  return true;
}

async function refreshStatus() {
  const r = await send({ action: 'checkMCPStatus' });
  const s = r?.status;
  if (s?.connected) setServerState('ok', 'Online');
  else { setServerState('err', 'Offline'); el.serverErr.textContent = s?.problem || ''; }
  return s;
}

async function render() {
  const auth = await send({ action: 'getAuthState' });
  const google = auth.mode === 'google';
  el.signin.hidden = google || !auth.googleAvailable;
  el.signedIn.hidden = !google;
  el.cc.hidden = !google;
  el.ccNote.hidden = auth.mode !== 'token' || !auth.googleAvailable;
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
    main.innerHTML = '<div></div><div class="meta"></div>';
    main.firstChild.textContent = t.kind === 'extension' ? 'Chrome extension' : t.label;
    main.lastChild.textContent = t.current ? `this browser · renews automatically` : `created ${fmtDate(t.created_at)}`;
    const actions = document.createElement('div');
    actions.className = 'actions';
    if (!t.current && t.kind === 'mcp') {
      const revoke = document.createElement('button');
      revoke.className = 'link danger'; revoke.type = 'button'; revoke.textContent = 'Revoke';
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
    const r = await send({ action: 'revokeMyToken', id: t.id });
    if (!r.ok) el.ccErr.textContent = 'Could not revoke — try again.';
    await renderTokens();
  });
  actions.append(q, yes, no);
  yes.focus();
}

el.googleBtn.addEventListener('click', async () => {
  el.googleErr.textContent = '';
  if (!(await commitUrl())) return;
  busy(el.googleBtn, true, 'Signing in…');
  const r = await send({ action: 'googleSignIn', interactive: true });
  busy(el.googleBtn, false);
  if (!r.ok) { el.googleErr.textContent = r.message || ''; return; }
  el.status.textContent = `Signed in as ${r.user.name}.`;
  await render();
  await refreshStatus();
});

el.signout.addEventListener('click', async () => {
  busy(el.signout, true, 'Signing out');
  await send({ action: 'googleSignOut' });
  busy(el.signout, false);
  el.ccResult.hidden = true;
  el.status.textContent = 'Signed out.';
  await render();
  await refreshStatus();
});

el.manualSave.addEventListener('click', async () => {
  el.manualErr.textContent = '';
  const raw = el.url.value.trim();
  if (raw && !normalizeServerUrl(raw)) { el.serverErr.textContent = 'Enter a full URL, e.g. http://my-vps.tailnet.ts.net:3846'; return; }
  busy(el.manualSave, true, 'Saving');
  await saveServerConfig({ url: raw, token: el.token.value });
  const s = await refreshStatus();
  busy(el.manualSave, false);
  if (!s?.connected) el.manualErr.textContent = s?.problem || 'Saved, but not connected.';
  else el.status.textContent = s.user ? `Connected as ${s.user.name}.` : 'Connected.';
  await render();
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
  el.ccCopy.focus();
  await renderTokens();
});

el.ccCopy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(el.ccCommand.textContent);
  el.ccCopy.textContent = 'Copied';
  setTimeout(() => { el.ccCopy.textContent = 'Copy'; }, 1500);
});

el.url.addEventListener('change', async () => { if (await commitUrl()) await refreshStatus(); });

// Setup link: pre-fill only; nothing is saved until the user acts.
function applySetupLink() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.has('url') && !p.has('token')) return;
  if (p.has('url')) el.url.value = p.get('url');
  if (p.get('token')) { el.token.value = p.get('token'); el.advanced.open = true; }
  history.replaceState(null, '', location.pathname);
  el.status.textContent = 'Your setup link filled in the server. Sign in to connect.';
}

async function init() {
  const cfg = await getServerConfig();
  el.url.value = cfg.url === DEFAULT_SERVER_URL ? '' : cfg.url;
  el.token.value = (await send({ action: 'getAuthState' })).mode === 'token' ? cfg.token : '';
  applySetupLink();
  window.addEventListener('hashchange', applySetupLink);
  await render();
  await refreshStatus();
}
init();
```

- [ ] **Step 4: Build with a test client id**

Run: `cd packages/extension && VIBE_GOOGLE_CLIENT_ID=test-client.apps.googleusercontent.com npx wxt build`
Expected: builds; `.output/chrome-mv3/options.html` references `style.css` output.

- [ ] **Step 5: End-to-end check** (scratchpad script, headless Chromium, real server + fake Google, `getAuthToken` stubbed in the service worker)

Create `$SCRATCH/e2e-google.cjs`:

```js
const { chromium } = require('/home/dev/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core');
const ext = '/home/dev/projects/vibe-annotations/packages/extension/.output/chrome-mv3';
const [profile, server, shotDir] = process.argv.slice(2);
(async () => {
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: require('os').homedir() + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], viewport: { width: 900, height: 900 },
  });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  // Stub Chrome's account sign-in: returns the fake-Google token in globalThis.__gtok.
  await sw.evaluate(() => {
    globalThis.__gtok = 'good'; globalThis.__calls = 0;
    chrome.identity.getAuthToken = async () => { globalThis.__calls++; return { token: globalThis.__gtok }; };
    chrome.identity.removeCachedAuthToken = async () => {};
  });
  const page = await ctx.newPage();
  const check = (c, m) => { if (!c) throw new Error('FAIL: ' + m); console.log('ok -', m); };

  await page.goto(`chrome-extension://${id}/options.html#url=${encodeURIComponent(server)}`);
  await page.waitForSelector('#signin:not([hidden])');
  await page.screenshot({ path: `${shotDir}/1-signed-out.png` });
  check((await page.inputValue('#server-url')) === server, 'setup link pre-fills the server');

  await sw.evaluate(() => { globalThis.__gtok = 'outsider'; });
  await page.click('#google-btn');
  await page.waitForFunction(() => document.querySelector('#google-err').textContent.length > 0);
  check((await page.textContent('#google-err')) === 'Sign in with your @maitriservices.com account.', 'wrong domain refused with spec copy');

  await sw.evaluate(() => { globalThis.__gtok = 'good'; });
  await page.click('#google-btn');
  await page.waitForSelector('#signed-in:not([hidden])');
  check((await page.textContent('#who')) === 'Jane Doe', 'signed in as Jane');
  await page.waitForSelector('#cc-list li');
  check((await page.textContent('#server-state')).includes('Online'), 'server online');

  await page.fill('#cc-label', 'laptop');
  await page.click('#cc-create');
  await page.waitForSelector('#cc-result:not([hidden])');
  const cmd = await page.textContent('#cc-command');
  check(/claude mcp add .*\/mcp --header "Authorization: Bearer vat_/.test(cmd), 'command shown with token');
  await page.screenshot({ path: `${shotDir}/2-signed-in.png`, fullPage: true });
  const mcpToken = cmd.match(/Bearer (vat_[^"]+)/)[1];
  check((await fetch(`${server}/api/whoami`, { headers: { Authorization: `Bearer ${mcpToken}` } })).ok, 'MCP token works');

  await page.click('#cc-list li:has-text("laptop") button:has-text("Revoke")');
  await page.click('#cc-list li button.danger:has-text("Revoke")');
  await page.waitForFunction(() => ![...document.querySelectorAll('#cc-list li')].some(li => li.textContent.includes('laptop')));
  check((await fetch(`${server}/api/whoami`, { headers: { Authorization: `Bearer ${mcpToken}` } })).status === 401, 'revoked token rejected');

  // Review Focus #4: server token revoked behind our back → one silent re-sign-in, then OK.
  const calls0 = await sw.evaluate(() => globalThis.__calls);
  await sw.evaluate(async () => { await chrome.storage.local.set({ vibeServerToken: 'vat_revoked' }); });
  const r = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'checkMCPStatus' }));
  check(r.status.connected, 'recovered after revoked extension token');
  check((await sw.evaluate(() => globalThis.__calls)) - calls0 <= 2, 'at most one silent re-sign-in');

  await page.click('#signout');
  await page.waitForSelector('#signin:not([hidden])');
  check(await page.isHidden('#cc'), 'signed out hides Claude Code');

  await page.setViewportSize({ width: 375, height: 800 });
  await page.screenshot({ path: `${shotDir}/3-mobile.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(!overflow, 'no horizontal scroll at 375px');
  await ctx.close();
})().catch(e => { console.error(e); process.exit(1); });
```

Run (from `packages/server`, fake Google + server in the background, then the script):

```bash
S=$SCRATCH; node -e "import('./test/fake-google.js').then(async m=>{const g=await m.startFakeGoogle();console.log(g.url);setInterval(()=>{},1e9)})" > $S/g.url &
sleep 1; G=$(cat $S/g.url)
HOME=$S/h2 VIBE_PORT=3898 VIBE_HOST=127.0.0.1 VIBE_GOOGLE_CLIENT_IDS=test-client.apps.googleusercontent.com \
  VIBE_GOOGLE_TOKENINFO_URL=$G/tokeninfo VIBE_GOOGLE_USERINFO_URL=$G/userinfo node lib/server.js > $S/srv3.log 2>&1 &
sleep 2; rm -rf $S/p3; node $S/e2e-google.cjs $S/p3 http://127.0.0.1:3898 $S
```

Expected: every line `ok - …`, exit 0. Then **look at the three screenshots** (Read tool) and fix any visual issue: spacing, alignment, truncation, contrast, button states. Kill both background processes afterwards and confirm ports 3898 and the fake-Google port are closed.

- [ ] **Step 6: Commit**

```bash
git add packages/extension/entrypoints/options/
git commit -m "feat(extension): setup page with Google sign-in and Claude Code token manager"
```

---

### Task 7: Docs and admin setup

**Files:**
- Modify: `packages/extension/PUBLISHING.md`
- Modify: `packages/server/lib/onboarding.js` (store-install branch)

- [ ] **Step 1: PUBLISHING.md** — add a section after "After it's published":

```markdown
## Google sign-in (one time)

1. https://console.cloud.google.com → new project (no billing needed).
2. **OAuth consent screen** → User type **Internal** → app name "Maitri Annotations" →
   scopes `openid`, `email`, `profile`.
3. **Credentials → Create OAuth client ID → Chrome Extension** → item id = the store id.
4. **Credentials → Create OAuth client ID → Web application** → Authorized redirect URI
   `https://<store id>.chromiumapp.org/` (used by the pop-up in Edge/Brave).
5. Server: add to `~/.vibe-annotations/server.env` and restart the service:
   `VIBE_GOOGLE_CLIENT_IDS=<chrome client id>,<web client id>` (optional `VIBE_GOOGLE_DOMAIN`).
6. Extension: build with both ids and upload a new version:
   `VIBE_GOOGLE_CLIENT_ID=<chrome client id> VIBE_GOOGLE_WEB_CLIENT_ID=<web client id> npx wxt zip`

Offboarding: `vibe-team remove <email>` removes the user and all their tokens immediately;
otherwise their extension access lapses within 7 days.
```

- [ ] **Step 2: Onboarding guide** — in `extensionSteps` (store branch) replace the "## 2. Connect the extension" body with:

```js
## 2. Connect the extension

Paste this into Chrome's address bar, then click **Sign in with Google** (use your work account):

\`\`\`
chrome-extension://${extensionId}/options.html#url=${encodeURIComponent(serverUrl)}
\`\`\`

Your Claude Code command is on the same page: under **Claude Code**, name the machine and click
**Create command**.
```

(The token-based guide stays for legacy users and for builds without Google sign-in; the store branch no longer embeds a token.)

- [ ] **Step 3: Verify guide renders**

Run: `cd packages/server && node -e "import('./lib/onboarding.js').then(m=>console.log(m.onboardingMarkdown({id:'x',name:'X',token:'t',serverUrl:'http://h:3846',extensionId:'abc'}).split('## 3')[0]))"`
Expected: section 2 shows the options.html link without a token.

- [ ] **Step 4: Run all server tests once more**

Run: `cd packages/server && pnpm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/extension/PUBLISHING.md packages/server/lib/onboarding.js
git commit -m "docs: Google sign-in admin setup and store onboarding via sign-in"
```
