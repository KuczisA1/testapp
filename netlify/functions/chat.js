// netlify/functions/chat.js
const MODEL_DEFAULT = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

exports.handler = async (event) => {
  // CORS / preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders()
    };
  }
  if (event.httpMethod !== 'POST') {
    return json({ error: 'Use POST' }, 405);
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return json({ error: 'Server misconfigured: missing GEMINI_API_KEY' }, 500);

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const {
    messages = [],
    system = null,
    attachmentInline = null,
    options = {}
  } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'messages array required' }, 400);
  }

  const model = String(options.model || MODEL_DEFAULT);
  const temperature = Number.isFinite(options.temperature) ? options.temperature : 0.2;

  // Build Gemini "contents"
  const contents = [];
  const prev = messages.slice(0, -1);
  for (const m of prev) {
    if (!m || !m.role) continue;
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    contents.push({ role, parts: [{ text: String(m.content || '') }] });
  }

  const last = messages[messages.length - 1];
  const lastParts = [];
  if (last?.content) lastParts.push({ text: String(last.content) });
  if (attachmentInline?.mimeType && attachmentInline?.data) {
    lastParts.push({ inlineData: { mimeType: attachmentInline.mimeType, data: attachmentInline.data } });
  }
  contents.push({ role: 'user', parts: lastParts });

  const payload = {
    contents,
    generationConfig: { temperature }
  };
  if (system) {
    payload.systemInstruction = { role: 'user', parts: [{ text: String(system) }] };
  }

  try {
    const url = `${API_BASE}/models/${encodeURIComponent(model)}:generateContent`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(payload)
    });

    if (!resp.ok) {
      const text = await safeText(resp);
      return json({ error: `Upstream ${resp.status}`, details: text.slice(0, 800) }, 502);
    }

    const data = await resp.json();
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map(p => p.text || '')
      .join('');

    return json({ text });
  } catch (err) {
    return json({ error: 'Request failed', details: String(err.message || err) }, 500);
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
}
function json(obj, status = 200) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
    body: JSON.stringify(obj)
  };
}
async function safeText(r) {
  try { return await r.text(); } catch { return ''; }
}
