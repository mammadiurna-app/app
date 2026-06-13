const ENDPOINT_MAP = {
  'WebLoginJwt':                    '/WebApiCore/api/User/WebLoginJwt',
  'GetUserFirmPreference':          '/WebApiCore/api/User/GetUserFirmPreference',
  'GetCareRegisters':               '/WebApiCore/api/Care/GetCareRegisters',
  'GetCareRegistersGrouped':        '/WebApiCore/api/Care/GetCareRegistersGrouped',
  'GetCareActivePersonContracts':   '/WebApiCore/api/Care/GetCareActivePersonContracts',
  'GetCareItemServices':            '/WebApiCore/api/Care/GetCareItemServices',
  'UpdateCareRegisterData':         '/WebApiCore/api/Care/UpdateCareRegisterData',
  'DeleteCareRegisterData':         '/WebApiCore/api/Care/DeleteCareRegisterData',
};

const BASE = 'https://afdsonline.famigliediurne.ch';
const GOOGLE_CLIENT_ID = 'GOOGLE_CLIENT_ID_SECRET';
const GOOGLE_CLIENT_SECRET = 'GOOGLE_CLIENT_SECRET_SECRET';
const REDIRECT_URI = 'https://mammadiurna-app.github.io/app/';

// Lettura foglio licenze con API key pubblica
const SHEETS_API_KEY = 'SHEETS_API_KEY_SECRET';
const LICENZE_SHEET_ID = '14DhCWCYlte2zhQk74_LG-IovR41W47TajWZBsCdhXE0';
const GRACE_DAYS = 3;
const WARN_DAYS = 10;

async function checkLicenza(username) {
  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${LICENZE_SHEET_ID}/values/Foglio1!A2:E100?key=${SHEETS_API_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Sheets HTTP ' + resp.status);
    const data = await resp.json();
    const rows = data.values || [];

    const today = new Date(); today.setHours(0,0,0,0);
    const row = rows.find(r => (r[0]||'').toLowerCase() === username.toLowerCase());

    if (!row) {
      // Nuovo utente — periodo di grazia
      return { status: 'grace', daysLeft: GRACE_DAYS, message: `Periodo di prova: ${GRACE_DAYS} giorni rimanenti` };
    }

    const attiva = (row[3]||'').toLowerCase() === 'si';
    if (!attiva) return { status: 'blocked', message: 'Licenza disattivata. Contatta Mamma Diurna App.' };

    const scadenza = new Date(row[2]);
    scadenza.setHours(0,0,0,0);
    const diffDays = Math.ceil((scadenza - today) / (1000*60*60*24));

    if (diffDays < -GRACE_DAYS) return { status: 'blocked', message: 'Licenza scaduta. Contatta Mamma Diurna App.' };
    if (diffDays < 0) return {
      status: 'grace',
      daysLeft: GRACE_DAYS + diffDays,
      message: `Licenza scaduta il ${formatDate(scadenza)} — ${GRACE_DAYS + diffDays} giorni di tolleranza`
    };
    if (diffDays <= WARN_DAYS) return {
      status: 'expiring',
      daysLeft: diffDays,
      message: `Scade ${formatDate(scadenza)}`
    };
    return { status: 'ok', scadenza: row[2] };

  } catch(e) {
    return { status: 'ok', message: 'Check non disponibile: ' + e.message };
  }
}

function formatDate(d) {
  const days = ['domenica','lunedì','martedì','mercoledì','giovedì','venerdì','sabato'];
  return days[d.getDay()] + ' ' + d.getDate() + '.' + String(d.getMonth()+1).padStart(2,'0') + '.' + d.getFullYear();
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return cors(new Response(null));

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return cors(new Response(JSON.stringify({
        status: 'ok',
        service: 'AFDS Worker',
        version: '2.2.0',
        buildDate: '2026-06-13',
        features: ['afds-proxy', 'pkce-oauth', 'licenze-api-key']
      }), { headers: { 'Content-Type': 'application/json' } }));
    }

    // Verifica licenza: POST /auth/check
    if (request.method === 'POST' && url.pathname === '/auth/check') {
      let body;
      try { body = await request.json(); } catch(e) {
        return cors(jsonResp({ error: 'invalid_request' }, 400));
      }
      const result = await checkLicenza(body.username || '');
      return cors(jsonResp(result));
    }

    // PKCE token exchange: POST /auth/token
    if (request.method === 'POST' && url.pathname === '/auth/token') {
      let body;
      try { body = await request.json(); } catch(e) {
        return cors(jsonResp({ error: 'invalid_request' }, 400));
      }
      const { code, code_verifier } = body;
      if (!code || !code_verifier) return cors(jsonResp({ error: 'missing params' }, 400));
      try {
        const resp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
            code, code_verifier,
            grant_type: 'authorization_code',
            redirect_uri: REDIRECT_URI,
          })
        });
        const data = await resp.json();
        return cors(jsonResp(data, resp.status));
      } catch(err) {
        return cors(jsonResp({ error: err.message }, 502));
      }
    }

    // AFDS API proxy: POST /api/<endpoint>
    if (request.method === 'POST' && url.pathname.startsWith('/api/')) {
      const endpointName = url.pathname.replace('/api/', '');
      const path = ENDPOINT_MAP[endpointName];
      if (!path) return cors(jsonResp({ success: false, message: `Endpoint sconosciuto: ${endpointName}` }, 404));

      let rawBody;
      try { rawBody = await request.json(); }
      catch(e) { return cors(jsonResp({ success: false, message: 'Body JSON non valido' }, 400)); }

      const authHeader = rawBody.__auth || '';
      const { __auth, ...body } = rawBody;

      try {
        const resp = await fetch(`${BASE}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json', 'Accept': 'application/json',
            'Authorization': authHeader,
            'Origin': 'https://afdsonline.famigliediurne.ch',
            'Referer': 'https://afdsonline.famigliediurne.ch/sirioweb',
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
          },
          body: JSON.stringify(body)
        });
        const text = await resp.text();
        let data;
        try { data = JSON.parse(text); }
        catch(e) { return cors(jsonResp({ success: false, message: `Non-JSON [${resp.status}]: ${text.slice(0,200)}` }, 502)); }
        return cors(jsonResp(data, resp.status));
      } catch(err) {
        return cors(jsonResp({ success: false, message: err.message }, 502));
      }
    }

    return cors(jsonResp({ success: false, message: 'Not found' }, 404));
  }
};

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}
function cors(response) {
  const r = new Response(response.body, response);
  r.headers.set('Access-Control-Allow-Origin', '*');
  r.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  r.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return r;
}
