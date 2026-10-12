'use strict';
/* ============================================================================
   SYSPLANS — server.js
   API REST + logique serveur (Node.js / Express / PostgreSQL).

   - Authentification : mot de passe haché (bcrypt) + jeton JWT envoyé dans
     l'en-tête « Authorization: Bearer … » (fonctionne aussi bien quand
     l'interface est servie par ce serveur que quand elle est hébergée à part,
     par exemple sur Netlify).
   - Droits : les règles de l'application (administrateur, utilisateur
     responsable, utilisateur ; périmètre de visibilité ; clôture ; validation)
     sont appliquées ICI, côté serveur, et plus seulement dans le navigateur.
   - Photos : extraites des fiches et stockées dans la table « fichiers ».
   ============================================================================ */

try { require('dotenv').config({ quiet: true }); } catch (_) { /* dotenv facultatif en production */ }

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const { pool, initDb, transaction, TOUS_LES_MODULES, TOUS_LES_TYPES } = require('./db');

const PORT = Number(process.env.PORT || 3000);
const PROD = process.env.NODE_ENV === 'production';

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (PROD) { console.error('[server] JWT_SECRET est obligatoire en production (voir README.md).'); process.exit(1); }
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[server] JWT_SECRET absent : secret temporaire généré (les connexions seront perdues au redémarrage).');
}
const JWT_DUREE = process.env.JWT_DUREE || '12h';
/* Longueur minimale des mots de passe (abaissable temporairement pour migrer d'anciens comptes). */
const MDP_MIN = Math.max(4, Number(process.env.MOT_DE_PASSE_MIN || 6));

/* Régions → départements du Sénégal : sert à calculer le périmètre d'un
   utilisateur responsable (les mêmes données que l'interface). */
const SN_REGIONS = {
  'Dakar': ['Dakar', 'Guédiawaye', 'Pikine', 'Keur Massar', 'Rufisque'],
  'Thiès': ['Thiès', 'Mbour', 'Tivaouane'],
  'Diourbel': ['Diourbel', 'Mbacké', 'Bambey'],
  'Saint-Louis': ['Saint-Louis', 'Dagana', 'Podor'],
  'Louga': ['Louga', 'Kébémer', 'Linguère'],
  'Fatick': ['Fatick', 'Foundiougne', 'Gossas'],
  'Kaolack': ['Kaolack', 'Nioro du Rip', 'Guinguinéo'],
  'Kaffrine': ['Kaffrine', 'Birkelane', 'Koungheul', 'Malem Hodar'],
  'Matam': ['Matam', 'Kanel', 'Ranérou Ferlo'],
  'Tambacounda': ['Tambacounda', 'Bakel', 'Goudiry', 'Koumpentoum'],
  'Kédougou': ['Kédougou', 'Salémata', 'Saraya'],
  'Kolda': ['Kolda', 'Vélingara', 'Médina Yoro Foulah'],
  'Sédhiou': ['Sédhiou', 'Bounkiling', 'Goudomp'],
  'Ziguinchor': ['Ziguinchor', 'Bignona', 'Oussouye']
};

const PARAMETRES_AUTORISES = ['suiviChampsPerso', 'pvTypoExtras', 'pvTypoRemoved'];
const PHOTO_MAX_OCTETS = 3 * 1024 * 1024;

/* ----------------------------------------------------------------------------
   Utilitaires
   ---------------------------------------------------------------------------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const estPrincipal = (u) => u.role === 'admin';
const estAdminLike = (u) => u.role === 'admin' || u.responsable === true;
const texte = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const dateIso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

function journaliser(req, userId, action, entite, entiteId, detail) {
  pool.query(
    'INSERT INTO journal (user_id, action, entite, entite_id, detail, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [userId || null, action, entite || null, entiteId || null, detail ? String(detail).slice(0, 500) : null, req ? req.ip : null]
  ).catch((e) => console.error('[journal]', e.message));
}

/* Objet « utilisateur » tel que l'interface l'attend (sans mot de passe). */
function versUtilisateur(row) {
  const d = row.donnees || {};
  return {
    ...d,
    id: row.id,
    identifiant: row.identifiant,
    nom: row.nom,
    role: row.role,
    responsable: row.responsable,
    actif: row.actif,
    affectation: row.affectation,
    assignation: row.assignation,
    creePar: row.cree_par || undefined
  };
}

