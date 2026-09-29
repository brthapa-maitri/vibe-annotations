import { defineConfig } from 'wxt';

// Google sign-in is compiled in only when the OAuth client ids are provided:
//   VIBE_GOOGLE_CLIENT_ID      — "Chrome Extension" client (chrome.identity.getAuthToken)
//   VIBE_GOOGLE_WEB_CLIENT_ID  — "Web application" client (pop-up fallback for non-Chrome browsers)
const GOOGLE_CLIENT_ID = process.env.VIBE_GOOGLE_CLIENT_ID || '';
const GOOGLE_WEB_CLIENT_ID = process.env.VIBE_GOOGLE_WEB_CLIENT_ID || '';

// Keep the same manifest shape the Chrome Web Store listing expects. WXT generates
// the actual manifest.json from this config plus discovered entrypoints.
export default defineConfig({
  srcDir: '.',
  outDir: '.output',
  // Avoid clashing with the Next.js website dev server on :3000.
  dev: {
    server: { port: 3010 },
  },
  webExt: {
    startUrls: ['http://localhost:3000'],
    keepProfileChanges: true,
  },
  vite: () => ({
    define: {
      'import.meta.env.WXT_GOOGLE_CLIENT_ID': JSON.stringify(GOOGLE_CLIENT_ID),
      'import.meta.env.WXT_GOOGLE_WEB_CLIENT_ID': JSON.stringify(GOOGLE_WEB_CLIENT_ID),
    },
  }),
  manifest: {
    // Team build — a fork of Vibe Annotations (Raphael Regnier / Spellbind Creative
    // Studio, PolyForm Shield) published privately for Maitri Services. Kept distinct
    // from the upstream public listing's name and author.
    name: 'Maitri Annotations',
    description:
      'Team build of Vibe Annotations: annotate your dev app and send the feedback to AI coding agents via MCP.',
    author: 'Maitri Services',
    permissions: ['activeTab', 'storage', 'scripting', 'alarms', ...(GOOGLE_CLIENT_ID ? ['identity'] : [])],
    ...(GOOGLE_CLIENT_ID ? { oauth2: { client_id: GOOGLE_CLIENT_ID, scopes: ['openid', 'email', 'profile'] } } : {}),
    // '*://*/*' covers the "enable on all sites" annotation flow (http/https).
    // '<all_urls>' is additionally required by chrome.tabs.captureVisibleTab for
    // screenshots — it is NOT satisfied by '*://*/*' (which omits file://, etc.).
    optional_host_permissions: ['*://*/*', '<all_urls>'],
    host_permissions: [
      'http://localhost/*',
      'https://localhost/*',
      'http://127.0.0.1/*',
      'https://127.0.0.1/*',
      'http://0.0.0.0/*',
      'https://0.0.0.0/*',
      'http://*.local/*',
      'https://*.local/*',
      'http://*.test/*',
      'https://*.test/*',
      'http://*.localhost/*',
      'https://*.localhost/*',
      'file:///*',
    ],
    icons: {
      16: 'assets/icons/icon16.png',
      32: 'assets/icons/icon32.png',
      48: 'assets/icons/icon48.png',
      128: 'assets/icons/icon128.png',
    },
    action: {
      default_title: 'Vibe Annotations',
    },
    commands: {
      'toggle-annotate': {
        suggested_key: {
          default: 'Ctrl+Shift+Comma',
          mac: 'Command+Shift+Comma',
        },
        description: 'Toggle annotation mode',
      },
    },
    web_accessible_resources: [
      {
        resources: ['assets/fonts/InterVariable.woff2', 'assets/icons/icon-hq.png'],
        matches: ['<all_urls>'],
      },
    ],
  },
});
