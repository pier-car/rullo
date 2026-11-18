/* Servizio che porta gli allenamenti da Rullo a Strava (e da lì a CoachPeaking).
   Gira gratis su Cloudflare Workers. Serve solo a tenere nascosto il "segreto" dell'app Strava:
   non salva nulla, non tiene dati, non conserva i token.

   Variabili da impostare su Cloudflare (Settings → Variables and Secrets):
     STRAVA_CLIENT_ID      l'ID dell'app Strava (testo)
     STRAVA_CLIENT_SECRET  il segreto dell'app Strava (tipo "Secret")
     ALLOWED_ORIGIN        l'indirizzo dell'app, ad es. https://pier-car.github.io
*/
const STRAVA = 'https://www.strava.com';

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : 'null',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin'
    };
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!allowed.includes(origin)) return json({ error: 'origine non consentita' }, 403);

    const url = new URL(req.url);
    try {
      // 1) scambio del codice di autorizzazione con i token
      if (url.pathname === '/token' && req.method === 'POST') {
        const { code } = await req.json();
        if (!code) return json({ error: 'codice mancante' }, 400);
        return token(env, { code: String(code), grant_type: 'authorization_code' }, json);
      }
      // 2) rinnovo del token scaduto
      if (url.pathname === '/refresh' && req.method === 'POST') {
        const { refresh_token } = await req.json();
        if (!refresh_token) return json({ error: 'token mancante' }, 400);
        return token(env, { refresh_token: String(refresh_token), grant_type: 'refresh_token' }, json);
      }
      // 3) caricamento del file .fit
      if (url.pathname === '/upload' && req.method === 'POST') {
        const auth = req.headers.get('Authorization') || '';
        if (!/^Bearer \S+$/.test(auth)) return json({ error: 'non autorizzato' }, 401);
        const inc = await req.formData();
        const file = inc.get('file');
        if (!file || typeof file === 'string') return json({ error: 'file mancante' }, 400);
        if (file.size > 10 * 1024 * 1024) return json({ error: 'file troppo grande' }, 413);
        const out = new FormData();
        out.append('file', file, 'rullo.fit');
        out.append('data_type', 'fit');
        out.append('trainer', inc.get('trainer') === '1' ? '1' : '0');
        const name = inc.get('name'); if (name) out.append('name', String(name).slice(0, 200));
        const ext = inc.get('external_id'); if (ext) out.append('external_id', String(ext).slice(0, 100));
        const r = await fetch(STRAVA + '/api/v3/uploads', { method: 'POST', headers: { Authorization: auth }, body: out });
        return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      // 4) stato di un caricamento
      if (url.pathname === '/status' && req.method === 'GET') {
        const auth = req.headers.get('Authorization') || '';
        const id = url.searchParams.get('id') || '';
        if (!/^Bearer \S+$/.test(auth)) return json({ error: 'non autorizzato' }, 401);
        if (!/^\d+$/.test(id)) return json({ error: 'id non valido' }, 400);
        const r = await fetch(`${STRAVA}/api/v3/uploads/${id}`, { headers: { Authorization: auth } });
        return new Response(await r.text(), { status: r.status, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      return json({ error: 'non trovato' }, 404);
    } catch (e) {
      return json({ error: 'errore del servizio: ' + (e && e.message || e) }, 500);
    }
  }
};

async function token(env, params, json) {
  const body = new URLSearchParams({ client_id: env.STRAVA_CLIENT_ID, client_secret: env.STRAVA_CLIENT_SECRET, ...params });
  const r = await fetch(STRAVA + '/oauth/token', { method: 'POST', body });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: 'Strava ha rifiutato la richiesta', detail: d.message || r.status }, r.status === 401 || r.status === 400 ? r.status : 502);
  return json({
    access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at,
    athlete: d.athlete ? { firstname: d.athlete.firstname || '', lastname: d.athlete.lastname || '' } : null
  });
}
