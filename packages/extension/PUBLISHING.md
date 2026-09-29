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

Put the store item id (the 32-letter id in the listing URL) into the team CLI's environment
so personal setup guides include the store link and a one-click setup link:

```bash
# ~/.local/bin/vibe-team
export VIBE_EXTENSION_ID=<store item id>
```

The setup link is `chrome-extension://<id>/options.html#url=<server>&token=<token>`. Teammates
paste it into the address bar (Chrome blocks clicking `chrome-extension://` links from pages),
check the URL, and click **Connect**. The same page is the extension's Options page.