/* ----------------------------------------------------------------------------
   Application Express
   ---------------------------------------------------------------------------- */
const app = express();
app.set('trust proxy', 1); // Render / Netlify placent le serveur derrière un proxy
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: false,                          // l'interface utilise des scripts/styles en ligne
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // les photos doivent pouvoir s'afficher depuis Netlify
  crossOriginEmbedderPolicy: false
}));
app.use(compression());

const originesAutorisees = (process.env.CORS_ORIGINS || '')
  .split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
app.use('/api', cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                  // même origine, curl, health checks…
    cb(null, originesAutorisees.includes(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));

app.use(express.json({ limit: process.env.JSON_LIMIT || '30mb' }));

/* ----------------------------------------------------------------------------
   Authentification
   ---------------------------------------------------------------------------- */
const limiteurConnexion = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LOGIN_MAX || 20),
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erreur: 'Trop de tentatives de connexion. Réessayez dans quelques minutes.' }
});

function signer(row) {
  return jwt.sign({ sub: row.id, v: row.jeton_version }, JWT_SECRET, { expiresIn: JWT_DUREE });
}

const HASH_FACTICE = bcrypt.hashSync('mot-de-passe-factice', 10); // temps de réponse constant

app.post('/api/auth/login', limiteurConnexion, asyncH(async (req, res) => {
  const identifiant = texte(req.body && req.body.identifiant, 120);
  const motDePasse = typeof (req.body && req.body.motDePasse) === 'string' ? req.body.motDePasse : '';
  if (!identifiant || !motDePasse) throw new HttpError(400, 'Saisissez votre identifiant et votre mot de passe.');

  const { rows } = await pool.query('SELECT * FROM utilisateurs WHERE lower(identifiant) = lower($1)', [identifiant]);
  const row = rows[0];
  const ok = await bcrypt.compare(motDePasse, row ? row.mot_de_passe_hash : HASH_FACTICE);
  if (!row || !ok) {
    journaliser(req, row && row.id, 'connexion_echec', 'utilisateur', row && row.id, identifiant);
    throw new HttpError(401, 'Identifiant ou mot de passe incorrect.');
  }
  if (!row.actif) throw new HttpError(403, 'Ce compte est désactivé. Contactez un administrateur.');

  journaliser(req, row.id, 'connexion', 'utilisateur', row.id);
  res.json({ token: signer(row), utilisateur: versUtilisateur(row) });
}));

async function exigerConnexion(req, res, next) {
  try {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) throw new HttpError(401, 'Authentification requise.');
    let payload;
    try { payload = jwt.verify(m[1], JWT_SECRET); }
    catch (_) { throw new HttpError(401, 'Session expirée. Reconnectez-vous.'); }
    const { rows } = await pool.query('SELECT * FROM utilisateurs WHERE id = $1', [payload.sub]);
    const u = rows[0];
    if (!u || !u.actif || u.jeton_version !== payload.v) throw new HttpError(401, 'Session invalide. Reconnectez-vous.');
    req.moi = u;
    next();
  } catch (e) { next(e); }
}

app.get('/api/auth/me', exigerConnexion, (req, res) => {
  res.json({ utilisateur: versUtilisateur(req.moi) });
});

app.post('/api/auth/mot-de-passe', exigerConnexion, asyncH(async (req, res) => {
  const actuel = typeof req.body.actuel === 'string' ? req.body.actuel : '';
  const nouveau = typeof req.body.nouveau === 'string' ? req.body.nouveau : '';
  if (!(await bcrypt.compare(actuel, req.moi.mot_de_passe_hash))) throw new HttpError(400, 'Le mot de passe actuel est incorrect.');
  if (nouveau.length < MDP_MIN) throw new HttpError(400, `Le nouveau mot de passe doit contenir au moins ${MDP_MIN} caractères.`);
  if (nouveau === actuel) throw new HttpError(400, 'Le nouveau mot de passe doit être différent de l\'actuel.');
  const hash = await bcrypt.hash(nouveau, 12);
  const { rows } = await pool.query(
    `UPDATE utilisateurs SET mot_de_passe_hash = $2, jeton_version = jeton_version + 1, modifie_le = now()
     WHERE id = $1 RETURNING *`, [req.moi.id, hash]);
  journaliser(req, req.moi.id, 'mot_de_passe_modifie', 'utilisateur', req.moi.id);
  res.json({ ok: true, token: signer(rows[0]) }); // l'ancien jeton n'est plus valable
}));

