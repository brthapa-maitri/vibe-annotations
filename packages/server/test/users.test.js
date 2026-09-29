import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync } from 'fs';
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

test('extension token authenticates and carries its kind', () => {
  const u = U.findOrCreateGoogleUser({ email: 'jane@maitriservices.com', name: 'Jane' });
  const first = U.issueToken(u.id, { kind: 'extension', label: 'Chrome extension' });
  assert.match(first.token, /^vat_/);
  assert.ok(first.expires_at);
  assert.deepEqual(U.userForToken(first.token), { id: u.id, name: 'Jane', tokenId: first.id, auth: 'google', kind: 'extension' });
  const mcp = U.issueToken(u.id, { kind: 'mcp', label: 'laptop' });
  assert.equal(U.userForToken(mcp.token).kind, 'mcp');
});

test('re-sign-in replaces only the given token; another browser stays signed in', () => {
  const u = U.findOrCreateGoogleUser({ email: 'jane@maitriservices.com', name: 'Jane' });
  const browserA = U.issueToken(u.id, { kind: 'extension', label: 'Chrome extension' });
  const browserB = U.issueToken(u.id, { kind: 'extension', label: 'Chrome extension' });
  assert.ok(U.userForToken(browserA.token), 'second browser must not sign out the first');
  const browserA2 = U.issueToken(u.id, { kind: 'extension', label: 'Chrome extension', replaceTokenId: browserA.id });
  assert.equal(U.userForToken(browserA.token), null);
  assert.equal(U.userForToken(browserA2.token).tokenId, browserA2.id);
  assert.equal(U.userForToken(browserB.token).tokenId, browserB.id);
});

test('replaceTokenId never removes an mcp token', () => {
  const u = U.findOrCreateGoogleUser({ email: 'jane@maitriservices.com', name: 'Jane' });
  const mcp = U.issueToken(u.id, { kind: 'mcp', label: 'laptop' });
  U.issueToken(u.id, { kind: 'extension', label: 'Chrome extension', replaceTokenId: mcp.id });
  assert.ok(U.userForToken(mcp.token));
});

test('replaceTokenId cannot revoke another user\'s token', () => {
  const jane = U.findOrCreateGoogleUser({ email: 'jane@maitriservices.com', name: 'Jane' });
  const bob = U.findOrCreateGoogleUser({ email: 'bob@maitriservices.com', name: 'Bob' });
  const bobs = U.issueToken(bob.id, { kind: 'extension', label: 'Chrome extension' });
  U.issueToken(jane.id, { kind: 'extension', label: 'Chrome extension', replaceTokenId: bobs.id });
  assert.ok(U.userForToken(bobs.token));
});

test('at most 5 extension tokens per user; the oldest is dropped', () => {
  const u = U.findOrCreateGoogleUser({ email: 'jane@maitriservices.com', name: 'Jane' });
  const mcp = U.issueToken(u.id, { kind: 'mcp', label: 'laptop' });
  const ext = [];
  for (let i = 0; i < 6; i++) ext.push(U.issueToken(u.id, { kind: 'extension', label: 'Chrome extension' }));
  assert.equal(U.userForToken(ext[0].token), null);
  for (const t of ext.slice(1)) assert.ok(U.userForToken(t.token));
  assert.equal(U.listTokens(u.id).filter(t => t.kind === 'extension').length, 5);
  assert.ok(U.userForToken(mcp.token));
});

test('users.json is written atomically with mode 0600', () => {
  U.findOrCreateGoogleUser({ email: 'jane@maitriservices.com', name: 'Jane' });
  assert.equal(statSync(process.env.VIBE_USERS_FILE).mode & 0o777, 0o600);
  assert.equal(existsSync(process.env.VIBE_USERS_FILE + '.tmp'), false);
  assert.equal(U.loadUsers().length, 1);
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
  assert.deepEqual(U.userForToken(token), { id: 'bhesh', name: 'Bhesh', tokenId: null, auth: 'legacy', kind: 'legacy' });
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
