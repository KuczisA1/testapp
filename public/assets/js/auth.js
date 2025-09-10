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
  let lastKnownUser = null;
  let lastUserTs = 0;

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

    // 3. Nie udało się — bądź łagodny: nie wylogowuj, nie czyść cookie.
    // Zostaw stan do kolejnej próby. Zwróć false, aby logika wyżej nie wykonywała działań zależnych od świeżego JWT.
    return false;
  }

  async function refreshUser(user) {
    try { await user.jwt(true); } catch {}
    return window.netlifyIdentity.currentUser() || user;
  }

  function rememberUser(u){ if (u){ lastKnownUser = u; lastUserTs = Date.now(); } }
  function clearRememberedUser(){ lastKnownUser = null; lastUserTs = 0; }
  function getUserRelaxed(){
    const u = window.netlifyIdentity.currentUser();
    if (u) return u;
    // podczas krótkich okien po odświeżeniu korzystamy z ostatnio znanego usera
    if (identityReady && lastKnownUser && (Date.now() - lastUserTs) < 30000) return lastKnownUser;
    return null;
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
      let user = getUserRelaxed();
      updateAuthLinks(user);
      if (!user) return;

      user = await refreshUser(user);
      rememberUser(user);
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
  // Bez pętli/intervali – sprawdzamy przy init i ewentualnie przy zdarzeniach.
  const ENABLE_CROSS_DEVICE_LOGOUT = true;

  function getLocalSessionVer()   { return localStorage.getItem('cd_session_ver') || ''; }
  function setLocalSessionVer(v)  { if (v) localStorage.setItem('cd_session_ver', v); }
  function clearLocalSessionVer() { localStorage.removeItem('cd_session_ver'); localStorage.removeItem('cd_last_sign_in'); }
  function getLocalLastSignIn()   { return Number(localStorage.getItem('cd_last_sign_in') || 0); }
  function setLocalLastSignIn(ts) { if (Number.isFinite(ts) && ts > 0) localStorage.setItem('cd_last_sign_in', String(ts)); }

  function toTs(x){
    if (!x) return 0;
    if (typeof x === 'number') return x;
    const t = Date.parse(String(x));
    return Number.isFinite(t) ? t : 0;
  }

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
      const ls  = toTs((data && (data.last_login || data.last_sign_in_at || data.last_signin_at || data.updated_at || data.confirmed_at || data.created_at)) || 0);
      if (ls) setLocalLastSignIn(ls);
    } catch {}
  }
  async function checkSessionMismatchOnce() {
    if (!ENABLE_CROSS_DEVICE_LOGOUT || !hasIdentity()) return false;
    const ni = window.netlifyIdentity;
    const u  = ni.currentUser();
    if (!u) return false;
    try {
      const token = await u.jwt(true);
      const data  = await fetchRemoteUser(token);
      const serverVer = data && data.user_metadata && data.user_metadata.current_session;
      const localVer  = getLocalSessionVer();
      const serverLS  = toTs((data && (data.last_login || data.last_sign_in_at || data.last_signin_at || data.updated_at || data.confirmed_at || data.created_at)) || 0);
      const localLS   = getLocalLastSignIn();
      const sessionMismatch = !!(serverVer && localVer && serverVer !== localVer);
      const signInMoved    = !!(serverLS && localLS && serverLS > localLS);
      if (sessionMismatch || signInMoved) {
        clearJwtCookie();
        clearLocalSessionVer();
        try { await ni.logout(); } catch {}
        safeGo(`${norm(PATHS.loginBase)}/`);
        return true;
      }
    } catch {}
    return false;
  }
  // ======== /CROSS-DEVICE LOGOUT ========


  // ===== Guard właściwy =====
  async function guardAndPaintCore() {
    if (!hasIdentity()) return;
    const user = getUserRelaxed();

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
      // Sprawdź konflikt sesji (inne urządzenie)
      const conflicted = await checkSessionMismatchOnce();
      if (conflicted) return;
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
      rememberUser(user);
      updateAuthLinks(user);
      if (user) {
        // Najpierw sprawdź konflikt sesji (inne urządzenie), bez pętli
        const conflicted = await checkSessionMismatchOnce();
        if (conflicted) return;
        const ok = await ensureFreshJwtCookieOrLogout();
        if (!ok) { await runGuard(); return; }
        await seedSessionVersion();
      } else {
        clearJwtCookie();
        clearLocalSessionVer();
        clearRememberedUser();
      }
      await runGuard();
    });

    window.netlifyIdentity.on('login', async (user) => {
      updateAuthLinks(user);
      rememberUser(user);
      const ok = await ensureFreshJwtCookieOrLogout();
      if (!ok) return;
      await seedSessionVersion();
      safeGo(PATHS.dashboard);
    });

    window.netlifyIdentity.on('logout', () => {
      updateAuthLinks(null);
      clearJwtCookie();
      clearLocalSessionVer();
      clearRememberedUser();
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
