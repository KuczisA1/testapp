// Zwraca obfuskowane ID z ENV (np. YT_FILM1=dQw4w9WgXcQ)
// GET /.netlify/functions/yt-key?id=YT_FILM1
// Odp: { ok: true, key: "YT_FILM1", obf: [ ...numbers... ] }

exports.handler = async (event) => {
  try {
    const url = new URL(event.rawUrl || `https://x${event.path}${event.queryStringParameters ? "?" + new URLSearchParams(event.queryStringParameters).toString() : ""}`);
    const key = (url.searchParams.get("id") || "").toUpperCase().trim();

    if (!key || !/^[A-Z0-9_:-]+$/.test(key)) {
      return resp(400, { ok: false, error: "bad_key" });
    }

    const val = process.env[key];
    if (!val || typeof val !== "string" || val.trim().length !== 11) {
      return resp(404, { ok: false, error: "not_found_or_bad_length" });
    }

    const videoId = val.trim(); // 11 znaków
    const obf = Array.from(videoId).map(c => c.charCodeAt(0) ^ 73);

    return resp(200, { ok: true, key, obf });
  } catch (e) {
    return resp(500, { ok: false, error: "server_error" });
  }
};

function resp(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    },
    body: JSON.stringify(body)
  };
}
