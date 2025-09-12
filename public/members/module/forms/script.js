(() => {
  const IFRAME = document.getElementById('formFrame');
  const ERROR  = document.getElementById('error');
  const LOADER = document.getElementById('loader');

  // —— UI helpers ——
  function showLoader(text, hint){
    if (!LOADER) return;
    const b = LOADER.querySelector('.loader-card b');
    const h = LOADER.querySelector('.hint');
    if (b) b.textContent = text || 'Ładowanie formularza…';
    if (h) h.textContent = hint || 'To może potrwać chwilę przy wolniejszym łączu';
    LOADER.hidden = false;
    const stage = document.querySelector('main.stage');
    if (stage) stage.setAttribute('aria-busy','true');
  }
  function hideLoader(){
    if (LOADER) LOADER.hidden = true;
    const stage = document.querySelector('main.stage');
    if (stage) stage.removeAttribute('aria-busy');
  }
  function showError(show){
    if (!ERROR) return;
    ERROR.classList.toggle('hidden', !show);
    ERROR.hidden = !show;
    ERROR.setAttribute('aria-hidden', String(!show));
  }
  function removeErrorFromDom(){ try { ERROR?.parentNode?.removeChild(ERROR); } catch {} }
  function setIframeSrc(url){ if (IFRAME) IFRAME.src = url; }
  function clearQueryFromBar(){ try { history.replaceState({}, document.title, location.pathname || '/'); } catch {} }

  // —— Input parsing ——
  // ZWRACA { kind: 'url', url } lub { kind: 'id', id }
  function normalizeFormInput(raw){
    if (!raw) return null;
    const s = decodeURIComponent(String(raw).trim());
    // Pełny URL? użyj bezpośrednio (zapewnij embedded=true)
    if (/^https?:\/\//i.test(s)) {
      try {
        const u = new URL(s);
        if (/docs\.google\.com$/i.test(u.hostname) && /\/forms\//i.test(u.pathname)) {
          return { kind: 'url', url: ensureEmbeddedParam(u.toString()) };
        }
        if (/forms\.gle$/i.test(u.hostname)) {
          return { kind: 'url', url: u.toString() }; // Google przekieruje
        }
      } catch {}
      return null; // nieprawidłowy URL
    }
    // Surowe ID
    const m = s.match(/[A-Za-z0-9_-]{10,}/);
    return m ? { kind: 'id', id: m[0] } : null;
  }

  function ensureEmbeddedParam(urlStr){
    try {
      const u = new URL(urlStr);
      if (!u.searchParams.has('embedded')) u.searchParams.set('embedded','true');
      return u.toString();
    } catch { return urlStr; }
  }

  function buildFormUrlFromId(id, variant /* 'e' | 'legacy' */){
    return variant === 'legacy'
      ? `https://docs.google.com/forms/d/${id}/viewform?embedded=true`
      : `https://docs.google.com/forms/d/e/${id}/viewform?embedded=true`;
  }

  function swapVariantInUrl(urlStr){
    try {
      const u = new URL(urlStr);
      if (/\/forms\/d\/e\//i.test(u.pathname))      u.pathname = u.pathname.replace(/\/forms\/d\/e\//i, '/forms/d/');
      else if (/\/forms\/d\//i.test(u.pathname))    u.pathname = u.pathname.replace(/\/forms\/d\//i, '/forms/d/e/');
      return ensureEmbeddedParam(u.toString());
    } catch { return urlStr; }
  }

  // —— Main ——
  document.addEventListener('DOMContentLoaded', () => {
    showError(false); // upewnij się, że overlay błędu jest ukryty na starcie

    const params = new URLSearchParams(window.location.search);
    const pathHint = (params.get('path') || '').toLowerCase(); // 'e' | 'legacy' | ''
    let raw = params.get('id');
    if (!raw) raw = sessionStorage.getItem('formEmbedRaw') || '';

    const parsed = normalizeFormInput(raw);
    if (!parsed) { hideLoader(); showError(true); return; }

    // Zapamiętaj surowy input do odświeżeń po czyszczeniu query
    sessionStorage.setItem('formEmbedRaw', raw);

    let primaryUrl = '';
    let secondaryUrl = '';

    if (parsed.kind === 'url') {
      primaryUrl = parsed.url;
      secondaryUrl = swapVariantInUrl(primaryUrl);
      // Wymuś ścieżkę z URL paramem ?path=
      if (pathHint === 'e' && /\/forms\/d\//i.test(primaryUrl)) {
        primaryUrl = swapVariantInUrl(primaryUrl);
        secondaryUrl = swapVariantInUrl(primaryUrl);
      } else if (pathHint === 'legacy' && /\/forms\/d\/e\//i.test(primaryUrl)) {
        primaryUrl = swapVariantInUrl(primaryUrl);
        secondaryUrl = swapVariantInUrl(primaryUrl);
      }
    } else {
      // samo ID
      const id = parsed.id;
      const primaryVariant = pathHint === 'legacy' ? 'legacy' : 'e';
      const secondaryVariant = primaryVariant === 'e' ? 'legacy' : 'e';
      primaryUrl = buildFormUrlFromId(id, primaryVariant);
      secondaryUrl = buildFormUrlFromId(id, secondaryVariant);
    }

    // —— Załaduj z heurystyką i timeoutem
    showLoader();
    const FAST_LOAD_MS = 350;
    const TIMEOUT_MS   = 5000;
    const startTs = performance.now();
    let settled = false;
    let switched = false;

    function finishOk(){
      if (settled) return;
      settled = true;
      hideLoader();
      showError(false);
      removeErrorFromDom(); // usuń overlay, by nigdy nie „prześwitywał”
      if (params.has('id')) clearQueryFromBar();
    }

    function trySecondary(){
      if (switched || settled) return;
      switched = true;
      setIframeSrc(secondaryUrl);
      IFRAME.addEventListener('load', finishOk, { once: true });
    }

    function onPrimaryLoad(){
      const dt = performance.now() - startTs;
      if (dt < FAST_LOAD_MS && !switched) { // zbyt szybki load → możliwa strona błędu
        trySecondary();
        return;
      }
      finishOk();
    }

    setIframeSrc(primaryUrl);
    IFRAME.addEventListener('load', onPrimaryLoad, { once: true });

    // Timeout fallback
    setTimeout(() => { if (!settled && !switched) trySecondary(); }, TIMEOUT_MS);
  });

  // Dodatkowo: jeśli iframe zgłosi błąd (nie zawsze dla cross-origin)
  if (IFRAME) IFRAME.addEventListener('error', () => { hideLoader(); showError(true); });

  // ——— Anty-konsolka / utrudnienia (opcjonalne)
  try {
    document.addEventListener('contextmenu', e => e.preventDefault(), { passive:false });
    document.addEventListener('keydown', e => {
      const k = (e.key || '').toLowerCase();
      if (e.keyCode === 123) return e.preventDefault(); // F12
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && ['i','j','c'].includes(k)) return e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && ['u','s'].includes(k)) return e.preventDefault();
    }, { capture:true });
    const detect = () => {
      const wDiff = window.outerWidth - window.innerWidth;
      const hDiff = window.outerHeight - window.innerHeight;
      return wDiff > 160 || hDiff > 160; // heurystyka
    };
    setInterval(() => { if (detect()) { document.body.innerHTML = ''; location.replace('/'); } }, 800);
    try { ['log','info','warn','error','debug'].forEach(m => (console[m] = () => {})); } catch {}
  } catch {}
})();
