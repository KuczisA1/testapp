// @ts-nocheck
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const hasIdentity = () => typeof window !== 'undefined' && !!window.netlifyIdentity;

  // ===== ŚCIEŻKI =====
  const PATHS = {
    home: ['/', '/index.html'],
    membersBase: '/members',
    loginBase: '/login',   // zakładamy public/login/index.html
  };

  // Normalizacja path (bez końcowego "/")
  const norm = (p) => (p.endsWith('/') && p !== '/') ? p.slice(0, -1) : p;
  const here = () => norm(location.pathname);

  const onHome = () => PATHS.home.includes(location.pathname);
  const onMembers = () => here().startsWith(norm(PATHS.membersBase));
  const onLogin = () => here().startsWith(norm(PATHS.loginBase));

  // ===== STAN =====
  let bootstrapped = false;
  let painting = false;
  let guardPending = false;
  let guardQueued = false;

  // ===== COOKIE nf_jwt =====
  function setJwtCookie(token) {
    if (!token) return;
    const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    const secure = isLocal ? '' : ' Secure;';
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
      const emailEl2 = $('user-email-current');
      const nameEl = $('user-name');
      const unameEl = $('user-username');
      const statusEl = $('user-status');
      const hintEl = $('status-hint');

      if (emailEl)  emailEl.textContent  = user.email || '—';
      if (emailEl2) emailEl2.textContent = user.email || '—';

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

  // (Usunięto cross-device logout: brak ukrytych wylogowań, zero pollingu)

  // ===== Guard właściwy =====
  async function guardAndPaintCore() {
    if (!hasIdentity()) return;

    const user = window.netlifyIdentity.currentUser();

    // HOME: jeśli zalogowany i ACTIVE → members
    if (onHome() && user) {
      const roles = (user.app_metadata && user.app_metadata.roles) || [];
      const status = statusFromRoles(roles);
      if (status === 'active') {
        safeGo(`${norm(PATHS.membersBase)}/`);
        return;
      }
    }

    // LOGIN: jeśli zalogowany → po świeżym JWT sprawdź rolę; ACTIVE → members, inaczej zostań
    if (onLogin()) {
      if (user) {
        const ok = await ensureFreshJwtCookieOrLogout();
        if (ok) {
          const roles = (user.app_metadata && user.app_metadata.roles) || [];
          const status = statusFromRoles(roles);
          if (status === 'active') safeGo(`${norm(PATHS.membersBase)}/`);
        }
      }
      return; // gdy niezalogowany → zostań na /login/
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
      updateAuthLinks(user);
      if (user) {
        const ok = await ensureFreshJwtCookieOrLogout();
        if (!ok) { await runGuard(); return; }
      } else {
        clearJwtCookie();
      }
      await runGuard();
    });

    window.netlifyIdentity.on('login', async (user) => {
      updateAuthLinks(user);
      const ok = await ensureFreshJwtCookieOrLogout();
      if (!ok) return;
      const roles = (user.app_metadata && user.app_metadata.roles) || [];
      const status = statusFromRoles(roles);
      if (status === 'active') {
        safeGo(`${norm(PATHS.membersBase)}/`);
      } else {
        // pozostań na loginie
        if (!onLogin()) safeGo(`${norm(PATHS.loginBase)}/`);
      }
    });

    window.netlifyIdentity.on('logout', () => {
      updateAuthLinks(null);
      clearJwtCookie();
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
