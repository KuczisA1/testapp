// Netlify Function: members-content
// Zwraca treść members tylko gdy status != pending

exports.handler = async (event, context) => {
  const user = context.clientContext && context.clientContext.user;
  if (!user) {
    return { statusCode: 401, body: 'Brak autoryzacji' };
  }

  function addDuration(start, type){
    const d = new Date(start);
    switch(type){
      case 'hour': d.setHours(d.getHours() + 1); return d;
      case 'month': d.setMonth(d.getMonth() + 1); return d;
      case 'year': d.setFullYear(d.getFullYear() + 1); return d;
      case 'active': return null;
      default: return new Date(0);
    }
  }

  const meta = (user && (user.user_metadata || user.app_metadata)) || {};
  const membership = meta.membership || {};
  const type = membership.type || 'pending';
  const startedAt = membership.startedAt || new Date().toISOString();

  let allowed = false;
  if (type === 'active') allowed = true;
  else if (type === 'hour' || type === 'month' || type === 'year') {
    const exp = addDuration(startedAt, type);
    allowed = exp && exp.getTime() > Date.now();
  }

  if (!allowed) {
    return { statusCode: 403, body: 'Dostęp tylko dla aktywnych członków' };
  }

  const html = `
    <div>
      <p>Witaj w strefie members! Dostęp przyznany.</p>
      <ul>
        <li>Materiały 1</li>
        <li>Materiały 2</li>
        <li>Materiały 3</li>
      </ul>
    </div>
  `;
  return { statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html };
};

