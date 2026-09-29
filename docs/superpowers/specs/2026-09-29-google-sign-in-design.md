# Google sign-in + self-serve Claude Code tokens — design

Date: 2026-09-29 · Branch: `feat/team-distribution` (fork `brthapa-maitri/vibe-annotations`)

## Goal

A teammate installs the extension from the (private) Chrome Web Store, clicks **Sign in with
Google**, and is connected — no token to receive or paste. From the same page they create a
Claude Code MCP command for each machine they use. Only `@maitriservices.com` accounts get in.

## Decisions (agreed)

| Topic | Decision |
|---|---|
| Who gets in | Any verified `@maitriservices.com` Google account; auto-provisioned on first sign-in. |
| Existing token users (bhesh, aasutosh, gaurav) | Start fresh: untouched, keep working, not linked to Google users. |
| MCP tokens | One labelled token per machine; list and revoke individually. |
| Auth model | **Exchange**: Google is used only at sign-in; the server then issues its normal `vat_…` tokens. |
| Self-serve page | Lives in the extension's setup (Options) page, not on the server — no web OAuth redirect/HTTPS needed. |

## Server (`packages/server`)

### Data model — `users.json`

Legacy users are unchanged: `{ id, name, token_sha256, created_at }`.

Google users:

```json
{
  "id": "jane@maitriservices.com",
  "name": "Jane Doe",
  "email": "jane@maitriservices.com",
  "auth": "google",
  "created_at": "…",
  "tokens": [
    { "id": "t_ab12cd", "label": "Chrome extension", "kind": "extension",
      "sha256": "…", "created_at": "…", "expires_at": "…" },
    { "id": "t_ef34gh", "label": "laptop", "kind": "mcp", "sha256": "…", "created_at": "…" }
  ]
}
```

- User id = the lower-cased email. The `USER_ID` rule is widened to allow one `@` for Google users only.
- `kind: "extension"` tokens expire after 7 days. On each new sign-in, older extension tokens are
  removed, so there is at most one live extension token per user. `kind: "mcp"` tokens never expire.
- At most 20 MCP tokens per user (the create call returns 409 beyond that).

### Token lookup (`lib/users.js`)

`userForToken(token)` also scans each user's `tokens[]`, skips expired entries, and uses
timing-safe comparison as today. It returns `{ id, name, tokenId }` so the self-serve endpoints know
which token made the call.

### New module `lib/google-auth.js`

`verifyGoogleAccessToken(accessToken, { clientIds, domain, fetchImpl })`:

1. `GET https://oauth2.googleapis.com/tokeninfo?access_token=…` → require `aud` (or `azp`) ∈
   `clientIds`, `expires_in > 0`.
2. `GET https://openidconnect.googleapis.com/v1/userinfo` (Bearer) → require
   `email_verified === true`, `hd === domain`, and the email to end in `@domain`.
3. Return `{ email, name }`, or throw a typed error: `invalid_token`, `wrong_client`, `wrong_domain`,
   `unverified_email`, or `google_unreachable`.

`fetchImpl` can be injected for tests. Each call uses a 5-second timeout.

### Configuration (`~/.vibe-annotations/server.env`)

- `VIBE_GOOGLE_CLIENT_IDS` — comma-separated OAuth client ids (Chrome-extension client +
  web client for the pop-up fallback). Google sign-in is **off** when unset; `/health` reports
  `google_sign_in: true|false`.
- `VIBE_GOOGLE_DOMAIN` — default `maitriservices.com`.

### Endpoints

| Method + path | Auth | Behaviour |
|---|---|---|
| `POST /api/auth/google` `{access_token}` | none (public, like `/health`) | Verify → find-or-create user → issue extension token → `200 {token, expires_at, user:{id,name}}`. Errors: `400` missing token, `401 {error: invalid_token|wrong_client|unverified_email}`, `403 {error: wrong_domain}`, `502 google_unreachable`, `404` when sign-in is off. |
| `GET /api/me/tokens` | bearer | `{tokens:[{id,label,kind,created_at,expires_at,current}]}` — no hashes. Legacy users get `[]`. |
| `POST /api/me/tokens` `{label}` | bearer, Google user | Create an MCP token; label 1–40 chars, trimmed. `201 {id, label, token}` (the token is shown once). |
| `DELETE /api/me/tokens/:id` | bearer, Google user | Revoke one of your own tokens, including the calling one (used by Sign out) → `204`; unknown or someone else's id → `404`. |

`POST /api/auth/google` is rate-limited in memory to 10 requests per minute per IP. Because
`authenticate` currently applies to all of `/api`, this route is registered before that middleware
so it stays public.

### CLI

`vibe-team list` shows Google users with their token count. `vibe-team remove <email>` removes a
user together with all their tokens; this is how you offboard someone.

## Extension (`packages/extension`)

### Manifest (`wxt.config.js`)