/* ----------------------------------------------------------------------------
   Périmètre de visibilité (identique à applyUserFilter de l'interface)
   ---------------------------------------------------------------------------- */
async function perimetre(client, moi) {
  if (estPrincipal(moi)) return { tout: true, ids: null };
  if (moi.responsable) {
    const regions = Array.isArray((moi.donnees || {}).zoneRegions) ? moi.donnees.zoneRegions : [];
    const deps = new Set();
    regions.forEach((r) => (SN_REGIONS[r] || []).forEach((d) => deps.add(d)));
    const { rows } = await client.query(
      'SELECT id FROM utilisateurs WHERE affectation <> \'\' AND affectation = ANY($1::text[])', [Array.from(deps)]);
    const ids = new Set(rows.map((r) => r.id));
    ids.add(moi.id);
    return { tout: false, ids: Array.from(ids) };
  }
  return { tout: false, ids: [moi.id] };
}
const voit = (p, row) => p.tout || p.ids.includes(row.cree_par) || p.ids.includes(row.attribue_a);

/* Valide le corps d'une synchronisation { upserts: [], deletes: [] }. */
function lireSync(body) {
  const upserts = Array.isArray(body && body.upserts) ? body.upserts : [];
  const deletes = Array.isArray(body && body.deletes) ? body.deletes : [];
  if (upserts.length > 2000 || deletes.length > 2000) throw new HttpError(413, 'Trop d\'éléments dans une même requête.');
  upserts.forEach((o) => {
    if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !o.id || o.id.length > 120) throw new HttpError(400, 'Élément invalide (identifiant manquant).');
  });
  return { upserts, deletes: deletes.filter((d) => typeof d === 'string') };
}

async function idsExistants(client, table, ids) {
  const uniques = Array.from(new Set(ids.filter(Boolean)));
  if (!uniques.length) return new Set();
  const { rows } = await client.query(`SELECT id FROM ${table} WHERE id = ANY($1::text[])`, [uniques]);
  return new Set(rows.map((r) => r.id));
}

/* ----------------------------------------------------------------------------
   Utilisateurs
   ---------------------------------------------------------------------------- */
app.get('/api/utilisateurs', exigerConnexion, asyncH(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM utilisateurs ORDER BY cree_le');
  res.json(rows.map(versUtilisateur));
}));

function validerPhotoProfil(photo) {
  if (!photo) return '';
  if (typeof photo !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(photo) || photo.length > 600000) {
    throw new HttpError(400, 'Photo de profil invalide ou trop lourde.');
  }
  return photo;
}

function donneesUtilisateur(u, role, responsable, ancien) {
  const d = {};
  const plein = role === 'admin' || responsable;
  d.typesAutorises = plein ? TOUS_LES_TYPES.slice()
    : (Array.isArray(u.typesAutorises) ? u.typesAutorises.filter((t) => TOUS_LES_TYPES.includes(t)) : (ancien.typesAutorises || []));
  d.modules = role === 'admin' ? TOUS_LES_MODULES.slice()
    : (Array.isArray(u.modules) ? u.modules.filter((m) => TOUS_LES_MODULES.includes(m)) : (ancien.modules || []));
  d.poste = responsable ? texte(u.poste, 160) : '';
  d.zoneNom = responsable ? texte(u.zoneNom, 160) : '';
  d.zoneRegions = responsable && Array.isArray(u.zoneRegions) ? u.zoneRegions.filter((r) => SN_REGIONS[r]) : [];
  d.photo = validerPhotoProfil(typeof u.photo === 'string' ? u.photo : (ancien.photo || ''));
  return d;
}

