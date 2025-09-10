// netlify/functions/slides-key.js
exports.handler = async (event) => {
  try {
    const idKey = (event.queryStringParameters?.id || '').trim();
    const ui = (event.queryStringParameters?.ui || 'embed').trim().toLowerCase();
    const envName = idKey ? `SLIDES_${idKey.toUpperCase()}` : 'SLIDES_ID';

    const raw = process.env[envName];
    if (!raw) return json(404, { error: `Brak zmiennej środowiskowej: ${envName}` });

    const id = extractId(raw);
    if (!id)   return json(400, { error: 'Nie udało się wyciągnąć ID prezentacji.' });

    const urls = buildUrls(id);
    const chosen = ui === 'present' ? urls.presentUrl
                  : ui === 'preview' ? urls.previewUrl
                  : urls.embedUrl;

    return json(200, { key: idKey || 'DEFAULT', mode: ui, url: chosen, ...urls });
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
