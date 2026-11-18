/**
 * Preserve older cross-origin deployments while preferring first-party cookies
 * behind the documented same-origin /api reverse proxy (needed for iOS Safari).
 * Browsers can reject third-party cookies even when SameSite=None; only a
 * same-origin proxy fully avoids that restriction.
 */
export function cookieSameSite(req) {
  const forced = String(process.env.AUTH_COOKIE_SAME_SITE || '').trim().toLowerCase();
  if (['lax', 'strict', 'none'].includes(forced)) return forced;
  if (process.env.NODE_ENV !== 'production') return 'lax';
  const origin = req?.get?.('origin') || req?.headers?.origin;
  if (!origin) return 'lax';
  try {
    const apiHost = req?.get?.('host') || req?.headers?.host;
    const apiProtocol = req.protocol || 'https';
    return new URL(origin).origin === `${apiProtocol}://${apiHost}` ? 'lax' : 'none';
  } catch { return 'lax'; }
}

export function authCookieOptions(req, maxAge) {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: cookieSameSite(req), maxAge, path: '/' };
}