app.post('/api/utilisateurs/sync', exigerConnexion, asyncH(async (req, res) => {
  const moi = req.moi;
  const { upserts, deletes } = lireSync(req.body);

  await transaction(async (client) => {
    for (const u of upserts) {
      const { rows } = await client.query('SELECT * FROM utilisateurs WHERE id = $1 FOR UPDATE', [u.id]);
      const ex = rows[0];
      const identifiant = texte(u.identifiant, 120);
      const nom = texte(u.nom, 160);
      if (!identifiant || !nom) throw new HttpError(400, 'Le nom et l\'identifiant sont obligatoires.');

      const doublon = await client.query(
        'SELECT 1 FROM utilisateurs WHERE lower(identifiant) = lower($1) AND id <> $2', [identifiant, u.id]);
      if (doublon.rowCount) throw new HttpError(409, 'Cet identifiant est déjà utilisé.');

      let role, responsable, actif, affectation, assignation, creePar, donnees, hash = null;
      const motDePasse = typeof u.motDePasse === 'string' ? u.motDePasse : '';
      if (motDePasse && motDePasse.length < MDP_MIN) throw new HttpError(400, `Le mot de passe doit contenir au moins ${MDP_MIN} caractères.`);

      if (!ex) {
        /* ---- création ---- */
        if (!estAdminLike(moi)) throw new HttpError(403, 'Vous n\'avez pas le droit de créer des comptes.');
        role = u.role === 'admin' ? 'admin' : 'utilisateur';
        if (role === 'admin' && !estPrincipal(moi)) throw new HttpError(403, 'Seul un administrateur peut créer un compte administrateur.');
        responsable = role !== 'admin' && estPrincipal(moi) && u.responsable === true;
        actif = u.actif !== false;
        affectation = role === 'admin' ? 'administrateur_principal' : (responsable ? '' : texte(u.affectation, 120));
        assignation = (role === 'admin' || responsable) ? '' : texte(u.assignation, 60);
        creePar = moi.id;
        if (estPrincipal(moi) && typeof u.creePar === 'string') { // restauration d'une sauvegarde
          const ok = await idsExistants(client, 'utilisateurs', [u.creePar]);
          if (ok.has(u.creePar)) creePar = u.creePar;
        }
        donnees = donneesUtilisateur(u, role, responsable, {});
        /* Un compte importé sans mot de passe reçoit un secret aléatoire inutilisable :
           un administrateur devra lui en attribuer un. */
        hash = await bcrypt.hash(motDePasse || crypto.randomBytes(18).toString('hex'), 12);
      } else {
        /* ---- modification ---- */
        const soiMeme = ex.id === moi.id;
        const createur = ex.cree_par === moi.id;
        if (estPrincipal(moi)) {
          role = soiMeme ? 'admin' : (u.role === 'admin' ? 'admin' : 'utilisateur');
          actif = soiMeme ? true : u.actif !== false;
          responsable = role !== 'admin' && u.responsable === true;
        } else if (moi.responsable && createur && ex.role !== 'admin') {
          role = 'utilisateur'; responsable = false; actif = u.actif !== false;
        } else if (soiMeme) {
          /* Un utilisateur ordinaire ne peut changer que sa photo de profil. */
          role = ex.role; responsable = ex.responsable; actif = ex.actif;
          if (typeof u.photo === 'string') {
            const photo = validerPhotoProfil(u.photo);
            await client.query('UPDATE utilisateurs SET donnees = $2, modifie_le = now() WHERE id = $1',
              [ex.id, { ...(ex.donnees || {}), photo }]);
          }
          if (motDePasse) throw new HttpError(403, 'Utilisez « Modifier mon mot de passe ».');
          continue;
        } else {
          throw new HttpError(403, 'Vous n\'avez pas le droit de modifier ce compte.');
        }
        if (motDePasse) {
          if (!(estPrincipal(moi) || createur)) throw new HttpError(403, 'Seul le créateur du compte peut réinitialiser son mot de passe.');
          hash = await bcrypt.hash(motDePasse, 12);
        }
        affectation = role === 'admin' ? 'administrateur_principal' : (responsable ? '' : texte(u.affectation, 120));
        assignation = (role === 'admin' || responsable) ? '' : texte(u.assignation, 60);
        creePar = ex.cree_par;
        donnees = donneesUtilisateur(u, role, responsable, ex.donnees || {});
      }

      if (!ex) {
        await client.query(
          `INSERT INTO utilisateurs (id, identifiant, nom, mot_de_passe_hash, role, responsable, actif, affectation, assignation, cree_par, donnees)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [u.id, identifiant, nom, hash, role, responsable, actif, affectation, assignation, creePar, donnees]);
        journaliser(req, moi.id, 'utilisateur_cree', 'utilisateur', u.id, identifiant);
      } else {
        const desactive = ex.actif && !actif;
        await client.query(
          `UPDATE utilisateurs SET identifiant=$2, nom=$3, role=$4, responsable=$5, actif=$6, affectation=$7, assignation=$8,
                  donnees=$9, mot_de_passe_hash=COALESCE($10, mot_de_passe_hash),
                  jeton_version = jeton_version + $11, modifie_le = now()
           WHERE id = $1`,
          [u.id, identifiant, nom, role, responsable, actif, affectation, assignation, donnees, hash, (hash || desactive) ? 1 : 0]);
        journaliser(req, moi.id, 'utilisateur_modifie', 'utilisateur', u.id, identifiant + (hash ? ' (mot de passe)' : ''));
      }
    }

    for (const id of deletes) {
      if (!estPrincipal(moi)) throw new HttpError(403, 'Seul un administrateur peut supprimer un utilisateur.');
      if (id === moi.id) throw new HttpError(409, 'Vous ne pouvez pas supprimer votre propre compte.');
      const lie = await client.query('SELECT count(*)::int AS n FROM activites WHERE cree_par = $1', [id]);
      if (lie.rows[0].n > 0) throw new HttpError(409, 'Des activités sont rattachées à ce compte : suppression impossible.');
      await client.query('DELETE FROM utilisateurs WHERE id = $1', [id]);
      journaliser(req, moi.id, 'utilisateur_supprime', 'utilisateur', id);
    }
  });
  res.json({ ok: true });
}));

/* ----------------------------------------------------------------------------
   Catégories
   ---------------------------------------------------------------------------- */
function versCategorie(row) {
  return { ...(row.donnees || {}), id: row.id, intitule: row.intitule, actif: row.actif, creePar: row.cree_par || undefined };
}
app.get('/api/categories', exigerConnexion, asyncH(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM categories ORDER BY cree_le');
  res.json(rows.map(versCategorie));
}));
app.post('/api/categories/sync', exigerConnexion, asyncH(async (req, res) => {
  const moi = req.moi;
  const { upserts, deletes } = lireSync(req.body);
  if ((upserts.length || deletes.length) && !estAdminLike(moi)) throw new HttpError(403, 'Seul un administrateur peut gérer les catégories.');
  await transaction(async (client) => {
    const createurs = await idsExistants(client, 'utilisateurs', upserts.map((c) => c.creePar));
    for (const c of upserts) {
      const intitule = texte(c.intitule, 200);
      if (!intitule) throw new HttpError(400, 'L\'intitulé de la catégorie est obligatoire.');
      const { id, intitule: _i, actif, creePar, ...reste } = c;
      await client.query(
        `INSERT INTO categories (id, intitule, actif, cree_par, donnees)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE SET intitule = EXCLUDED.intitule, actif = EXCLUDED.actif, donnees = EXCLUDED.donnees, modifie_le = now()`,
        [id, intitule, actif !== false, createurs.has(creePar) ? creePar : moi.id, reste]);
    }
    for (const id of deletes) await client.query('DELETE FROM categories WHERE id = $1', [id]);
  });
  res.json({ ok: true });
}));

/* ----------------------------------------------------------------------------
   Activités
   ---------------------------------------------------------------------------- */
const RE_URL_FICHIER = /\/api\/fichiers\/([a-f0-9]{32})/;

/* Objet « activité » tel que l'interface l'attend : les photos redeviennent
   des adresses (dataUrl) pointant vers /api/fichiers/<clé>. */
function versActivite(row) {
  const a = { ...row.donnees, id: row.id };
  if (Array.isArray(a.photos)) {
    a.photos = a.photos.map((p) => (p && p.fichier
      ? { id: p.id, nom: p.nom || '', dataUrl: '/api/fichiers/' + p.fichier }
      : p));
  }
  return a;
}

app.get('/api/activites', exigerConnexion, asyncH(async (req, res) => {
  const p = await perimetre(pool, req.moi);
  const { rows } = p.tout
    ? await pool.query('SELECT id, donnees FROM activites ORDER BY date_activite NULLS LAST, cree_le')
    : await pool.query(
      'SELECT id, donnees FROM activites WHERE cree_par = ANY($1::text[]) OR attribue_a = ANY($1::text[]) ORDER BY date_activite NULLS LAST, cree_le',
      [p.ids]);
  res.json(rows.map(versActivite));
}));

/* Extrait les photos « data: » d'une activité vers la table fichiers. */
async function traiterPhotos(client, a, activiteId) {
  const photos = Array.isArray(a.photos) ? a.photos : [];
  const { rows: existantes } = await client.query('SELECT cle, photo_id FROM fichiers WHERE activite_id = $1', [activiteId]);
  const parCle = new Map(existantes.map((f) => [f.cle, f]));
  const parPhoto = new Map(existantes.map((f) => [f.photo_id, f.cle]));
  const resultat = [];
  const gardees = new Set();

  for (const p of photos) {
    if (!p || typeof p !== 'object') continue;
    const url = typeof p.dataUrl === 'string' ? p.dataUrl : '';
    const photoId = texte(p.id, 120) || crypto.randomBytes(6).toString('hex');
    const nom = texte(p.nom, 200);

    const m = RE_URL_FICHIER.exec(url);
    if (m) {                                           // photo déjà enregistrée
      if (parCle.has(m[1])) { resultat.push({ id: photoId, nom, fichier: m[1] }); gardees.add(m[1]); }
      continue;
    }
    const d = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(url);
    if (!d) continue;                                  // ni adresse connue ni image valide : ignorée
    if (parPhoto.has(photoId) && parCle.has(parPhoto.get(photoId))) {   // même photo renvoyée : pas de doublon
      const cle = parPhoto.get(photoId);
      resultat.push({ id: photoId, nom, fichier: cle }); gardees.add(cle);
      continue;
    }
    const contenu = Buffer.from(d[2], 'base64');
    if (!contenu.length || contenu.length > PHOTO_MAX_OCTETS) throw new HttpError(413, 'Une photo dépasse la taille autorisée (3 Mo).');
    const cle = crypto.randomBytes(16).toString('hex');
    await client.query(
      `INSERT INTO fichiers (cle, activite_id, photo_id, nom, mime, taille, contenu) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [cle, activiteId, photoId, nom, d[1], contenu.length, contenu]);
    resultat.push({ id: photoId, nom, fichier: cle }); gardees.add(cle);
  }
  /* Photos retirées de la fiche : on supprime aussi leur fichier. */
  const aSupprimer = existantes.map((f) => f.cle).filter((cle) => !gardees.has(cle));
  if (aSupprimer.length) await client.query('DELETE FROM fichiers WHERE cle = ANY($1::text[])', [aSupprimer]);
  return resultat;
}

app.post('/api/activites/sync', exigerConnexion, asyncH(async (req, res) => {
  const moi = req.moi;
  const { upserts, deletes } = lireSync(req.body);

  await transaction(async (client) => {
    const p = await perimetre(client, moi);
    const attribues = await idsExistants(client, 'utilisateurs', [moi.id, ...upserts.flatMap((a) => [a.creePar, a.attribueA])]);
    const categories = await idsExistants(client, 'categories', upserts.map((a) => a.categorieId));
    const adminLike = estAdminLike(moi);

    for (const entree of upserts) {
      if (!TOUS_LES_TYPES.includes(entree.type)) throw new HttpError(400, 'Type d\'activité invalide.');
      const { rows } = await client.query('SELECT * FROM activites WHERE id = $1 FOR UPDATE', [entree.id]);
      const ex = rows[0];
      const a = { ...entree };

      if (ex) {
        if (!voit(p, ex)) throw new HttpError(403, 'Vous n\'avez pas accès à cette activité.');
        if (ex.cloturee && !adminLike) throw new HttpError(403, 'Cette activité est clôturée : elle n\'est plus modifiable.');
        const avant = ex.donnees || {};
        a.creePar = avant.creePar;                       // le créateur ne change jamais
        if (!adminLike) {                                // clôture et validation : réservées aux administrateurs
          ['cloturee', 'clotureLe', 'clotureePar'].forEach((k) => { if (k in avant) a[k] = avant[k]; else delete a[k]; });
          if (ex.statut === 'en_attente' && a.statut !== 'en_attente') throw new HttpError(403, 'Seul un administrateur peut valider une activité.');
        }
      } else {
        if (!adminLike) {
          a.creePar = moi.id;
          const permis = (moi.donnees || {}).typesAutorises || [];
          if (!permis.includes(a.type)) throw new HttpError(403, 'Vous n\'êtes pas autorisé à créer ce type d\'activité.');
          delete a.cloturee; delete a.clotureLe; delete a.clotureePar;
        } else if (!attribues.has(a.creePar)) {
          a.creePar = moi.id;
        }
      }

      /* La fiche doit exister avant d'y rattacher ses photos (clé étrangère). */
      a.photos = [];
      const colonnes = [
        entree.id, a.type, texte(a.titre, 400), texte(a.statut, 40) || 'en_attente', dateIso(a.date),
        texte(a.departement, 120), texte(a.commune, 200), texte(a.zone, 300),
        attribues.has(a.creePar) ? a.creePar : null,
        attribues.has(a.attribueA) ? a.attribueA : null,
        categories.has(a.categorieId) ? a.categorieId : null,
        typeof a.issuDe === 'string' ? a.issuDe.slice(0, 120) : null,
        a.cloturee === true
      ];
      await client.query(
        `INSERT INTO activites (id, type, titre, statut, date_activite, departement, commune, zone, cree_par, attribue_a, categorie_id, issu_de, cloturee, donnees)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}'::jsonb)
         ON CONFLICT (id) DO UPDATE SET type=EXCLUDED.type, titre=EXCLUDED.titre, statut=EXCLUDED.statut,
           date_activite=EXCLUDED.date_activite, departement=EXCLUDED.departement, commune=EXCLUDED.commune, zone=EXCLUDED.zone,
           attribue_a=EXCLUDED.attribue_a, categorie_id=EXCLUDED.categorie_id, issu_de=EXCLUDED.issu_de,
           cloturee=EXCLUDED.cloturee, modifie_le=now()`,
        colonnes);

      a.photos = await traiterPhotos(client, entree, entree.id);
      a.id = entree.id;
      await client.query('UPDATE activites SET donnees = $2 WHERE id = $1', [entree.id, a]);
    }

    for (const id of deletes) {
      const { rows } = await client.query('SELECT * FROM activites WHERE id = $1', [id]);
      const ex = rows[0];
      if (!ex) continue;
      if (!voit(p, ex)) throw new HttpError(403, 'Vous n\'avez pas accès à cette activité.');
      if (ex.cloturee) throw new HttpError(403, 'Cette activité est clôturée : elle n\'est plus supprimable.');
      if (!adminLike && ex.cree_par !== moi.id) throw new HttpError(403, 'Seul le créateur ou un administrateur peut supprimer cette activité.');
      await client.query('DELETE FROM activites WHERE id = $1', [id]);
      journaliser(req, moi.id, 'activite_supprimee', 'activite', id, ex.titre);
    }
  });
  res.json({ ok: true });
}));

/* Photos : adresse non devinable (clé aléatoire de 128 bits), donc utilisable
   directement dans une balise <img> sans en-tête d'authentification. */
app.get('/api/fichiers/:cle', asyncH(async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.cle)) throw new HttpError(404, 'Fichier introuvable.');
  const { rows } = await pool.query('SELECT mime, contenu FROM fichiers WHERE cle = $1', [req.params.cle]);
  if (!rows[0]) throw new HttpError(404, 'Fichier introuvable.');
  res.set({
    'Content-Type': rows[0].mime,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff'
  });
  res.send(rows[0].contenu);
}));

/* ----------------------------------------------------------------------------
   Notifications (chacun ne voit que les siennes)
   ---------------------------------------------------------------------------- */
function versNotification(row) {
  return { ...(row.donnees || {}), id: row.id, userId: row.user_id, activityId: row.activite_id || undefined,
    message: row.message, date: new Date(row.date_notif).toISOString(), lue: row.lue };
}
app.get('/api/notifications', exigerConnexion, asyncH(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM notifications WHERE user_id = $1 ORDER BY date_notif', [req.moi.id]);
  res.json(rows.map(versNotification));
}));
app.post('/api/notifications/sync', exigerConnexion, asyncH(async (req, res) => {
  const moi = req.moi;
  const { upserts, deletes } = lireSync(req.body);
  await transaction(async (client) => {
    const destinataires = await idsExistants(client, 'utilisateurs', upserts.map((n) => n.userId));
    for (const n of upserts) {
      if (!destinataires.has(n.userId)) continue;
      const { id, userId, activityId, message, date, lue, ...reste } = n;
      const quand = date && !isNaN(new Date(date)) ? new Date(date) : new Date();
      const ex = await client.query('SELECT user_id FROM notifications WHERE id = $1', [id]);
      if (ex.rows[0] && ex.rows[0].user_id !== moi.id) continue;   // pas touche aux notifications des autres
      await client.query(
        `INSERT INTO notifications (id, user_id, activite_id, message, lue, date_notif, donnees)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET lue = EXCLUDED.lue, message = EXCLUDED.message`,
        [id, userId, typeof activityId === 'string' ? activityId : null, texte(message, 1000), lue === true, quand, reste]);
    }
    for (const id of deletes) await client.query('DELETE FROM notifications WHERE id = $1 AND user_id = $2', [id, moi.id]);
  });
  res.json({ ok: true });
}));

/* ----------------------------------------------------------------------------
   Paramètres partagés
   ---------------------------------------------------------------------------- */
app.get('/api/parametres/:cle', exigerConnexion, asyncH(async (req, res) => {
  if (!PARAMETRES_AUTORISES.includes(req.params.cle)) throw new HttpError(404, 'Paramètre inconnu.');
  const { rows } = await pool.query('SELECT valeur FROM parametres WHERE cle = $1', [req.params.cle]);
  res.json({ valeur: rows[0] ? rows[0].valeur : null });
}));
app.put('/api/parametres/:cle', exigerConnexion, asyncH(async (req, res) => {
  if (!PARAMETRES_AUTORISES.includes(req.params.cle)) throw new HttpError(404, 'Paramètre inconnu.');
  if (req.body === undefined || !('valeur' in req.body)) throw new HttpError(400, 'Valeur manquante.');
  await pool.query(
    `INSERT INTO parametres (cle, valeur, modifie_par) VALUES ($1,$2,$3)
     ON CONFLICT (cle) DO UPDATE SET valeur = EXCLUDED.valeur, modifie_par = EXCLUDED.modifie_par, modifie_le = now()`,
    [req.params.cle, JSON.stringify(req.body.valeur), req.moi.id]);
  res.json({ ok: true });
}));

/* Journal d'audit (administrateur principal). */
app.get('/api/journal', exigerConnexion, asyncH(async (req, res) => {
  if (!estPrincipal(req.moi)) throw new HttpError(403, 'Réservé à l\'administrateur.');
  const { rows } = await pool.query('SELECT * FROM journal ORDER BY date_evt DESC LIMIT 500');
  res.json(rows);
}));

/* Contrôle de santé (utilisé par Render pour savoir si le service répond). */
app.get('/api/sante', asyncH(async (req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true, heure: new Date().toISOString() });
}));

