// Team mode: per-user tokens so one hosted server can serve a whole team, with
// every annotation owned by the person who made it and every agent acting as
// its human. Users live in a JSON file (only token hashes are stored); the file
// is re-read when it changes, so adding/removing people needs no restart.

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import path from 'path';

export const USERS_FILE = process.env.VIBE_USERS_FILE
  || path.join(process.env.HOME || process.env.USERPROFILE, '.vibe-annotations', 'users.json');

const USER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

function hashesMatch(a, b) {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

// --- File access (cached by mtime) ---

let cache = { mtimeMs: -1, users: [] };

export function loadUsers() {
  if (!existsSync(USERS_FILE)) { cache = { mtimeMs: -1, users: [] }; return []; }
  const { mtimeMs } = statSync(USERS_FILE);
  if (mtimeMs !== cache.mtimeMs) {
    try {
      const parsed = JSON.parse(readFileSync(USERS_FILE, 'utf8'));
      cache = { mtimeMs, users: Array.isArray(parsed.users) ? parsed.users : [] };
    } catch (err) {
      console.error(`Could not read ${USERS_FILE}: ${err.message} — keeping previous user list`);
      cache.mtimeMs = mtimeMs;
    }
  }
  return cache.users;
}

function writeUsers(users) {
  mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2) + '\n', { mode: 0o600 });
}

export function teamModeEnabled() {
  return loadUsers().length > 0;
}

// Token → { id, name } or null.
export function userForToken(token) {
  if (!token) return null;
  const h = sha256(token);
  const u = loadUsers().find(u => u.token_sha256 && hashesMatch(u.token_sha256, h));
  return u ? { id: u.id, name: u.name || u.id } : null;
}

// --- Management (used by the CLI) ---

function newToken() {
  return 'vat_' + randomBytes(24).toString('base64url');
}

export function addUser(id, name) {
  if (!USER_ID.test(id)) throw new Error('User id must be letters, digits, ".", "_" or "-" (max 64).');
  const users = loadUsers();
  if (users.some(u => u.id === id)) throw new Error(`User "${id}" already exists — use "users rotate ${id}" for a new token.`);
  const token = newToken();
  writeUsers([...users, { id, name: name || id, token_sha256: sha256(token), created_at: new Date().toISOString() }]);
  return token;
}

export function rotateUser(id) {
  const users = loadUsers();
  const u = users.find(u => u.id === id);
  if (!u) throw new Error(`No user "${id}".`);
  const token = newToken();
  writeUsers(users.map(x => x.id === id ? { ...x, token_sha256: sha256(token), rotated_at: new Date().toISOString() } : x));
  return token;
}

export function removeUser(id) {
  const users = loadUsers();
  if (!users.some(u => u.id === id)) throw new Error(`No user "${id}".`);
  writeUsers(users.filter(u => u.id !== id));
}

// --- Per-request identity ---
// { user: {id,name} | null, scope: 'own' | 'team' }. No context (startup jobs,
// single-user mode) means "everything", which is today's behaviour.

export const requestContext = new AsyncLocalStorage();

export function currentUser() {
  return requestContext.getStore()?.user || null;
}

export function currentScope() {
  return requestContext.getStore()?.scope || 'own';
}

export const ownerId = (a) => a?.created_by?.id || null;
