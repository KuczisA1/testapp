// netlify/functions/pdf-key.js
// Mapuje alias z query (?key=TESTDOC1) na ENV: PDF_TESTDOC1 -> <GoogleDriveFileID>

exports.handler = async (event) => {
  try {
    const key = (event.queryStringParameters?.key || '').trim();

    if (!key) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: 'Missing ?key=ALIAS' }),
      };
    }

    // Alias tylko proste znaki (A-Z, a-z, 0-9, _ - :)
    if (!/^[A-Za-z0-9_:-]{1,50}$/.test(key)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: 'Invalid alias format' }),
      };
    }

    const envName = 'PDF_' + key.toUpperCase(); // np. PDF_TESTDOC1
    const fileId = process.env[envName];

    if (!fileId) {
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: `Brak zmiennej środowiskowej ${envName}` }),
      };
    }

    // Prosta walidacja ID z Google Drive (zwykle litery/cyfry,_-)
    if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ error: `Nieprawidłowe fileId w ${envName}` }),
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ fileId }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ error: 'Server error', details: String(e && e.message || e) }),
    };
  }
};
