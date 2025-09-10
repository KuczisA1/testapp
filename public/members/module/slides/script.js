// netlify/functions/slides-key.js
exports.handler = async (event) => {
  try {
    if (event.httpMethod && event.httpMethod !== 'GET') {
      return json(405, { error: 'Method Not Allowed' });
    }

    const qp = event.queryStringParameters || {};
    const rawId = (qp.id || '').trim();
    // Wspieraj oba klucze: "mode" (nowe) i "ui" (wsteczna kompatybilność)
    const mode = ((qp.mode ?? qp.ui ?? 'embed') + '').trim().toLowerCase();

    const id = extractId(rawId);
    if (!id) return json(400, { error: 'Podaj poprawne ID prezentacji w ?id=… (może być pełny link lub samo ID).' });

    const urls = buildUrls(id);
    const chosen = mode === 'present' ? urls.presentUrl
                  : mode === 'preview' ? urls.previewUrl
                  : urls.embedUrl;

    return json(200, { id, mode, url: chosen, ...urls });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'Błąd serwera funkcji.' });
  }
};

function json(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(bodyObj),
  };
}

function extractId(input) {
  const s = String(input).trim();
  try {
    const u = new URL(s);
    const m = u.pathname.match(/\/presentation\/d\/([\w-]+)/i);
    return m?.[1] || null;
  } catch { /* not a URL */ }
  return /^[\w-]+$/.test(s) ? s : null;
}

function buildUrls(id) {
  // Embed – minimum UI
  const embedUrl   = `https://docs.google.com/presentation/d/${id}/embed?start=false&loop=false&rm=minimal`;
  // Preview – kontrolki na dole (Google’owe)
  const previewUrl = `https://docs.google.com/presentation/d/${id}/preview`;
  // Present – tryb prezentacji (pasek, laser po "L")
  const presentUrl = `https://docs.google.com/presentation/d/${id}/present`;
  return { embedUrl, previewUrl, presentUrl };
}
