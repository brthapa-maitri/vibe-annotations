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
