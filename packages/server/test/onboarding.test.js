import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { onboardingMarkdown, storeOnboardingMarkdown } from '../lib/onboarding.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverUrl = 'http://vps.tail.ts.net:3846';

test('store guide is token-free and walks through Google sign-in', () => {
  const md = storeOnboardingMarkdown({ name: 'Jo', serverUrl, extensionId: 'abcdefghijklmnop' });
  assert.doesNotMatch(md, /vat_|Bearer vat|Token \|/);
  assert.match(md, /chromewebstore\.google\.com\/detail\/abcdefghijklmnop/);
  assert.match(md, new RegExp(`chrome-extension://abcdefghijklmnop/options\\.html#url=${encodeURIComponent(serverUrl).replace(/[.%]/g, '\\$&')}`));
  assert.match(md, /Sign in with Google/);
  assert.match(md, /Create command/);
  assert.match(md, /--scope local/);
  assert.match(md, /## Troubleshooting/);
});

test('a guide with a token uses the build-from-source flow even when an extension id is set', () => {
  const md = onboardingMarkdown({ id: 'bhesh', name: 'Bhesh', token: 'vat_secret', serverUrl, extensionId: 'abcdefghijklmnop' });
  assert.match(md, /vat_secret/);
  assert.match(md, /Load unpacked/);
  assert.doesNotMatch(md, /chromewebstore/);
});

test('users add --doc with VIBE_EXTENSION_ID creates no user and writes a token-free guide', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'vibe-cli-'));
  const usersFile = path.join(home, 'users.json');
  const out = path.join(home, 'jo.md');
  const r = spawnSync(process.execPath, [path.join(here, '../bin/cli.js'), 'users', 'add', 'jo', '--name', 'Jo', '--doc', out, '--server-url', serverUrl], {
    env: { ...process.env, HOME: home, VIBE_USERS_FILE: usersFile, VIBE_EXTENSION_ID: 'abcdefghijklmnop' }, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No user was created/);
  assert.equal(existsSync(usersFile), false);
  const md = readFileSync(out, 'utf8');
  assert.doesNotMatch(md, /vat_/);
  assert.match(md, /Sign in with Google/);
});
