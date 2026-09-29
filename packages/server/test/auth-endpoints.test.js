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

// Must stay last: it exhausts the per-IP sign-in budget.
test('rate limit on sign-in', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await post('/api/auth/google', { access_token: 'garbage' });
  assert.equal(last.status, 429);
});