app.use('/api', (req, res) => res.status(404).json({ erreur: 'Route inconnue.' }));

/* ----------------------------------------------------------------------------
   Interface (dossier public/) + gestion des erreurs
   ---------------------------------------------------------------------------- */
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders(res, file) { if (/\.html$/.test(file)) res.set('Cache-Control', 'no-cache'); }
}));

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err && err.type === 'entity.too.large') err = new HttpError(413, 'Données trop volumineuses.');
  if (err && err.type === 'entity.parse.failed') err = new HttpError(400, 'Requête illisible.');
  const status = err.status || 500;
  if (status >= 500) console.error('[erreur]', err);
  res.status(status).json({ erreur: status >= 500 ? 'Erreur interne du serveur.' : err.message });
});

/* ----------------------------------------------------------------------------
   Démarrage
   ---------------------------------------------------------------------------- */
async function demarrer() {
  await initDb();
  const serveur = app.listen(PORT, () => console.log(`[server] SYSPLANS à l'écoute sur le port ${PORT}`));
  const arret = () => {
    console.log('[server] Arrêt en cours…');
    serveur.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', arret);
  process.on('SIGINT', arret);
}

if (require.main === module) {
  demarrer().catch((e) => { console.error('[server] Démarrage impossible :', e.message); process.exit(1); });
}

module.exports = { app, demarrer };
