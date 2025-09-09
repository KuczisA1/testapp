// @ts-nocheck
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const hasIdentity = () => typeof window !== 'undefined' && !!window.netlifyIdentity;

  // ===== ŚCIEŻKI =====
  const PATHS = {
    home: ['/', '/index.html'],
    dashboard: '/dashboard.html',
    loginBase: '/login',   // zakładamy public/login/index.html
  };

  // Normalizacja path (bez końcowego "/")
  const norm = (p) => (p.endsWith('/') && p !== '/') ? p.slice(0, -1) : p;
  const here = () => norm(location.pathname);

  const onHome = () => PATHS.home.includes(location.pathname);
  const onDashboard = () => here() === norm(PATHS.dashboard);
  const onLogin = () => here().startsWith(norm(PATHS.loginBase));

  // ===== STAN =====
  let bootstrapped = false;
  let painting = false;
  let guardPending = false;
  let guardQueued = false;
  let identityReady = false;
  let identityInitTs = 0;

  // ===== COOKIE nf_jwt =====
  function setJwtCookie(token) {
    if (!token) return;
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const secure = isLocal ? '' : ' Secure;';
    // Token Netlify Identity zwykle wygasa ~1h; ustawiamy Max-Age ~1h
    document.cookie = `nf_jwt=${token}; Path=/;${secure} SameSite=Lax; Max-Age=3600`;
  }
  function clearJwtCookie() {
    document.cookie = 'nf_jwt=; Path=/; Max-Age=0; Secure; SameSite=Lax';
  }

  // ===== ROLE → STATUS =====
  function statusFromRoles(roles) {
    if (!Array.isArray(roles)) return 'pending';
    if (roles.includes('admin') || roles.includes('active')) return 'active';
    if (roles.includes('pending')) return 'pending';
    return 'pending';
  }

  // ===== UI LINKI =====
  function updateAuthLinks(user) {
    const dashboardLink = $('dashboard-link');
    if (dashboardLink) dashboardLink.style.display = user ? '' : 'none';
  }

  // ===== JWT refresh / naprawa sesji =====
  async function ensureFreshJwtCookieOrLogout() {
    if (!hasIdentity()) return false;
    const ni = window.netlifyIdentity;
    const u = ni.currentUser();
    if (!u) { clearJwtCookie(); return false; }

    // 1. Spróbuj zwykłego JWT
    try {
      const token = await u.jwt();
      setJwtCookie(token);
      return true;
    } catch {}

    // 2. Wymuś odświeżenie
    try {
      const token = await u.jwt(true);
      setJwtCookie(token);
      return true;
    } catch {}

    // 3. Nie udało się — wyloguj i zostań na /login/
    clearJwtCookie();
    try { await ni.logout(); } catch {}
    return false;
  }

  async function refreshUser(user) {
    try { await user.jwt(true); } catch {}
    return window.netlifyIdentity.currentUser() || user;
  }

  function updateNavForStatus(status) {
    const membersLink = $('members-link');
    if (membersLink) membersLink.style.display = (status === 'active') ? '' : 'none';
  }

  // ===== Nazwy użytkownika =====
  function deriveNames(user) {
    const md = (user && user.user_metadata) || {};
    const preferredDisplay =
      md.name ||
      md.full_name ||
      md.display_name ||
      (user && user.email ? user.email.split('@')[0] : '');

    const username =
      md.username ||
      md.preferred_username ||
      (preferredDisplay ? String(preferredDisplay).replace(/\s+/g, '') : '') ||
      (user && user.email ? user.email.split('@')[0] : '');

    return {
      displayName: preferredDisplay || '',
      username: username || ''
    };
  }

  async function paintUser() {
    if (painting) return;
    painting = true;
    try {
      if (!hasIdentity()) return;
      let user = window.netlifyIdentity.currentUser();
      updateAuthLinks(user);
      if (!user) return;

      user = await refreshUser(user);
      try { setJwtCookie(await user.jwt()); } catch {}
      updateAuthLinks(user);

      const emailEl = $('user-email');
      const nameEl = $('user-name');
      const unameEl = $('user-username');
      const statusEl = $('user-status');
      const hintEl = $('status-hint');

      if (emailEl) emailEl.textContent = user.email || '—';

      const { displayName, username } = deriveNames(user);
      document.querySelectorAll('.js-username').forEach(el => { el.textContent = username || '—'; });

      if (nameEl)  nameEl.textContent  = displayName || '—';
      if (unameEl) unameEl.textContent = username || '—';

      const roles = (user.app_metadata && user.app_metadata.roles) || [];
      const status = statusFromRoles(roles);

      if (statusEl) statusEl.textContent = status;
      updateNavForStatus(status);

      if (hintEl) {
        hintEl.textContent = (status === 'active')
          ? 'Masz aktywną rolę. Dostęp do strefy Members jest włączony.'
          : 'Status pending – poproś administratora o aktywację konta.';
      }
    } finally {
      painting = false;
    }
  }

  // ===== Bezpieczne przejście (anty-pętla) =====
  function safeGo(path) {
    path = norm(path);
    if (here() === path) return;
    const last = sessionStorage.getItem('lastNavPath');
    const lastTs = Number(sessionStorage.getItem('lastNavTs') || 0);
    const now = Date.now();
    if (last === path && (now - lastTs) < 2000) return; // nie skacz w kółko
    sessionStorage.setItem('lastNavPath', path);
    sessionStorage.setItem('lastNavTs', String(now));
    location.replace(path); // bez dorzucania historii
  }

  // ======== CROSS-DEVICE LOGOUT (wyloguj jeśli zalogowano się gdzie indziej) ========
  // >>> Aby WYŁĄCZYĆ, zakomentuj cały ten blok LUB ustaw flagę na false:
  const ENABLE_CROSS_DEVICE_LOGOUT = true;

  let stopSessionWatcher = null;

  function getLocalSessionVer()   { return localStorage.getItem('cd_session_ver') || ''; }
  function setLocalSessionVer(v)  { if (v) localStorage.setItem('cd_session_ver', v); }
  function clearLocalSessionVer() { localStorage.removeItem('cd_session_ver'); }

  async function fetchRemoteUser(token) {
    const res = await fetch('/.netlify/identity/user', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('identity/user fetch failed');
    return res.json();
  }

  async function seedSessionVersion() {
    if (!ENABLE_CROSS_DEVICE_LOGOUT) return;
    const ni = window.netlifyIdentity;
    const u = ni.currentUser();
    if (!u) { clearLocalSessionVer(); return; }
    try {
      const token = await u.jwt(true);
      const data  = await fetchRemoteUser(token);
      const ver   = data && data.user_metadata && data.user_metadata.current_session;
      if (ver) setLocalSessionVer(ver);
    } catch {}
  }

  function startSessionWatcher() {
    if (!ENABLE_CROSS_DEVICE_LOGOUT) return () => {};
    let active = true;

    async function check() {
      if (!active || !hasIdentity()) return;
      const ni = window.netlifyIdentity;
      const u  = ni.currentUser();
      if (!u) return;
      try {
        const token = await u.jwt(true);
        const data  = await fetchRemoteUser(token);
        const serverVer = data && data.user_metadata && data.user_metadata.current_session;
        const localVer  = getLocalSessionVer();
        if (serverVer && localVer && serverVer !== localVer) {
          // Inna sesja zalogowana → wyloguj tutaj
          clearJwtCookie();
          clearLocalSessionVer();
          try { await ni.logout(); } catch {}
          safeGo(`${norm(PATHS.loginBase)}/`);
        }
      } catch {}
    }

    const id = setInterval(check, 30000); // co 30s
    check(); // od razu
    const onVis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      active = false;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }
  // ======== /CROSS-DEVICE LOGOUT ========

  // ======== SESJA 5h – licznik i auto-logout ========
  let stopSessionTimer = null;

  function formatHMS(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }

  function startFiveHourTimerIfPossible() {
    if (stopSessionTimer) { stopSessionTimer(); stopSessionTimer = null; }
    if (!hasIdentity()) return () => {};
    const u = window.netlifyIdentity.currentUser();
    if (!u) return () => {};

    const md = u.user_metadata || {};
    const startedAt = Number(md.session_started_at || 0);
    const maxSeconds = Number(md.session_max_seconds || (5 * 60 * 60));
    if (!startedAt || !maxSeconds) return () => {};

    const timerEl = document.getElementById('session-timer');
    let active = true;

    function tick() {
      if (!active) return;
      const now = Date.now();
      const end = startedAt + (maxSeconds * 1000);
      const left = end - now;
      if (timerEl) {
        timerEl.textContent = left > 0
          ? `Pozostały czas sesji: ${formatHMS(left)}`
          : 'Sesja wygasła';
      }
      if (left <= 0) { handleSessionExpiredGlobal(); }
    }

    tick();
    const id = setInterval(tick, 1000);
    return (stopSessionTimer = () => { active = false; clearInterval(id); });
  }
  // ======== /SESJA 5h ========

  // ======== Globalny poller wygaśnięcia sesji (bez UI) ========
  let stopExpiryPoller = null;

  function handleSessionExpiredGlobal(){
    // Delikatnie: wyloguj i przenieś na ekran startowy, bez pętli
    clearJwtCookie();
    try { window.netlifyIdentity.logout(); } catch {}
    safeGo(PATHS.home[0]);
  }

  function startExpiryPoller(){
    if (stopExpiryPoller) { stopExpiryPoller(); stopExpiryPoller = null; }
    if (!hasIdentity()) return () => {};
    const ni = window.netlifyIdentity;
    let active = true;

    async function check(){
      if (!active) return;
      const u = ni.currentUser();
      if (!u) return;
      const md = u.user_metadata || {};
      const startedAt = Number(md.session_started_at || 0);
      const maxSeconds = Number(md.session_max_seconds || 0);
      if (!startedAt || !maxSeconds) return;
      const end = startedAt + (maxSeconds * 1000);
      if (Date.now() >= end) {
        active = false;
        handleSessionExpiredGlobal();
      }
    }

    // Start i cykl co 30s + przy powrocie okna
    check();
    const id = setInterval(check, 30000);
    const onVis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVis);
    return (stopExpiryPoller = () => { active = false; clearInterval(id); document.removeEventListener('visibilitychange', onVis); });
  }
  // ======== /Globalny poller ========

  // ===== Guard właściwy =====
  async function guardAndPaintCore() {
    if (!hasIdentity()) return;

    const user = window.netlifyIdentity.currentUser();

    // HOME: jeśli zalogowany → dashboard
    if (onHome() && user) {
      safeGo(PATHS.dashboard);
      return;
    }

    // LOGIN: jeśli zalogowany → tylko po świeżym JWT idź na dashboard; inaczej zostań
    if (onLogin()) {
      if (user) {
        const ok = await ensureFreshJwtCookieOrLogout();
        if (ok) safeGo(PATHS.dashboard);
      }
      return; // gdy niezalogowany → zostań na /login/
    }

    // DASHBOARD: jeśli niezalogowany → /login/ (ale dopiero PO init Identity)
    if (onDashboard()) {
      if (!user) {
        if (!identityReady) return; // poczekaj na init, unikaj fałszywych redirectów przy odświeżeniu
        safeGo(`${norm(PATHS.loginBase)}/`);
        return;
      }
      // Uruchom/odśwież licznik sesji 5h
      startFiveHourTimerIfPossible();
      await paintUser();
      return;
    }

    // Inne: opcjonalnie odśwież UI jeśli zalogowany
    if (user) {
      await paintUser();
    }
  }

  async function runGuard() {
    if (guardPending) { guardQueued = true; return; }
    guardPending = true;
    try { await guardAndPaintCore(); }
    finally {
      guardPending = false;
      if (guardQueued) { guardQueued = false; runGuard(); }
    }
  }

  function bootstrap() {
    if (bootstrapped || !hasIdentity()) return;
    bootstrapped = true;

    try { window.netlifyIdentity.init(); } catch {}

    // Klik „Zaloguj się” na HOME → /login/
    const loginBtn = $('login-btn');
    if (loginBtn) {
      loginBtn.addEventListener('click', (e) => {
        if (loginBtn.tagName === 'BUTTON') e.preventDefault();
        safeGo(`${norm(PATHS.loginBase)}/`);
      });
    }

    const logoutLink = $('logout-link');
    if (logoutLink) {
      logoutLink.addEventListener('click', (e) => {
        e.preventDefault();
        window.netlifyIdentity.logout();
      });
    }

    // ===== Identity lifecycle =====
    window.netlifyIdentity.on('init', async (user) => {
      identityReady = true;
      identityInitTs = Date.now();
      updateAuthLinks(user);
      if (user) {
        const ok = await ensureFreshJwtCookieOrLogout();
        if (!ok) { await runGuard(); return; }
        await seedSessionVersion();
        if (stopSessionWatcher) stopSessionWatcher();
        stopSessionWatcher = startSessionWatcher();
        // licznik sesji 5h + globalny poller
        startFiveHourTimerIfPossible();
        startExpiryPoller();
      } else {
        clearJwtCookie();
        clearLocalSessionVer();
        if (stopSessionWatcher) { stopSessionWatcher(); stopSessionWatcher = null; }
        if (stopSessionTimer) { stopSessionTimer(); stopSessionTimer = null; }
        if (stopExpiryPoller) { stopExpiryPoller(); stopExpiryPoller = null; }
      }
      await runGuard();
    });

    window.netlifyIdentity.on('login', async (user) => {
      updateAuthLinks(user);
      const ok = await ensureFreshJwtCookieOrLogout();
      if (!ok) return;
      await seedSessionVersion();
      if (stopSessionWatcher) stopSessionWatcher();
      stopSessionWatcher = startSessionWatcher();
      // licznik sesji 5h + globalny poller
      startFiveHourTimerIfPossible();
      startExpiryPoller();
      safeGo(PATHS.dashboard);
    });

    window.netlifyIdentity.on('logout', () => {
      updateAuthLinks(null);
      clearJwtCookie();
      clearLocalSessionVer();
      if (stopSessionWatcher) { stopSessionWatcher(); stopSessionWatcher = null; }
      if (stopSessionTimer) { stopSessionTimer(); stopSessionTimer = null; }
      if (stopExpiryPoller) { stopExpiryPoller(); stopExpiryPoller = null; }
      safeGo(PATHS.home[0]); // '/'
    });

    // ===== Zdarzenia środowiskowe =====
    window.addEventListener('pageshow', () => { runGuard(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') runGuard();
    });
    window.addEventListener('storage', (e) => {
      if (e.key && e.key.includes('gotrue.user')) runGuard();
    });
  }

  // Start
  document.addEventListener('DOMContentLoaded', () => {
    if (!hasIdentity()) return;
    bootstrap();
    updateAuthLinks(window.netlifyIdentity.currentUser());
    runGuard();
  });
})();
