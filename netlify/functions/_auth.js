// netlify/functions/_auth.js
// Lightweight helper to enforce Netlify Identity auth/roles in Functions

function getTokenFromAuthHeader(headers) {
  const h = headers || {};
  const auth = h.authorization || h.Authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : '';
}

function getTokenFromCookies(headers) {
  const cookie = (headers && headers.cookie) || '';
  if (!cookie) return '';
  const parts = cookie.split(/;\s*/);
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k === 'nf_jwt') return v || '';
  }
  return '';
}

function pickBaseUrl(event) {
  const h = (event && event.headers) || {};
  const proto = h['x-forwarded-proto'] || 'https';
  const host = h['x-forwarded-host'] || h.host || '';
  if (!host) return process.env.URL || '';
  return `${proto}://${host}`;
}

async function fetchIdentityUser(event, token) {
  if (!token) return null;
  const base = pickBaseUrl(event);
  if (!base) return null;
  try {
    const res = await fetch(`${base}/.netlify/identity/user`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function hasAnyRole(user, required) {
  if (!required || !required.length) return !!user;
  const roles = (user && user.app_metadata && user.app_metadata.roles) || [];
  if (!Array.isArray(roles)) return false;
  if (roles.includes('admin')) return true; // admin always allowed
  return required.some(r => roles.includes(r));
}

async function requireAuth(event, context, options = {}) {
  const required = options.anyOf || [];
  const allowPending = !!options.allowPending;

  // Prefer Netlify-validated context
  let user = context && context.clientContext && context.clientContext.user;

  // If no context.user, try to validate token ourselves via Identity endpoint
  if (!user) {
    const token = getTokenFromAuthHeader(event.headers) || getTokenFromCookies(event.headers);
    if (token) {
      user = await fetchIdentityUser(event, token);
    }
  }

  if (!user) {
    return { ok: false, statusCode: 401, body: { error: 'unauthorized' } };
  }

  // Pending handling
  if (allowPending) return { ok: true, user };

  // Role check first
  if (!hasAnyRole(user, required)) {
    return { ok: false, statusCode: 403, body: { error: 'forbidden' } };
  }

  // Additional time-window enforcement for time-limited roles
  // If endpoint requires 'active' and user has time-limited grant (hour|month|year)
  // then ensure paid_role_until is still in the future.
  const needsActive = required.includes('active');
  if (needsActive) {
    const md = (user && user.user_metadata) || {};
    const tag = md.paid_role_tag;
    const until = Number(md.paid_role_until || 0);
    if ((tag === 'hour' || tag === 'month' || tag === 'year') && until > 0) {
      if (Date.now() >= until) {
        return { ok: false, statusCode: 403, body: { error: 'expired' } };
      }
    }
  }
  return { ok: true, user };
}

function corsHeaders(origin = '*') {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
}

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(), ...(extraHeaders || {}) },
    body: JSON.stringify(body || {})
  };
}

module.exports = { requireAuth, corsHeaders, json };
