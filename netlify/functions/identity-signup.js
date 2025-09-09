// netlify/functions/identity-signup.js
exports.handler = async (event) => {
  try {
    const payload = JSON.parse(event.body || "{}");
    const user = payload && payload.user;
    if (!user) {
      return { statusCode: 400, body: "No user in payload" };
    }
    // Nadaj rolę "pending" podczas rejestracji
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app_metadata: { roles: ["pending"] } })
    };
  } catch {
    // Nie blokuj rejestracji, jeśli coś się wykrzaczy
    return { statusCode: 200, body: "{}" };
  }
};
