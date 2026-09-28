# Vibe Annotations

[![Chrome Web Store](https://img.shields.io/badge/Chrome_Web_Store-6K+_users-green?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/gkofobaeeepjopdpahbicefmljcmpeof) [![Server Package](https://img.shields.io/badge/Server-NPM-blue)](https://www.npmjs.com/package/vibe-annotations-server) [![License: PolyForm Shield](https://img.shields.io/badge/License-PolyForm%20Shield-blue)](https://polyformproject.org/licenses/shield/1.0.0)

Visual feedback tool for web development. Annotate elements on your pages, make design tweaks, and share with AI coding agents or teammates.

https://github.com/user-attachments/assets/6946733e-eea6-4d38-8386-c493f90d36f4

For more features explanations (like collaboration via file sharing, AI-assisted annotations, watch mode...) please read the docs.

## Get started

**1.** Install the [browser extension](https://chromewebstore.google.com/detail/gkofobaeeepjopdpahbicefmljcmpeof)

**2.** Run the setup wizard

```bash
npx vibe-annotations-server init
```

One interactive command installs the global server, starts it in the background, and configures your AI coding agent (Claude Code, Cursor, Windsurf, Codex, OpenClaw, VS Code). Prefer manual? See [Installation](https://vibe-annotations.com/docs/installation).

**3.** Open a localhost page, click **Annotate**. You can annotate multiple pages on your web app. Then:

A (recommended) - [Use the MCP](https://vibe-annotations.com/docs/mcp-setup) to implement your Annotations

B - Copy to your clipboard: **View all** > **Copy** and send to your AI coding agent.

## Remote dev server (VPS, Tailscale, SSH box)

If your frontend, the server and your AI agent all run on a remote machine, run the server there and point the extension at it:

```bash
# on the remote machine
VIBE_TOKEN=some-long-secret \
VIBE_ALLOWED_ORIGINS=https://my-vps.tailnet.ts.net \
vibe-annotations-server start
claude mcp add --transport http vibe-annotations http://127.0.0.1:3846/mcp \
  --header "Authorization: Bearer some-long-secret"
```

Then in the extension: **Settings → Server**, enter `http://my-vps.tailnet.ts.net:3846` and the token, click **Save**. For a non-localhost frontend URL, click the extension icon on that page once to allow the site.

| Env var | Default | Purpose |
|---|---|---|
| `VIBE_PORT` | `3846` | Port to listen on |
| `VIBE_HOST` | `0.0.0.0` | Address to bind (e.g. your Tailscale IP) |
| `VIBE_ALLOWED_ORIGINS` | — | Extra page origins allowed by CORS, comma-separated |
| `VIBE_TOKEN` | — | When set, the API and MCP endpoints require `Authorization: Bearer <token>` |

Set `VIBE_TOKEN` whenever the server is reachable from other machines.

### Team mode (one server, many people)

Give each person their own token instead of sharing one:

```bash
vibe-annotations-server users add alice --name "Alice Smith"   # prints Alice's token once
vibe-annotations-server users list | rotate <id> | remove <id>
```

Adding the first user switches the server to team mode (live, no restart; `VIBE_TOKEN` is then ignored). Users are stored in `~/.vibe-annotations/users.json` (token hashes only, override with `VIBE_USERS_FILE`).

- Each person puts **their** token in the extension (Settings → Server shows "Connected as …") and in their agent's MCP config (`--header "Authorization: Bearer <token>"`).
- Every annotation is owned by whoever made it (`created_by`). Extensions only see and sync their owner's annotations, so teammates never overwrite each other.
- Agents act as their human: `read_annotations` / `watch_annotations` return your own annotations by default, `scope: "team"` shows everyone's, and update/delete only work on your own.
- Removing a user revokes their token immediately; their annotations stay.

## Documentation

Full docs at [**vibe-annotations.com/docs**](https://vibe-annotations.com/docs) — including [installation](https://vibe-annotations.com/docs/installation), [MCP setup](https://vibe-annotations.com/docs/mcp-setup), [workflows](https://vibe-annotations.com/docs/workflows), [architecture](https://vibe-annotations.com/docs/architecture), and [troubleshooting](https://vibe-annotations.com/docs/troubleshooting).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). PRs welcome.

## License

[PolyForm Shield 1.0.0](https://polyformproject.org/licenses/shield/1.0.0) — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
