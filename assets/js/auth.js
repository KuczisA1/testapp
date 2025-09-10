// Minimalny helper do Netlify Identity (GoTrue) i członkostwa
// Uwaga: włącz Identity w ustawieniach Netlify (Site settings → Identity)

(function(){
  const goTrue = new GoTrue({
    APIUrl: window.location.origin + '/.netlify/identity',
    audience: '',
    setCookie: false
  });

  const MEMBERSHIP_TYPES = ['pending', 'active', 'hour', 'month', 'year'];

  function now(){ return new Date(); }
  function addDuration(start, type){
    if (!start) return null;
    const d = new Date(start);
    switch(type){
      case 'hour': d.setHours(d.getHours() + 1); return d;
      case 'month': d.setMonth(d.getMonth() + 1); return d;
      case 'year': d.setFullYear(d.getFullYear() + 1); return d;
      case 'active': return null; // bez końca
      default: return new Date(0); // pending → wygasłe
    }
  }

  function effectiveMembership(user){
    const meta = (user && (user.user_metadata || user.app_metadata)) || {};
    const membership = meta.membership || {};
    let type = membership.type || 'pending';
    let startedAt = membership.startedAt ? new Date(membership.startedAt) : null;

    if (!MEMBERSHIP_TYPES.includes(type)) type = 'pending';
    if (!startedAt) {
      // Dla nowych kont zaczynamy od pending z bieżącym czasem jako metadane
      startedAt = now();
    }

    if (type === 'active') {
      return { role: type, status: 'active', startedAt, expiresAt: null };
    }
    const exp = addDuration(startedAt, type);
    const expired = exp && exp.getTime() <= now().getTime();
    if (expired || type === 'pending') {
      return { role: 'pending', status: 'pending', startedAt, expiresAt: exp };
    }
    return { role: type, status: type, startedAt, expiresAt: exp };
  }

  async function syncPendingIfExpired(){
    const u = goTrue.currentUser();
    if (!u) return;
    try {
      const meta = u.user_metadata || {};
      const membership = meta.membership || {};
      const eff = effectiveMembership(u);
      if (eff.status === 'pending' && membership.type && membership.type !== 'pending'){
        await u.update({ data: { membership: { type: 'pending', startedAt: membership.startedAt || new Date().toISOString() }}});
      }
    } catch(_e){}
  }

  async function ensureInitialMetadata(user){
    // Upewnia się, że user ma membership w user_metadata (jeśli nie, zakłada pending)
    try{
      const meta = user.user_metadata || {};
      if (!meta.membership) {
        await user.update({ data: { membership: { type: 'pending', startedAt: new Date().toISOString() }}});
      }
    }catch(_e){/* brak uprawnień nie blokuje działania UI */}
  }

  async function signup(email, password){
    const u = await goTrue.signup(email, password, { membership: { type: 'pending', startedAt: new Date().toISOString() } });
    // Niektóre konfiguracje Identity wymagają potwierdzenia mailowego – wówczas login nastąpi po weryfikacji.
    try{ await goTrue.login(email, password); }catch(_e){}
    return currentUser();
  }

  async function login(email, password){
    const u = await goTrue.login(email, password);
    await ensureInitialMetadata(u);
    return u;
  }

  function currentUser(){ return goTrue.currentUser(); }

  async function logout(){ const u = goTrue.currentUser(); if (u) await u.logout(); }

  async function jwt(){ const u = goTrue.currentUser(); if (!u) return null; return u.jwt(); }

  async function deleteAccount(){
    const u = goTrue.currentUser();
    if (!u) throw new Error('Brak zalogowanego użytkownika');
    await u.delete();
  }

  window.chemdiskAuth = {
    login, signup, logout, jwt, currentUser, deleteAccount, effectiveMembership, syncPendingIfExpired
  };
})();
