// netlify/functions/slides-key.js
exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const raw  = (q.id || '').trim();
    const mode = (q.mode || 'preview').trim().toLowerCase(); // preview|present|embed

    const { id, source, err } = resolveId(raw);
    if (err)  return json(err.code, { error: err.msg });
    if (!id)  return json(400, { error: 'Nie udało się ustalić ID prezentacji.' });

    const urls = buildUrls(id);
    const url  = mode === 'present' ? urls.presentUrl
               : mode === 'embed'   ? urls.embedUrl
               : urls.previewUrl; // domyślnie: preview (ma kontrolki)

    return json(200, { id, source, mode, url, ...urls });
  } catch (e) {
    console.error(e);
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

// ---- Ustalenie ID z: URL / czystego ID / klucza env ----
function resolveId(raw) {
  // 0) Brak parametru → domyślna SLIDES_ID
  if (!raw) {
    const envVal = process.env.SLIDES_ID;
    if (!envVal) return { err: { code: 404, msg: 'Brak zmiennej: SLIDES_ID' } };
    const id = extractId(envVal);
    if (!id)   return { err: { code: 400, msg: 'Nie udało się wyciągnąć ID z SLIDES_ID' } };
    return { id, source: 'env:SLIDES_ID' };
  }

  // 1) Spróbuj potraktować wejście jako URL / czyste ID
  const candidate = extractId(raw); // obsługuje URL i samo ID
  if (candidate) {
    // 1a) Jeśli istnieje env o nazwie SLIDES_<CANDIDATE> → to był KLUCZ, nie prawdziwe ID
    const envName = `SLIDES_${candidate.toUpperCase()}`;
    const envVal  = process.env[envName];
    if (envVal) {
      const idFromEnv = extractId(envVal);
      if (!idFromEnv) return { err: { code: 400, msg: `Nie udało się wyciągnąć ID z ${envName}` } };
      return { id: idFromEnv, source: `env:${envName}` };
    }
    // 1b) W przeciwnym razie traktuj jako prawdziwe ID
    return { id: candidate, source: 'query:id/url' };
  }

  // 2) Ostatecznie: traktuj "raw" jako KLUCZ do env
  const envName = `SLIDES_${raw.toUpperCase()}`;
  const envVal  = process.env[envName];
  if (!envVal)  return { err: { code: 404, msg: `Brak zmiennej: ${envName}` } };
  const id = extractId(envVal);
  if (!id)     return { err: { code: 400, msg: `Nie udało się wyciągnąć ID z ${envName}` } };
  return { id, source: `env:${envName}` };
}

// Przyjmuje: pełny link (różne formaty), albo czyste ID → zwraca ID lub null
function extractId(input) {
  if (!input) return null;
  const s = String(input).trim();

  // Już czyste ID?
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;

  // URL-e: /presentation/d/<ID>/..., /file/d/<ID>/..., open?id=..., uc?id=...
  try {
    const u = new URL(s);
    let m = u.pathname.match(/\/(?:presentation|file)\/d\/([A-Za-z0-9_-]+)/i);
    if (m && m[1]) return m[1];
    const qid = u.searchParams.get('id');
    if (qid && /^[A-Za-z0-9_-]{10,}$/.test(qid)) return qid;
  } catch { /* not a URL */ }

  // Szukaj „czegoś co wygląda jak ID” w tekście
  const m2 = s.match(/([A-Za-z0-9_-]{10,})/);
  return m2 ? m2[1] : null;
}

function buildUrls(id) {
  return {
    embedUrl:   `https://docs.google.com/presentation/d/${id}/embed?start=false&loop=false&rm=minimal`,
    previewUrl: `https://docs.google.com/presentation/d/${id}/preview`,
    presentUrl: `https://docs.google.com/presentation/d/${id}/present`,
  };
}
