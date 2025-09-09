// netlify/functions/identity-login.js
//
// Zadania:
// - Ustal i zapisz identyfikator bieżącej sesji (single-device)
// - Ustal i zapisz znacznik startu sesji oraz limit 5 godzin (licznik)
// - Na podstawie ról hour/month/year/active/admin nadaj/odbierz rolę "active"
//   z czasowym oknem ważności dla (hour|month|year)

const crypto = require('crypto');

exports.handler = async (event) => {
  try {
    const payload = JSON.parse(event.body || '{}');
    const user = payload && payload.user;
    if (!user) return { statusCode: 400, body: 'No user in payload' };

    // --- 1) Id sesji (pojedyncze urządzenie) ---
    const newSession = (crypto.randomUUID && crypto.randomUUID()) || crypto.randomBytes(16).toString('hex');

    // --- 2) Start sesji i limit 5 godzin ---
    const SESSION_MAX_SECONDS = 5 * 60 * 60; // 5 godzin
    const nowMs = Date.now();

    // --- 3) Role i logika płatnych okien ---
    const origRoles = Array.isArray(user.app_metadata && user.app_metadata.roles)
      ? [...user.app_metadata.roles]
      : [];

    // Zidentyfikuj "znacznik przydziału" z panelu admina
    const has = (r) => origRoles.includes(r);
    let grantTag = null; // 'hour' | 'month' | 'year' | 'active' | 'admin' | null
    if (has('admin')) grantTag = 'admin';
    else if (has('active')) grantTag = 'active';
    else if (has('year')) grantTag = 'year';
    else if (has('month')) grantTag = 'month';
    else if (has('hour')) grantTag = 'hour';

    const ud = (user.user_metadata) || {};
    const prevTag = ud.paid_role_tag || null;
    const prevUntil = Number(ud.paid_role_until || 0);

    let paidRoleSince = Number(ud.paid_role_since || 0);
    let paidRoleUntil = prevUntil;

    // Jeżeli zmieniono plan (hour→month→year lub odwrotnie), zainicjalizuj od NOW
    const tagChanged = grantTag && grantTag !== prevTag;

    if (grantTag === 'hour' || grantTag === 'month' || grantTag === 'year') {
      if (tagChanged || !Number.isFinite(paidRoleUntil) || paidRoleUntil <= 0) {
        paidRoleSince = nowMs;
        const DAY = 24 * 60 * 60 * 1000;
        if (grantTag === 'hour') paidRoleUntil = nowMs + (60 * 60 * 1000);
        if (grantTag === 'month') paidRoleUntil = nowMs + (30 * DAY);
        if (grantTag === 'year') paidRoleUntil = nowMs + (365 * DAY);
      }
    } else if (grantTag === 'active' || grantTag === 'admin') {
      // Bezterminowy dostęp — czyścimy okno czasowe
      paidRoleSince = paidRoleSince || nowMs;
      paidRoleUntil = 0; // 0 → bez terminu
    } else {
      // Brak przydziału: wyczyść okno
      paidRoleSince = 0;
      paidRoleUntil = 0;
    }

    // Zbuduj zestaw ról zwracanych do Identity (możemy modyfikować app_metadata.roles)
    let nextRoles = [...origRoles];

    const addRole = (r) => { if (!nextRoles.includes(r)) nextRoles.push(r); };
    const removeRole = (r) => { nextRoles = nextRoles.filter(x => x !== r); };

    // Admin zawsze ma dostęp aktywny
    if (grantTag === 'admin') {
      addRole('active');
      removeRole('pending');
    } else if (grantTag === 'active') {
      addRole('active');
      removeRole('pending');
    } else if (grantTag === 'hour' || grantTag === 'month' || grantTag === 'year') {
      const stillValid = paidRoleUntil > nowMs; // przydział czasowy nadal ważny
      if (stillValid) { addRole('active'); removeRole('pending'); }
      else { removeRole('active'); addRole('pending'); }
    } else {
      // brak przydziału → pending
      removeRole('active');
      addRole('pending');
    }

    // Jeżeli nie było żadnych ról, ustaw przynajmniej pending
    if (!nextRoles.length) nextRoles = ['pending'];

    // Zachowaj istniejące user_metadata (np. name, full_name, username)
    const keepMeta = Object.assign({}, user.user_metadata || {});
    keepMeta.current_session = newSession;
    keepMeta.session_started_at = nowMs;
    keepMeta.session_max_seconds = SESSION_MAX_SECONDS;
    keepMeta.paid_role_tag = grantTag || null;
    keepMeta.paid_role_since = paidRoleSince || 0;
    keepMeta.paid_role_until = paidRoleUntil || 0;

    const resp = {
      user_metadata: keepMeta,
      app_metadata: { roles: nextRoles }
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(resp)
    };
  } catch (e) {
    // Nie blokuj logowania, jeśli coś pójdzie nie tak
    return { statusCode: 200, body: '{}' };
  }
};
