// Setup guides for team members.
// - Store guide (VIBE_EXTENSION_ID set): no token — teammates install from the
//   Chrome Web Store and sign in with Google, which creates their user.
// - Token guide (legacy users): their token filled in, so it is a secret —
//   written 0600 and meant to be sent privately.

import { writeFileSync, mkdirSync, chmodSync } from 'fs';
import path from 'path';

export const ONBOARDING_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.vibe-annotations', 'onboarding');

const USE_IT = `## 4. Use it

1. Click **Annotate**, click an element, describe the change, **Save**.
2. In Claude Code: *"implement my vibe annotations"* — or hands-free:
   *"watch my annotations on http://localhost:3000/\\*"* (use your frontend's URL).
3. Claude implements each one and deletes it when done.

Your Claude only sees **your** annotations. Ask for *"the team's annotations"* to see everyone's
(each shows who made it); you can only change or delete your own.
`;

// Guide for a token user (legacy): build the extension from source and paste
// the token. Used whenever a token is issued, even once the store build exists —
// a store guide never carries a token (see storeOnboardingMarkdown).
function extensionSteps({ name, token, serverUrl }) {
  return `## 1. Install the extension

Needs Node.js 20+ and Git.

\`\`\`bash
git clone -b feat/configurable-server-url https://github.com/brthapa-maitri/vibe-annotations
cd vibe-annotations
npx -y pnpm@9 install
cd packages/extension
npx wxt build
\`\`\`

In Chrome: open \`chrome://extensions\` → turn on **Developer mode** → **Load unpacked** →
choose \`packages/extension/.output/chrome-mv3\`. Disable the official Vibe Annotations
extension if you have it.

## 2. Connect the extension

1. Open the frontend you work on. If it isn't a \`localhost\` URL, click the extension icon once
   and allow the site.
2. Open the toolbar → **Settings** → **Server**:
   - URL: \`${serverUrl}\`
   - Token: \`${token}\`
3. Click **Save**. It should say **"Connected as ${name}."**

`;
}

export function onboardingMarkdown({ id, name, token, serverUrl }) {
  const mcpUrl = `${serverUrl}/mcp`;
  return `# Vibe Annotations — setup for ${name}

> **This file contains your personal token. Don't share it or commit it.**
> Anyone with it can read and change your annotations as you. If it leaks, ask for a new one.

| | |
|---|---|
| User | \`${id}\` (${name}) |
| Server | \`${serverUrl}\` |
| Token | \`${token}\` |

You need to be connected to the team **Tailscale** network — the server is only reachable there.

${extensionSteps({ name, token, serverUrl })}## 3. Connect Claude Code

**Claude Code on your own machine:**

\`\`\`bash
claude mcp add --scope user --transport http vibe-annotations ${mcpUrl} --header "Authorization: Bearer ${token}"
\`\`\`

**Claude Code on the shared dev server (SSH as the shared user):** the user-level entry there
belongs to someone else, so add yours from inside **your own worktree** and always start Claude
from that folder:

\`\`\`bash
cd ~/projects/worktrees/<your-worktree>
claude mcp add --scope local --transport http vibe-annotations ${mcpUrl} --header "Authorization: Bearer ${token}"
\`\`\`

Restart Claude Code, then check with \`claude mcp list\` → \`vibe-annotations … ✔ Connected\`.

${USE_IT}
## Troubleshooting

| Settings says | Fix |
|---|---|
| "… rejected the token" | Token mistyped or rotated — use your setup link again or ask for a new one. |
| "Can't reach … is Tailscale/VPN connected" | Connect to Tailscale; check the URL. |
| "Extension was updated or reloaded" | Refresh the page. |
| Toolbar doesn't appear on a page | Click the extension icon on that page and allow the site. |
`;
}

export function storeOnboardingMarkdown({ name, serverUrl, extensionId }) {
  const setupLink = `chrome-extension://${extensionId}/options.html#url=${encodeURIComponent(serverUrl)}`;
  return `# Vibe Annotations — setup${name ? ` for ${name}` : ''}

You need to be connected to the team **Tailscale** network — the server (\`${serverUrl}\`) is only
reachable there. You sign in with your **@maitriservices.com** Google account; there is no token to
copy from this guide.

## 1. Install the extension

Install **Maitri Annotations** from the Chrome Web Store. The listing is only visible to the team,
so open the link while signed in to Chrome with your work account:

https://chromewebstore.google.com/detail/${extensionId}

If you have the public Vibe Annotations extension or an unpacked build, disable it.

## 2. Sign in

Paste this into Chrome's address bar:

\`\`\`
${setupLink}
\`\`\`

The server URL is filled in for you. Click **Sign in with Google** and pick your **work** account.
The page then shows **Signed in as** your name.

## 3. Connect Claude Code

On the same page, under **Claude Code**:

1. Name the machine Claude Code runs on (e.g. \`laptop\` or \`dev server\`).
2. Click **Create command** and copy it — it is shown once.
3. Run it in a terminal on that machine, then restart Claude Code and check with
   \`claude mcp list\` → \`vibe-annotations … ✔ Connected\`.

**Claude Code on the shared dev server (SSH as the shared user):** the user-level entry there
belongs to someone else. Change \`--scope user\` to \`--scope local\` in the command and run it from
inside **your own worktree**; always start Claude from that folder:

\`\`\`bash
cd ~/projects/worktrees/<your-worktree>
claude mcp add --scope local --transport http vibe-annotations '${serverUrl}/mcp' --header "Authorization: Bearer <token from the setup page>"
\`\`\`

Each machine gets its own command; you can revoke any of them from the same page.

${USE_IT}
## Troubleshooting

| Setup page says | Fix |
|---|---|
| "Sign in with your @maitriservices.com account" | You picked a personal Google account — sign in again with your work account. |
| "Your session expired — sign in again." | Click **Sign in again**. |
| "Can't reach … is Tailscale/VPN connected" | Connect to Tailscale; check the URL. |
| \`claude mcp list\` shows the server failing | The token was revoked or mistyped — create a new command on the setup page. |
| Toolbar doesn't appear on a page | Click the extension icon on that page and allow the site. |
`;
}

export function writeOnboardingDoc(info, outPath) {
  const file = outPath || path.join(ONBOARDING_DIR, `${info.id}.md`);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const md = info.token ? onboardingMarkdown(info) : storeOnboardingMarkdown(info);
  writeFileSync(file, md, { mode: 0o600 });
  chmodSync(file, 0o600); // mode above only applies when the file is new
  return file;
}
