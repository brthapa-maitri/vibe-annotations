export function googleConfig() {
  const clientIds = (process.env.VIBE_GOOGLE_CLIENT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  return { enabled: clientIds.length > 0, clientIds, domain: (process.env.VIBE_GOOGLE_DOMAIN || 'maitriservices.com').toLowerCase() };
}
