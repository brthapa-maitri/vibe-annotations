// Personal setup guide for a team member, with their token filled in.
// Contains a secret: written 0600 and meant to be sent privately.

import { writeFileSync, mkdirSync, chmodSync } from 'fs';
import path from 'path';

export const ONBOARDING_DIR = path.join(process.env.HOME || process.env.USERPROFILE, '.vibe-annotations', 'onboarding');

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

## 1. Install the extension

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

## 3. Connect Claude Code

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

## 4. Use it

1. Click **Annotate**, click an element, describe the change, **Save**.
2. In Claude Code: *"implement my vibe annotations"* — or hands-free:
   *"watch my annotations on http://localhost:3000/\\*"* (use your frontend's URL).
3. Claude implements each one and deletes it when done.

Your Claude only sees **your** annotations. Ask for *"the team's annotations"* to see everyone's
(each shows who made it); you can only change or delete your own.

## Troubleshooting

| Settings says | Fix |
|---|---|
| "The server rejected this token." | Token mistyped or rotated — paste it again or ask for a new one. |
| "Saved, but the server is not reachable." | Connect to Tailscale; check the URL. |
| Toolbar doesn't appear on a page | Click the extension icon on that page and allow the site. |
`;
}

export function writeOnboardingDoc(info, outPath) {
  const file = outPath || path.join(ONBOARDING_DIR, `${info.id}.md`);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, onboardingMarkdown(info), { mode: 0o600 });
  chmodSync(file, 0o600); // mode above only applies when the file is new
  return file;
}
