// netlify/functions/pdf-key.js
// Mapuje alias z query (?key=TESTDOC1) na ENV: PDF_TESTDOC1 -> <GoogleDriveFileID>
const { requireAuth, json } = require('./_auth');

exports.handler = async (event, context) => {
  try {
    // Auth: tylko aktywni/admin
    const gate = await requireAuth(event, context, { anyOf: ['active'] });
    if (!gate.ok) return json(gate.statusCode, gate.body);

    const key = (event.queryStringParameters?.key || '').trim();

    if (!key) {
      return json(400, { error: 'Missing ?key=ALIAS' });
    }

    // Alias tylko proste znaki (A-Z, a-z, 0-9, _ - :)
    if (!/^[A-Za-z0-9_:-]{1,50}$/.test(key)) {
      return json(400, { error: 'Invalid alias format' });
    }

    const envName = 'PDF_' + key.toUpperCase(); // np. PDF_TESTDOC1
    const fileId = process.env[envName];

    if (!fileId) {
      return json(404, { error: `Brak zmiennej środowiskowej ${envName}` });
    }

    // Prosta walidacja ID z Google Drive (zwykle litery/cyfry,_-)
    if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
      return json(400, { error: `Nieprawidłowe fileId w ${envName}` });
    }

    return json(200, { fileId });
  } catch (e) {
    return json(500, { error: 'Server error', details: String(e && e.message || e) });
  }
};
