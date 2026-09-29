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
