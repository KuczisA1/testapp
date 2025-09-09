(() => {
  const IFRAME = document.getElementById('formFrame');
  const ERROR = document.getElementById('error');

  // ——— Helpers ———

  // Akceptuje czyste ID lub pełny link do Google Forms.
  function normalizeFormId(raw) {
    if (!raw) return null;
    raw = decodeURIComponent(String(raw).trim());

    // Jeśli pełny URL, wyciągnij ID z .../forms/d/e/<ID>/... lub .../forms/d/<ID>/...
    try {
      if (/^https?:\/\//i.test(raw)) {
        const u = new URL(raw);
        const parts = u.pathname.split('/').filter(Boolean); // usuń puste segmenty
        const dIndex = parts.findIndex(p => p === 'forms') !== -1
          ? parts.findIndex(p => p === 'd')
          : parts.findIndex(p => p === 'd');

        if (dIndex !== -1) {
          // wariant /forms/d/e/<ID>/...
          if (parts[dIndex + 1] === 'e' && parts[dIndex + 2]) {
            return sanitizeId(parts[dIndex + 2]);
          }
          // wariant /forms/d/<ID>/...
          if (parts[dIndex + 1]) {
            return sanitizeId(parts[dIndex + 1]);
          }
        }
      }
    } catch (_) { /* ignore */ }

    // W innym wypadku traktuj jako surowe ID.
    return sanitizeId(raw);
  }

  // Najczęściej ID ma długość kilkudziesięciu znaków; dopuszczamy litery/cyfry/_/-
  function sanitizeId(id) {
    const m = String(id).match(/[A-Za-z0-9_-]{10,}/);
    return m ? m[0] : null;
  }

  function buildFormUrl(id) {
    // Nowy, wymagany format: /forms/d/e/{id}/viewform?embedded=true
    return `https://docs.google.com/forms/d/e/${id}/viewform?embedded=true`;
  }

  function showError(show) {
    ERROR.classList.toggle('hidden', !show);
  }

  function setIframeSrc(url) {
    IFRAME.src = url;
  }

  function clearQueryFromBar() {
    if (window.history && window.history.replaceState) {
      const clean = window.location.pathname + window.location.hash;
      window.history.replaceState({}, document.title, clean);
    }
  }

  // ——— Main ———
  document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(window.location.search);
    let raw = params.get('id');

    // Jeśli brak ?id= w URL, spróbuj z sessionStorage (po czyszczeniu paska)
    if (!raw) {
      raw = sessionStorage.getItem('formEmbedId') || '';
    }

    const formId = normalizeFormId(raw);

    if (!formId) {
      showError(true);
      return;
    }

    // Zapamiętaj ID dla odświeżeń po usunięciu query
    sessionStorage.setItem('formEmbedId', formId);

    // Ustaw src
    const url = buildFormUrl(formId);
    setIframeSrc(url);

    // Po załadowaniu usuń ?id= z paska adresu
    if (params.has('id')) {
      clearQueryFromBar();
    }

    showError(false);
  });

  // Gdyby iframe zgłosił błąd ładowania, pokaż overlay
  IFRAME.addEventListener('error', () => showError(true));
})();
