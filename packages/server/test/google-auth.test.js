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
test('rejects a company email without a Workspace hd claim', async () => {
  await assert.rejects(verifyGoogleAccessToken('no-hd', cfg), code('wrong_domain'));
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
