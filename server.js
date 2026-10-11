'use strict';
/* ==========================================================================
   server.js — API + logique serveur de SGBD PASTEF Rufisque
   --------------------------------------------------------------------------
   - Authentification : mots de passe hachés (scrypt), jeton signé HS256.
   - Droits : même matrice que l'interface (admin principal / administrateur /
     utilisateur), appliquée ICI côté serveur sur chaque écriture.
   - Données : API générique pilotée par la description des tables de db.js.
   - Interface : le dossier public/ est servi tel quel (ou hébergé ailleurs,
     par exemple sur Netlify, en pointant public/config.js vers cette API).
   Seule dépendance : "pg". Tout le reste utilise les modules intégrés de Node.
   ========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const db = require('./db');

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const PUBLIC_DIR = path.join(__dirname, 'public');
const JSON_LIMIT = Number(process.env.JSON_LIMIT_MB || 100) * 1024 * 1024;
const TOKEN_TTL_S = Number(process.env.TOKEN_TTL_HOURS || 12) * 3600;
const TRUST_PROXY = String(process.env.TRUST_PROXY || 'true').toLowerCase() !== 'false';

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[auth] JWT_SECRET non défini : un secret temporaire est utilisé (les sessions seront perdues à chaque redémarrage). Définissez JWT_SECRET.');
}
const PHOTO_KEY = crypto.createHash('sha256').update('photo:' + JWT_SECRET).digest();

const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);

// --- Droits (identiques à PERMISSIONS dans public/app.js) --------------------
const PERMISSIONS = {
  admin_principal: { manageUsers: true, manageStructure: true, editData: true, deleteData: true },
  admin_secondaire: { manageUsers: false, manageStructure: false, editData: true, deleteData: true },
  utilisateur: { manageUsers: false, manageStructure: false, editData: true, deleteData: false },
};
const can = (role, action) => Boolean(PERMISSIONS[role] && PERMISSIONS[role][action]);

// Droits requis pour écrire / supprimer, par table.
const WRITE_RIGHT = {
  users: ['manageUsers'],
  cellules: ['manageStructure'], sections: ['manageStructure'], quartiers: ['manageStructure'],
  membres: ['editData'], bureauxVote: ['editData'], elections: ['editData'], depouillements: ['editData'],
  resultats: ['editData'], couches: ['editData'], stylesCouches: ['editData'],
};
const DELETE_RIGHT = {
  users: ['manageUsers'],
  cellules: ['manageStructure', 'deleteData'], sections: ['manageStructure', 'deleteData'], quartiers: ['manageStructure'],
  membres: ['deleteData'], bureauxVote: ['editData'], elections: ['editData'], depouillements: ['editData'],
  resultats: ['editData'], couches: ['editData'], stylesCouches: ['editData'],
};

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

// --- Jeton signé (JWT HS256) ----------------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString('base64url');
function signToken(payload) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest();
  let given;
  try { given = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'HS256') return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

// --- Photos : URL signées (utilisables dans <img>, sans en-tête d'autorisation) ---
function signPhoto(kind, id, v) {
  return crypto.createHmac('sha256', PHOTO_KEY).update(`${kind}:${id}:${v}`).digest('hex').slice(0, 32);
}
db.setPhotoUrlBuilder((kind, id, v) => `/api/photos/${kind}/${id}?v=${v}&s=${signPhoto(kind, id, v)}`);

// --- Limitation de débit (en mémoire) ------------------------------------------------
function makeLimiter(windowMs, limit) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, windowMs).unref();
  return {
    blocked(key) { const h = hits.get(key); return Boolean(h && h.reset > Date.now() && h.count >= limit); },
    hit(key) {
      const now = Date.now(); const h = hits.get(key);
      if (!h || h.reset < now) hits.set(key, { count: 1, reset: now + windowMs }); else h.count += 1;
    },
  };
}
const loginFailures = makeLimiter(15 * 60 * 1000, 30);
const previewHits = makeLimiter(60 * 1000, 60);

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1];          // ajouté par le dernier relais de confiance
  }
  return req.socket.remoteAddress || 'inconnu';
}

// --- Utilitaires HTTP --------------------------------------------------------------------
function baseHeaders(req) {
  const h = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  };
  if (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') h['Strict-Transport-Security'] = 'max-age=15552000';
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.length && (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin.replace(/\/$/, '')))) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Expose-Headers'] = 'ETag';
    h.Vary = 'Origin';
  }
  return h;
}

async function send(req, res, status, body, headers = {}) {
  const h = { ...baseHeaders(req), ...headers };
  let payload = body;
  if (body !== undefined && body !== null && !Buffer.isBuffer(body) && typeof body !== 'string') {
    payload = JSON.stringify(body);
    h['Content-Type'] = 'application/json; charset=utf-8';
  }
  if (payload === undefined || payload === null) { res.writeHead(status, h); return res.end(); }
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const compressible = /json|text|javascript|css|svg|xml/.test(h['Content-Type'] || '');
  if (compressible && buf.length > 1024 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    const gz = await new Promise((resolve, reject) => zlib.gzip(buf, { level: 5 }, (e, r) => (e ? reject(e) : resolve(r))));
    h['Content-Encoding'] = 'gzip';
    h.Vary = h.Vary ? `${h.Vary}, Accept-Encoding` : 'Accept-Encoding';
    h['Content-Length'] = gz.length;
    res.writeHead(status, h);
    return res.end(req.method === 'HEAD' ? undefined : gz);
  }
  h['Content-Length'] = buf.length;
  res.writeHead(status, h);
  return res.end(req.method === 'HEAD' ? undefined : buf);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > JSON_LIMIT) { req.resume(); return reject(new HttpError(413, 'Données trop volumineuses.', 'PayloadTooLarge')); }
    const chunks = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > JSON_LIMIT) { req.destroy(); reject(new HttpError(413, 'Données trop volumineuses.', 'PayloadTooLarge')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'JSON invalide.', 'BadRequest')); }
    });
    req.on('error', reject);
  });
}

// --- Routeur minimal ---------------------------------------------------------------------------
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler, auth: opts.auth !== false });
}

// --- Authentification ------------------------------------------------------------------------------
const userCache = new Map();                                      // id -> { u, t }
const invalidateUsers = () => userCache.clear();
async function loadUser(id) {
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.t < 5000) return hit.u;
  const r = await db.pool.query('SELECT id, identifiant, role, actif FROM utilisateurs WHERE id = $1', [id]);
  const u = r.rows[0] || null;
  userCache.set(id, { u, t: Date.now() });
  return u;
}
async function authenticate(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) throw new HttpError(401, 'Authentification requise.', 'unauthorized');
  const payload = verifyToken(token);
  if (!payload) throw new HttpError(401, 'Session expirée : reconnectez-vous.', 'unauthorized');
  const u = await loadUser(payload.sub);
  if (!u || !u.actif) throw new HttpError(401, 'Compte désactivé ou supprimé.', 'unauthorized');
  return u;
}

let DUMMY_HASH = null;                                            // temps de réponse constant si l'identifiant n'existe pas

route('POST', '/api/login', async (ctx) => {
  const ip = clientIp(ctx.req);
  if (loginFailures.blocked(ip)) throw new HttpError(429, 'Trop de tentatives de connexion. Réessayez dans quelques minutes.', 'TooManyRequests');
  const identifiant = String((ctx.body && ctx.body.identifiant) || '').trim();
  const motDePasse = String((ctx.body && ctx.body.motDePasse) || '');
  const r = await db.pool.query('SELECT id, identifiant, role, actif, password_hash FROM utilisateurs WHERE identifiant = $1', [identifiant]);
  const u = r.rows[0];
  if (!DUMMY_HASH) DUMMY_HASH = await db.hashPassword(crypto.randomBytes(8).toString('hex'));
  const ok = await db.verifyPassword(motDePasse, u ? u.password_hash : DUMMY_HASH);
  if (!u || !u.actif || !ok) {
    loginFailures.hit(ip);
    throw new HttpError(401, 'Identifiant ou mot de passe incorrect.', 'InvalidCredentials');
  }
  await db.pool.query('UPDATE utilisateurs SET derniere_connexion = now() WHERE id = $1', [u.id]);
  invalidateUsers();
  return { status: 200, body: { token: signToken({ sub: u.id }), session: { userId: u.id, identifiant: u.identifiant, role: u.role } } };
}, { auth: false });

// Aperçu de la photo sur l'écran de connexion (comportement de l'interface d'origine).
route('GET', '/api/login-preview', async (ctx) => {
  const ip = clientIp(ctx.req);
  if (previewHits.blocked(ip)) throw new HttpError(429, 'Trop de requêtes.', 'TooManyRequests');
  previewHits.hit(ip);
  const identifiant = String(ctx.query.get('identifiant') || '').trim();
  if (!identifiant) return { status: 200, body: {} };
  const r = await db.pool.query(
    `SELECT u.id, u.identifiant, u.actif, p.updated_at AS photo_v FROM utilisateurs u
     LEFT JOIN photos_utilisateurs p ON p.utilisateur_id = u.id WHERE u.identifiant = $1`, [identifiant]);
  const u = r.rows[0];
  if (!u) return { status: 200, body: {} };
  const v = u.photo_v ? new Date(u.photo_v).getTime() : 0;
  return { status: 200, body: { identifiant: u.identifiant, photoDataUrl: v ? `/api/photos/users/${u.id}?v=${v}&s=${signPhoto('users', u.id, v)}` : '' } };
}, { auth: false });

route('GET', '/api/health', async () => {
  await db.pool.query('SELECT 1');
  return { status: 200, body: { status: 'ok' } };
}, { auth: false });

route('GET', '/api/photos/:kind/:id', async (ctx) => {
  const { kind } = ctx.params;
  const id = Number(ctx.params.id);
  const v = String(ctx.query.get('v') || '');
  const s = String(ctx.query.get('s') || '');
  const spec = kind === 'membres' ? db.TABLES.membres : kind === 'users' ? db.TABLES.users : null;
  if (!spec || !Number.isInteger(id)) throw new HttpError(404, 'Photo introuvable.');
  const expected = signPhoto(kind, id, v);
  if (s.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) throw new HttpError(403, 'Lien de photo invalide.');
  const r = await db.pool.query(`SELECT mime, data FROM ${spec.photo.table} WHERE ${spec.photo.col} = $1`, [id]);
  if (!r.rows[0]) throw new HttpError(404, 'Photo introuvable.');
  return { status: 200, body: r.rows[0].data, headers: { 'Content-Type': r.rows[0].mime, 'Cache-Control': 'private, max-age=31536000, immutable' } };
}, { auth: false });

// --- API de données (générique) ------------------------------------------------------------------------
function tableOf(ctx) {
  const name = ctx.params.table;
  if (!Object.prototype.hasOwnProperty.call(db.TABLES, name)) throw new HttpError(404, 'Table inconnue.');
  return db.TABLES[name];
}
function need(user, rights) {
  for (const r of rights) if (!can(user.role, r)) throw new HttpError(403, 'Droits insuffisants pour cette opération.', 'forbidden');
}
function parseId(spec, raw) {
  if (spec.textPk) return String(decodeURIComponent(raw));
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new HttpError(400, 'Identifiant invalide.');
  return n;
}
const etagOf = (v) => `"v${v}"`;
const ok = (body, extra = {}) => ({ status: 200, body, ...extra });

// Liste complète d'une table, avec validation de cache (ETag = version de la table).
route('GET', '/api/data/:table', async (ctx) => {
  const spec = tableOf(ctx);
  if (spec.api === 'users') need(ctx.user, ['manageUsers']);
  const version = await db.getVersion(spec.api);
  const headers = { ETag: etagOf(version), 'Cache-Control': 'private, no-cache' };
  if (ctx.req.headers['if-none-match'] === etagOf(version)) return { status: 304, headers };
  return ok(await db.listRows(spec), { headers });
});

route('GET', '/api/data/:table/:id', async (ctx) => {
  const spec = tableOf(ctx);
  const id = parseId(spec, ctx.params.id);
  if (spec.api === 'users' && id !== ctx.user.id) need(ctx.user, ['manageUsers']);
  const row = await db.getRow(spec, id);
  if (!row) throw new HttpError(404, 'Introuvable.');
  return ok(row);
});

async function hashPasswordInput(pwd) {
  if (typeof pwd !== 'string' || !pwd) throw new HttpError(400, 'Le mot de passe est obligatoire.');
  return db.hashPassword(pwd);
}
async function otherActivePrincipals(client, excludeId) {
  const r = await client.query("SELECT count(*)::int AS n FROM utilisateurs WHERE role = 'admin_principal' AND actif AND id <> $1", [excludeId]);
  return r.rows[0].n;
}

route('POST', '/api/data/:table', async (ctx) => {
  const spec = tableOf(ctx);
  need(ctx.user, WRITE_RIGHT[spec.api]);
  const body = ctx.body || {};
  const extraCols = {};
  if (spec.api === 'users') extraCols.password_hash = await hashPasswordInput(body.motDePasse);
  const { result, versions } = await db.withTables([spec.api], async (client) => {
    const id = await db.insertRow(client, spec, body, extraCols);
    return { id, row: await db.getRow(spec, id, client) };
  });
  if (spec.api === 'users') invalidateUsers();
  return { status: 201, body: { ...result, v: versions[spec.api] } };
});

route('POST', '/api/data/:table/bulk', async (ctx) => {
  const spec = tableOf(ctx);
  need(ctx.user, WRITE_RIGHT[spec.api]);
  if (spec.api === 'users') throw new HttpError(400, 'Opération non prise en charge.');
  const rows = Array.isArray(ctx.body && ctx.body.rows) ? ctx.body.rows : null;
  if (!rows) throw new HttpError(400, 'Corps invalide : { rows: [...] } attendu.');
  const { result, versions } = await db.withTables([spec.api], async (client) => {
    if (spec.numbered) { const ids = []; for (const r of rows) ids.push(await db.insertRow(client, spec, r)); return ids; }
    return db.insertMany(client, spec, rows);
  });
  return { status: 201, body: { ids: result, v: versions[spec.api] } };
});

route('POST', '/api/data/:table/batch-patch', async (ctx) => {
  const spec = tableOf(ctx);
  need(ctx.user, WRITE_RIGHT[spec.api]);
  if (spec.api === 'users') throw new HttpError(400, 'Opération non prise en charge.');
  const patches = Array.isArray(ctx.body && ctx.body.patches) ? ctx.body.patches : null;
  if (!patches) throw new HttpError(400, 'Corps invalide : { patches: [...] } attendu.');
  const { result, versions } = await db.withTables([spec.api], async (client) => {
    const rows = [];
    for (const p of patches) {
      const id = parseId(spec, p.id);
      if (await db.updateRow(client, spec, id, p.changes || {})) rows.push(await db.getRow(spec, id, client));
    }
    return rows;
  });
  return ok({ rows: result, v: versions[spec.api] });
});

route('POST', '/api/data/:table/bulk-delete', async (ctx) => {
  const spec = tableOf(ctx);
  need(ctx.user, DELETE_RIGHT[spec.api]);
  if (spec.api === 'users') throw new HttpError(400, 'Opération non prise en charge.');
  const ids = Array.isArray(ctx.body && ctx.body.ids) ? ctx.body.ids.map((i) => parseId(spec, i)) : null;
  if (!ids) throw new HttpError(400, 'Corps invalide : { ids: [...] } attendu.');
  const { result, versions } = await db.withTables([spec.api], (client) => db.deleteRows(client, spec, ids));
  return ok({ count: result, v: versions[spec.api] });
});

route('POST', '/api/data/:table/clear', async (ctx) => {
  const spec = tableOf(ctx);
  if (['users', 'membres', 'cellules', 'sections', 'quartiers'].includes(spec.api)) throw new HttpError(405, 'Opération non prise en charge.');
  need(ctx.user, DELETE_RIGHT[spec.api]);
  const { result, versions } = await db.withTables([spec.api], (client) => db.clearTable(client, spec));
  return ok({ count: result, v: versions[spec.api] });
});

route('PATCH', '/api/data/:table/:id', async (ctx) => {
  const spec = tableOf(ctx);
  need(ctx.user, WRITE_RIGHT[spec.api]);
  const id = parseId(spec, ctx.params.id);
  const changes = ctx.body || {};
  let newHash = null;
  if (spec.api === 'users' && typeof changes.motDePasse === 'string' && changes.motDePasse) newHash = await db.hashPassword(changes.motDePasse);
  const { result, versions } = await db.withTables([spec.api], async (client) => {
    if (spec.api === 'users') {
      const cur = (await client.query('SELECT role, actif FROM utilisateurs WHERE id = $1', [id])).rows[0];
      if (!cur) return null;
      const leavesPrincipal = cur.role === 'admin_principal' && cur.actif &&
        (('role' in changes && changes.role !== 'admin_principal') || ('actif' in changes && !changes.actif));
      if (leavesPrincipal && (await otherActivePrincipals(client, id)) === 0) {
        throw new HttpError(409, 'Le compte administrateur principal est protégé : il ne peut être ni rétrogradé ni désactivé.', 'ConstraintError');
      }
      if (newHash) await client.query('UPDATE utilisateurs SET password_hash = $1 WHERE id = $2', [newHash, id]);
    }
    const found = await db.updateRow(client, spec, id, changes);
    return found ? { row: await db.getRow(spec, id, client) } : null;
  });
  if (spec.api === 'users') invalidateUsers();
  if (!result) throw new HttpError(404, 'Introuvable.');
  return ok({ ...result, v: versions[spec.api] });
});

// Équivalent de put() pour la table des styles de couches (clé = niveau).
route('PUT', '/api/data/:table/:id', async (ctx) => {
  const spec = tableOf(ctx);
  if (!spec.textPk) throw new HttpError(405, 'Opération non prise en charge.');
  need(ctx.user, WRITE_RIGHT[spec.api]);
  const id = parseId(spec, ctx.params.id);
  const { versions } = await db.withTables([spec.api], (client) => db.upsertStyle(client, spec, { ...(ctx.body || {}), [spec.pk]: id }));
  return ok({ id, v: versions[spec.api] });
});

route('DELETE', '/api/data/:table/:id', async (ctx) => {
  const spec = tableOf(ctx);
  need(ctx.user, DELETE_RIGHT[spec.api]);
  const id = parseId(spec, ctx.params.id);
  const { result, versions } = await db.withTables([spec.api], async (client) => {
    if (spec.api === 'users') {
      if (id === ctx.user.id) throw new HttpError(409, 'Vous ne pouvez pas supprimer votre propre compte.', 'ConstraintError');
      const cur = (await client.query('SELECT role, actif FROM utilisateurs WHERE id = $1', [id])).rows[0];
      if (cur && cur.role === 'admin_principal' && cur.actif && (await otherActivePrincipals(client, id)) === 0) {
        throw new HttpError(409, 'Le compte administrateur principal est protégé : il ne peut pas être supprimé.', 'ConstraintError');
      }
    }
    return db.deleteRows(client, spec, [id]);
  });
  if (spec.api === 'users') invalidateUsers();
  return ok({ count: result, v: versions[spec.api] });
});

// --- Interface (dossier public/) ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
async function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return send(req, res, 400, 'Requête invalide.', { 'Content-Type': 'text/plain; charset=utf-8' }); }
  if (rel.includes('\0')) return send(req, res, 400, 'Requête invalide.', { 'Content-Type': 'text/plain; charset=utf-8' });
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return send(req, res, 403, 'Accès refusé.', { 'Content-Type': 'text/plain; charset=utf-8' });
  let st;
  try { st = await fs.promises.stat(file); } catch { return send(req, res, 404, 'Page introuvable.', { 'Content-Type': 'text/plain; charset=utf-8' }); }
  if (!st.isFile()) return send(req, res, 404, 'Page introuvable.', { 'Content-Type': 'text/plain; charset=utf-8' });
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = { ETag: etag, 'Cache-Control': 'no-cache', 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' };
  if (req.headers['if-none-match'] === etag) return send(req, res, 304, null, headers);
  return send(req, res, 200, await fs.promises.readFile(file), headers);
}

// --- Erreurs -------------------------------------------------------------------------------------------------------
const CONSTRAINT_MESSAGES = {
  membres_numero_electeur_uq: "Doublon détecté : un membre avec ce numéro d'électeur existe déjà.",
  utilisateurs_identifiant_uq: 'Cet identifiant existe déjà.',
  quartiers_commune_nom_uq: 'Ce quartier existe déjà dans cette commune.',
  elections_scrutin_uq: 'Un scrutin de ce type, de cette année et de ce tour existe déjà.',
  bureaux_cle_uq: 'Ce bureau de vote existe déjà.',
};
function errorResponse(err, req) {
  if (err instanceof HttpError) return { status: err.status, body: { error: err.code || 'Error', message: err.message } };
  if (err && err.code === '23505') return { status: 409, body: { error: 'ConstraintError', message: CONSTRAINT_MESSAGES[err.constraint] || 'Doublon : cet enregistrement existe déjà.' } };
  if (err && err.code === '23503') return { status: 409, body: { error: 'ConstraintError', message: "Opération impossible : cet enregistrement est encore utilisé ailleurs, ou fait référence à un enregistrement inexistant." } };
  if (err && (err.code === '23514' || err.code === '23502' || (typeof err.code === 'string' && err.code.startsWith('22')))) {
    return { status: 400, body: { error: 'BadRequest', message: 'Valeur invalide pour ce champ.' } };
  }
  console.error('[erreur]', req.method, req.url, err);
  return { status: 500, body: { error: 'ServerError', message: 'Erreur interne du serveur.' } };
}

// --- Répartiteur de requêtes -----------------------------------------------------------------------------------------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    return send(req, res, 204, null, {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match',
      'Access-Control-Max-Age': '600',
    });
  }
  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Méthode non autorisée.', { 'Content-Type': 'text/plain; charset=utf-8' });
    return serveStatic(req, res, pathname);
  }
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  let matched = null; let params = {};
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(pathname);
    if (m) { matched = r; params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])); break; }
  }
  if (!matched) return send(req, res, 404, { error: 'NotFound', message: 'Route inconnue.' });
  const ctx = { req, res, params, query: url.searchParams, body: undefined, user: null };
  if (matched.auth) ctx.user = await authenticate(req);
  if (method === 'POST' || method === 'PATCH' || method === 'PUT') ctx.body = await readJson(req);
  const out = await matched.handler(ctx);
  return send(req, res, out.status, out.body, out.headers || {});
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const out = errorResponse(err, req);
      if (res.headersSent) return res.destroy();
      send(req, res, out.status, out.body).catch(() => res.destroy());
    });
  });
}

// --- Démarrage -----------------------------------------------------------------------------------------------------------
async function main() {
  await db.init();
  const server = createServer();
  server.keepAliveTimeout = 65000;                              // supérieur à celui des relais (Render / Netlify)
  server.listen(PORT, () => console.log(`[serveur] SGBD PASTEF Rufisque — http://localhost:${PORT} (${IS_PROD ? 'production' : 'développement'})`));
  const stop = () => {
    console.log('[serveur] arrêt…');
    server.close(() => db.pool.end().then(() => process.exit(0), () => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
if (require.main === module) {
  main().catch((e) => { console.error('[serveur] démarrage impossible :', e); process.exit(1); });
}
module.exports = { createServer, main };
