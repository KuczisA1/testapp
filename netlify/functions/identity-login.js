// netlify/functions/identity-login.js
const crypto = require('crypto');

exports.handler = async (event) => {
  try {
    const payload = JSON.parse(event.body || "{}");
    const user = payload && payload.user;
    if (!user) return { statusCode: 400, body: "No user in payload" };

    const newSession =
      (crypto.randomUUID && crypto.randomUUID()) ||
      crypto.randomBytes(16).toString('hex');

    const roles = (user.app_metadata && user.app_metadata.roles) || [];
    const hasRoles = Array.isArray(roles) && roles.length > 0;

    const resp = {
      // przechowujemy wersję sesji na koncie
      user_metadata: { current_session: newSession }
    };
    if (!hasRoles) {
      resp.app_metadata = { roles: ["pending"] };
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resp)
    };
  } catch {
    return { statusCode: 200, body: "{}" };
  }
};
