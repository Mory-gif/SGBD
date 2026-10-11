// Netlify Function : exécute la même API (server.js) sans serveur permanent.
// Utilisée uniquement pour l'Option 3 « Netlify seul » ; sans effet si l'API est sur Render.
import http from 'node:http';
import server from '../../server.js';
import db from '../../db.js';

const { createServer } = server;
let ready = null;

function start() {
  if (!ready) {
    ready = (async () => {
      await db.init();
      const s = createServer();
      await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
      return s.address().port;
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

export default async (req) => {
  let port;
  try {
    port = await start();
  } catch (e) {
    console.error('[function] base de données injoignable :', e.message);
    return new Response(JSON.stringify({ error: 'Base de données injoignable.' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
  const url = new URL(req.url);
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const body = hasBody ? Buffer.from(await req.arrayBuffer()) : null;
  const headers = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  delete headers['accept-encoding'];
  delete headers.host;
  delete headers['transfer-encoding'];
  const ip = headers['x-nf-client-connection-ip'];
  if (ip) headers['x-forwarded-for'] = ip;
  if (body) headers['content-length'] = String(body.length);

  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method: req.method, path: url.pathname + url.search, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (k === 'transfer-encoding' || k === 'connection') continue;
          (Array.isArray(v) ? v : [v]).forEach((x) => h.append(k, x));
        }
        const nobody = [101, 204, 205, 304].includes(res.statusCode) || req.method === 'HEAD';
        resolve(new Response(nobody ? null : Buffer.concat(chunks), { status: res.statusCode, headers: h }));
      });
    });
    r.on('error', (e) => resolve(new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { 'Content-Type': 'application/json' } })));
    if (body) r.write(body);
    r.end();
  });
};

export const config = { path: '/api/*' };