- Add the `identity` permission.
- Add `oauth2: { client_id: <Chrome-extension client id>, scopes: ["openid", "email", "profile"] }`.
- Read the client ids from build-time env: `VIBE_GOOGLE_CLIENT_ID` (Chrome extension) and
  `VIBE_GOOGLE_WEB_CLIENT_ID` (pop-up). If they are unset, leave out `oauth2`/`identity` and hide the
  sign-in UI, so the build still works before GCP is set up.

### `lib/google-sign-in.js` (background only)

- `getGoogleAccessToken({ interactive })`: use `chrome.identity.getAuthToken` when available
  (Chrome). Otherwise use `chrome.identity.launchWebAuthFlow` with the web client (implicit
  `response_type=token`, redirect `chrome.identity.getRedirectURL()`), caching the token until it
  expires.
- `signInWithGoogle({ interactive })`: get an access token, `POST /api/auth/google`, then save the
  server token via `saveServerConfig` together with `vibeAuthMode: "google"` and `vibeTokenExpiresAt`.
  If the server returns 401 `invalid_token`, call `removeCachedAuthToken`, retry once, then fail.

### Refresh

When `vibeAuthMode === "google"`, the background:
- refreshes silently (`interactive: false`) if the token expires within 24h. It checks on startup
  and on a `chrome.alarms` alarm every 6h, which adds the `alarms` permission;
- refreshes silently once when `checkConnection` gets a 401. If that fails, the status problem
  becomes "Signed out — open the extension's setup page and sign in with Google."

### Setup page (`entrypoints/options/`)

- **Signed out:** a "Sign in with Google" button (interactive), with the server URL field above it
  (pre-filled from the setup link or saved config). Manual URL + token entry moves under an
  "Advanced" section.
- **Signed in:** "Signed in as Jane (jane@…)" with a Sign out button. Sign out clears the local token
  and calls `DELETE` on the current extension token.
- **Claude Code section** (only when signed in as a Google user):
  - A label field (default: "laptop") and a **Create command** button. The result shows once:
    `claude mcp add --scope user --transport http vibe-annotations <server>/mcp --header "Authorization: Bearer <token>"`,
    with a copy button and a note to use `--scope local` inside your worktree on the shared dev server.
  - A token list (label, created date, Revoke). The extension's own token is shown as "this browser"
    and can't be revoked from here.

### Messages (background)

`googleSignIn {interactive}`, `googleSignOut`, `listMyTokens`, `createMyToken {label}`,
`revokeMyToken {id}`, `getAuthState`. They go through the background because it owns the identity
API and the server token.

## Error messages (shown to the user)

| Condition | Text |
|---|---|
| wrong_domain | "Sign in with your @maitriservices.com account." |
| unverified_email / wrong_client | "Google sign-in isn't set up correctly for this server — tell the admin." |
| google_unreachable | "Couldn't reach Google — try again." |
| sign-in off (404) | "This server doesn't have Google sign-in enabled — use a token (Advanced)." |
| user closed the pop-up | no message; the button resets |

## Security notes

- Google access tokens are never stored by the server. They're only checked, and we require our
  own client id in `aud`/`azp`, so a token issued to another app can't be replayed here.
- Server tokens are stored only as SHA-256 hashes. An MCP token is shown once.
- The domain check uses Google's `hd` claim *and* the email suffix.
- Leavers: extension access ends within 7 days even if nobody acts. Immediate removal is
  `vibe-team remove <email>`, which also revokes MCP tokens.

## Testing

- **Server:** `node:test` (no new dependencies), `pnpm --filter vibe-annotations-server test`.
  - `google-auth.test.js`: all verification outcomes, using a fake `fetchImpl`.
  - `users.test.js`: create/find Google users, token issue/lookup/expiry/revoke, the 20-token cap, and
    legacy users unaffected (temp `VIBE_USERS_FILE`).
  - `auth-endpoints.test.js`: start the server on a random port with a temp HOME and a stubbed
    verifier, then exercise all endpoints over HTTP.
- **Extension:** headless-Chromium run of the setup page with `googleSignIn` stubbed (Google's
  consent screen can't run headless): signed-out → signed-in → create/revoke an MCP token.
- **Manual (after GCP setup):** real sign-in in Chrome and in a non-Chrome Chromium browser;
  wrong-domain account refused.

## Out of scope

- Linking legacy users to Google accounts.
- A standalone web sign-in page on the server.
- MCP OAuth (Claude Code's built-in `/mcp` login).

## Admin setup (one time, documented in PUBLISHING.md)

1. GCP project → OAuth consent screen **Internal**, scopes `openid email profile`.
2. OAuth client **Chrome Extension** with the store item id.
3. OAuth client **Web application** with the redirect URI `https://<item-id>.chromiumapp.org/`.
4. Put both client ids in `server.env` (`VIBE_GOOGLE_CLIENT_IDS`) and in the extension build env,
   then rebuild and upload.
