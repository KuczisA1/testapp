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
  function getCookie(name){
    const m = document.cookie.match(new RegExp('(?:^|; )'+name+'=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }
  function hasJwtCookie(){ return !!getCookie('nf_jwt'); }

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

      // Uzyskaj świeży token i pełne dane użytkownika (żeby mieć aktualne role)
      user = await refreshUser(user);
      rememberUser(user);
      let token = null;
      try { token = await user.jwt(true); setJwtCookie(token); } catch {}
      updateAuthLinks(user);

      const emailEl = $('user-email');
      const nameEl = $('user-name');
      const unameEl = $('user-username');
      const statusEl = $('user-status');
      const hintEl = $('status-hint');

      if (emailEl) emailEl.textContent = user.email || '—';

      // Pobierz świeże role/nazwy z Identity API
      let fresh = null;
      try { if (token) fresh = await fetchRemoteUser(token); } catch {}
      const roles = (fresh && fresh.app_metadata && Array.isArray(fresh.app_metadata.roles))
        ? fresh.app_metadata.roles
        : ((user.app_metadata && Array.isArray(user.app_metadata.roles)) ? user.app_metadata.roles : []);

      const namesProxy = fresh ? { user_metadata: fresh.user_metadata, email: fresh.email } : user;
      const { displayName, username } = deriveNames(namesProxy);
      document.querySelectorAll('.js-username').forEach(el => { el.textContent = username || '—'; });

      if (nameEl)  nameEl.textContent  = displayName || '—';
      if (unameEl) unameEl.textContent = username || '—';
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
  function clearLocalSessionVer() { localStorage.removeItem('cd_session_ver'); }

  // (usunięto dodatkowe porównanie znaczników czasu logowania — powodowało fałszywe konflikty po zmianie ról)

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
      const sessionMismatch = !!(serverVer && localVer && serverVer !== localVer);
      if (sessionMismatch) {
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

    // DASHBOARD: jeśli niezalogowany → spróbuj odzyskać usera, potem /login/
    if (onDashboard()) {
      if (!user) {
        if (!identityReady) return; // czekaj na init
        // Jeśli mamy cookie JWT, spróbuj odświeżyć usera
        if (hasJwtCookie && hasJwtCookie()) {
          try { await window.netlifyIdentity.refresh(); } catch {}
          const ok2 = await ensureFreshJwtCookieOrLogout();
          if (ok2) {
            const u2 = window.netlifyIdentity.currentUser();
            if (u2) { await paintUser(); return; }
          }
        }
        // dalej brak usera → login
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
        try { await window.netlifyIdentity.refresh(); } catch {}
      } else {
        // Nie czyść od razu – pozwól guardowi spróbować odświeżyć użytkownika
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
