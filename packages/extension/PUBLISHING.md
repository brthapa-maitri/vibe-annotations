# Publishing the team build to the Chrome Web Store

The extension ships as **Maitri Annotations**, a private team build of Vibe Annotations
(PolyForm Shield — internal distribution is fine; don't list it publicly as a competing product).

## Release

1. Bump `version` in `package.json` (the store rejects a repeated version).
2. `npx wxt zip` → upload `.output/vibe-annotations-extension-<version>-chrome.zip` in the
   [developer dashboard](https://chrome.google.com/webstore/devconsole).
3. After review (usually 1–3 days) installed copies update automatically.

## First-time listing

- **Visibility:** *Private* → your Google Workspace domain (only work accounts can install;
  admins can force-install it from Admin console → Devices → Chrome → Apps & extensions).
  *Unlisted* also works if the team isn't on one Workspace.
- **Privacy:** no analytics, no third-party requests. Annotations, screenshots and the
  server token are stored in `chrome.storage.local` and sent only to the server URL the
  user configures. Certify "does not sell/transfer user data".
- **Permission justifications:**
  - `storage` — keep annotations, settings and the server URL/token locally.
  - `activeTab` — capture a screenshot of the annotated element on the current tab.
  - `scripting` — inject the annotation toolbar into sites the user explicitly enables.
  - Host permissions (`localhost`, `127.0.0.1`, `*.local`, `*.test`, `*.localhost`, `file://`) —
    run the toolbar on local development pages.
  - Optional host permissions (`*://*/*`, `<all_urls>`) — requested at runtime only when the
    user enables a non-local site (e.g. a preview deployment) or screenshots.
- **Screenshots:** at least one 1280×800 of the toolbar on a page.

## After it's published

Put the store item id (the 32-letter id in the listing URL) into the team CLI's environment:

```bash
# ~/.local/bin/vibe-team
export VIBE_EXTENSION_ID=<store item id>
```

With it set, `vibe-team users add <id> --doc` writes a **token-free** guide and creates no user —
teammates create their own account by signing in with Google (set that up first, below). The guide
links the store listing and the setup link `chrome-extension://<id>/options.html#url=<server>`.
Teammates paste the link into the address bar (Chrome blocks clicking `chrome-extension://` links
from pages), click **Sign in with Google** with their work account, then create their Claude Code
command on the same page. The same page is the extension's Options page.

Legacy token users (`users rotate <id> --doc`, `users doc <id> --token …`) still get the old
token guide.

## Google sign-in (one time)

1. https://console.cloud.google.com → new project (no billing needed).
2. **OAuth consent screen** → User type **Internal** → app name "Maitri Annotations" →
   scopes `openid`, `email`, `profile`.
3. **Credentials → Create OAuth client ID → Chrome Extension** → item id = the store id.
4. **Credentials → Create OAuth client ID → Web application** → Authorized redirect URI
   `https://<store id>.chromiumapp.org/` (used by the account-picker pop-up: Edge/Brave, and Chrome when the profile isn't the work account).
5. Server: add to `~/.vibe-annotations/server.env` and restart the service:
   `VIBE_GOOGLE_CLIENT_IDS=<chrome client id>,<web client id>` (optional `VIBE_GOOGLE_DOMAIN`).
6. Extension: build with both ids and upload a new version:
   `VIBE_GOOGLE_CLIENT_ID=<chrome client id> VIBE_GOOGLE_WEB_CLIENT_ID=<web client id> npx wxt zip`
7. Before uploading, grep the zip for both ids (a missing one means sign-in silently breaks):

   ```bash
   zip=.output/vibe-annotations-extension-<version>-chrome.zip
   unzip -p "$zip" manifest.json | grep -o '<chrome client id>'
   unzip -p "$zip" background.js | grep -o '<web client id>'
   ```

   Each command must print the id.

Offboarding: `vibe-team remove <email>` removes the user and all their tokens immediately;
otherwise their extension access lapses within 7 days.
