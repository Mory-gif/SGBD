'use strict';
/* ==========================================================================
   db.js — connexion PostgreSQL, création des tables et accès aux données
   --------------------------------------------------------------------------
   Une seule description (TABLES) pilote :
     - la création du schéma (migration 1, idempotente, au démarrage) ;
     - la conversion ligne SQL  <->  objet JavaScript attendu par l'interface.
   Les colonnes sont typées (dates en DATE, horodatages en TIMESTAMPTZ,
   listes et géométries en JSONB), avec clés étrangères, contraintes
   d'unicité et index. Une colonne "extra" (JSONB) conserve sans perte toute
   propriété que l'interface ajouterait un jour sans colonne dédiée.
   ========================================================================== */
const crypto = require('crypto');
const { promisify } = require('util');
const { Pool, types } = require('pg');

// --- Lecture des types PostgreSQL sous la forme attendue par l'interface ----
types.setTypeParser(1082, (v) => v);                              // DATE -> 'AAAA-MM-JJ'
types.setTypeParser(1184, (v) => new Date(v).toISOString());      // TIMESTAMPTZ -> ISO
types.setTypeParser(20, (v) => parseInt(v, 10));                  // BIGINT -> nombre
types.setTypeParser(1700, (v) => parseFloat(v));                  // NUMERIC -> nombre

function sslOption(url) {
  const flag = String(process.env.DATABASE_SSL || '').toLowerCase();
  if (flag === 'true' || flag === '1') return { rejectUnauthorized: false };
  if (flag === 'false' || flag === '0') return false;
  return /sslmode=(require|verify)/i.test(url || '') ? { rejectUnauthorized: false } : false;
}

const DATABASE_URL = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL || 'postgresql://localhost:5432/sgbd_pastef_rufisque';
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: sslOption(DATABASE_URL),
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});
pool.on('error', (e) => console.error('[pg] erreur sur une connexion inactive :', e.message));

// --- Mots de passe : scrypt (intégré à Node), jamais stockés en clair ----------
const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const scryptOpts = (N, r, p) => ({ N, r, p, maxmem: 256 * N * r });
async function hashPassword(motDePasse) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const key = await scrypt(String(motDePasse), salt, keylen, scryptOpts(N, r, p));
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(motDePasse, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(String(motDePasse), Buffer.from(salt, 'base64'), expected.length, scryptOpts(+N, +r, +p));
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

// --- Description des tables --------------------------------------------------
// Types de colonne :
//   text  TEXT NOT NULL DEFAULT ''        textn  TEXT (NULL -> propriété absente)
//   int   INTEGER NOT NULL DEFAULT 0      fk     INTEGER (NULL -> null)
//   num   DOUBLE NOT NULL DEFAULT 0       numn   DOUBLE (NULL -> absente)
//   bool  BOOLEAN (NULL -> absente)       boolt  BOOLEAN NOT NULL DEFAULT true
//   date  DATE ('' <-> NULL)              ts     TIMESTAMPTZ (NULL -> absente)
//   tsnow TIMESTAMPTZ NOT NULL DEFAULT now()
//   json  JSONB (NULL -> null)            jsonn  JSONB (NULL -> absente)
//   jsonarr JSONB NOT NULL DEFAULT '[]'
const ROLES_COMMUNS = [
  'tresorierGeneralId', 'secretaireGeneralId', 'secretaireGeneralAdjointId',
  'commissionFinanceId', 'commissionCommunicationId', 'commissionMassificationId',
  'responsableJeunesId', 'responsableFemmesId', 'responsableEnseignantsId',
];
const fk = (props) => props.map((p) => [p, 'fk']);

const TABLES = {
  users: {
    sql: 'utilisateurs', pk: 'id', photo: { table: 'photos_utilisateurs', col: 'utilisateur_id', kind: 'users' },
    cols: [['identifiant', 'text'], ['role', 'text'], ['actif', 'boolt'], ['modules', 'jsonn'],
      ['derniereConnexion', 'ts'], ['createdAt', 'tsnow']],
  },
  membres: {
    sql: 'membres', pk: 'id', numbered: true, photo: { table: 'photos_membres', col: 'membre_id', kind: 'membres' },
    cols: [['numero', 'int'], ['reference', 'text'], ['nom', 'text'], ['prenom', 'text'],
      ['dateNaissance', 'date'], ['lieuNaissance', 'text'], ['sexe', 'text'], ['zoneElectorale', 'text'],
      ['departement', 'text'], ['commune', 'text'], ['quartierVillage', 'text'], ['telephone', 'text'], ['email', 'text'],
      ['dateDelivranceCNI', 'date'], ['dateExpirationCNI', 'date'],
      ['electeur', 'text'], ['communeVote', 'text'], ['numeroElecteur', 'text'], ['lieuVote', 'text'], ['bureauVote', 'text'],
      ['adhesion', 'text'], ['dateAdhesion', 'text'], ['carteMembre', 'text'], ['numeroCarteMembre', 'text'],
      ['fonction', 'text'], ['mouvements', 'jsonarr'], ['celluleId', 'fk'], ['sectionId', 'fk'],
      ['renouvellementTraiteLe', 'ts'], ['transfertTraiteLe', 'ts'], ['nonInscritTraiteLe', 'ts'],
      ['createdAt', 'tsnow'], ['updatedAt', 'tsnow']],
  },
  cellules: {
    sql: 'cellules', pk: 'id', numbered: true,
    cols: [['numero', 'int'], ['reference', 'text'], ['nom', 'text'], ['sectionId', 'fk'], ['quartierId', 'fk'],
      ['geometry', 'json'], ['contactResponsable', 'text'], ...fk(['responsableCelluleId', ...ROLES_COMMUNS]),
      ['createdAt', 'tsnow'], ['updatedAt', 'tsnow']],
  },
  sections: {
    sql: 'sections', pk: 'id', numbered: true,
    cols: [['numero', 'int'], ['reference', 'text'], ['nom', 'text'], ['contactResponsableSection', 'text'],
      ...fk(['responsableSectionId', ...ROLES_COMMUNS]), ['createdAt', 'tsnow'], ['updatedAt', 'tsnow']],
  },
  quartiers: {
    sql: 'quartiers', pk: 'id', numbered: true,
    cols: [['numero', 'int'], ['nom', 'text'], ['commune', 'text'], ['createdAt', 'tsnow']],
  },
  bureauxVote: {
    sql: 'bureaux_vote', pk: 'id',
    cols: [['cle', 'text'], ['zoneElectorale', 'text'], ['region', 'text'], ['departement', 'text'], ['commune', 'text'],
      ['lieuVote', 'text'], ['numeroBureau', 'text'], ['quartier', 'text'], ['inscrits', 'int'], ['celluleId', 'fk'],
      ['createdAt', 'tsnow'], ['updatedAt', 'tsnow']],
  },
  elections: {
    sql: 'elections', pk: 'id',
    cols: [['type', 'text'], ['annee', 'int'], ['tour', 'text'], ['libelle', 'text'], ['candidatReference', 'text'],
      ['createdAt', 'tsnow']],
  },
  depouillements: {
    sql: 'depouillements', pk: 'id',
    cols: [['electionId', 'fk'], ['bureauId', 'fk'], ['inscrits', 'int'], ['votants', 'int'], ['nuls', 'int'], ['exprimes', 'int']],
  },
  resultats: {
    sql: 'resultats', pk: 'id',
    cols: [['electionId', 'fk'], ['bureauId', 'fk'], ['candidat', 'text'], ['parti', 'text'], ['voix', 'int']],
  },
  couches: {
    sql: 'couches', pk: 'id',
    cols: [['niveau', 'text'], ['nom', 'text'], ['geometry', 'json'], ['createdAt', 'tsnow']],
  },
  stylesCouches: {
    sql: 'styles_couches', pk: 'niveau', textPk: true,
    cols: [['epaisseur', 'numn'], ['tirets', 'bool'], ['remplissage', 'bool'], ['opacite', 'numn'], ['etiquettes', 'bool'],
      ['tailleEtiquette', 'numn'], ['couleur', 'textn'], ['couleurFond', 'textn']],
  },
};

const snake = (p) => p.replace(/([a-z0-9])([A-Z]+)/g, '$1_$2').toLowerCase();
for (const [api, t] of Object.entries(TABLES)) {
  t.api = api;
  t.cols = t.cols.map(([prop, type]) => ({ prop, type, col: snake(prop) }));
  t.byProp = new Map(t.cols.map((c) => [c.prop, c]));
  t.pkCol = snake(t.pk);
}
const RESERVED = new Set(['id', 'extra', 'photoDataUrl', 'motDePasse', 'motDePasseHash', 'password_hash']);

// --- Conversion objet interface -> valeur SQL ------------------------------
function toSql(type, v) {
  switch (type) {
    case 'text': return v == null ? '' : String(v);
    case 'textn': return v == null ? null : String(v);
    case 'int': { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? 0 : Math.trunc(n); }
    case 'fk': { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) || n === 0 ? null : Math.trunc(n); }
    case 'num': { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? 0 : n; }
    case 'numn': { const n = Number(v); return v === '' || v == null || !Number.isFinite(n) ? null : n; }
    case 'bool': return v == null ? null : Boolean(v);
    case 'boolt': return v == null ? true : Boolean(v);
    case 'date': return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
    case 'ts':
    case 'tsnow': {
      if (v == null || v === '') return type === 'tsnow' ? new Date().toISOString() : null;
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? (type === 'tsnow' ? new Date().toISOString() : null) : d.toISOString();
    }
    case 'json': case 'jsonn': return v == null ? null : JSON.stringify(v);
    case 'jsonarr': return JSON.stringify(Array.isArray(v) ? v : []);
    default: throw new Error('type inconnu ' + type);
  }
}

// --- Conversion ligne SQL -> objet attendu par l'interface -------------------
let photoUrlFn = () => '';
function setPhotoUrlBuilder(fn) { photoUrlFn = fn; }

function fromRow(spec, row) {
  const o = {};
  o[spec.pk] = row[spec.pkCol];
  for (const { prop, type, col } of spec.cols) {
    const v = row[col];
    switch (type) {
      case 'textn': case 'numn': case 'bool': case 'ts': case 'jsonn': if (v != null) o[prop] = v; break;
      case 'date': o[prop] = v == null ? '' : v; break;
      case 'fk': case 'json': o[prop] = v == null ? null : v; break;
      default: o[prop] = v;
    }
  }
  if (row.extra) for (const [k, v] of Object.entries(row.extra)) if (!(k in o)) o[k] = v;
  if (spec.photo) o.photoDataUrl = row.photo_v ? photoUrlFn(spec.photo.kind, row[spec.pkCol], new Date(row.photo_v).getTime()) : '';
  return o;
}

function selectSql(spec, where = '') {
  if (!spec.photo) return `SELECT t.* FROM ${spec.sql} t ${where} ORDER BY t.${spec.pkCol}`;
  return `SELECT t.*, p.updated_at AS photo_v FROM ${spec.sql} t
          LEFT JOIN ${spec.photo.table} p ON p.${spec.photo.col} = t.${spec.pkCol} ${where} ORDER BY t.${spec.pkCol}`;
}

// Sépare un objet entrant en valeurs de colonnes + propriétés inconnues (extra).
function splitInput(spec, obj) {
  const vals = new Map();
  const extra = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const c = spec.byProp.get(k);
    if (c) vals.set(c, toSql(c.type, v));
    else if (!RESERVED.has(k)) extra[k] = v === undefined ? null : v;
  }
  if (spec.textPk && obj && obj[spec.pk] != null) vals.pkValue = String(obj[spec.pk]);
  return { vals, extra };
}

// Décode une photo envoyée par l'interface ("data:image/...;base64,...").
function parsePhoto(value) {
  if (value === '' || value === null) return { action: 'delete' };
  if (typeof value === 'string' && value.startsWith('data:')) {
    const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(value);
    if (!m) return { action: 'keep' };
    return { action: 'set', mime: m[1], data: Buffer.from(m[2], 'base64') };
  }
  return { action: 'keep' };            // URL déjà servie par l'API : inchangée
}
async function applyPhoto(client, spec, id, value) {
  if (!spec.photo || value === undefined) return;
  const p = parsePhoto(value);
  if (p.action === 'delete') {
    await client.query(`DELETE FROM ${spec.photo.table} WHERE ${spec.photo.col} = $1`, [id]);
  } else if (p.action === 'set') {
    await client.query(
      `INSERT INTO ${spec.photo.table} (${spec.photo.col}, mime, data, updated_at) VALUES ($1,$2,$3, clock_timestamp())
       ON CONFLICT (${spec.photo.col}) DO UPDATE SET mime = EXCLUDED.mime, data = EXCLUDED.data, updated_at = clock_timestamp()`,
      [id, p.mime, p.data]);
  }
}

// --- Transactions avec verrou de version par table ---------------------------
// Le verrou garantit qu'aucune autre écriture ne s'intercale : "avant" et
// "après" permettent au navigateur de mettre son cache à jour sans tout
// retélécharger quand il était à jour au départ.
async function withTables(names, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = {};
    for (const n of [...names].sort()) {
      const r = await client.query('SELECT version FROM sgbd_versions WHERE name = $1 FOR UPDATE', [n]);
      before[n] = r.rows[0] ? r.rows[0].version : 0;
    }
    const result = await fn(client);
    const versions = {};
    for (const n of names) {
      const r = await client.query('SELECT version FROM sgbd_versions WHERE name = $1', [n]);
      versions[n] = { before: before[n], after: r.rows[0] ? r.rows[0].version : 0 };
    }
    await client.query('COMMIT');
    return { result, versions };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* connexion perdue */ }
    throw e;
  } finally {
    client.release();
  }
}

async function getVersion(apiName) {
  const r = await pool.query('SELECT version FROM sgbd_versions WHERE name = $1', [apiName]);
  return r.rows[0] ? r.rows[0].version : 0;
}

// --- Lectures ---------------------------------------------------------------
async function listRows(spec) {
  const r = await pool.query(selectSql(spec));
  return r.rows.map((row) => fromRow(spec, row));
}
async function getRow(spec, id, client = pool) {
  const r = await client.query(selectSql(spec, `WHERE t.${spec.pkCol} = $1`), [id]);
  return r.rows[0] ? fromRow(spec, r.rows[0]) : null;
}

// --- Écritures ----------------------------------------------------------------
async function nextNumero(client, spec) {
  const r = await client.query(`SELECT COALESCE(MAX(numero), 0) + 1 AS n FROM ${spec.sql}`);
  return r.rows[0].n;
}

async function insertRow(client, spec, obj, extraCols = {}) {
  const { vals, extra } = splitInput(spec, obj);
  const cols = []; const params = []; const ph = [];
  const push = (col, val, cast = '') => { params.push(val); cols.push(col); ph.push(`$${params.length}${cast}`); };
  for (const [c, v] of vals) push(c.col, v, ['json', 'jsonn', 'jsonarr'].includes(c.type) ? '::jsonb' : '');
  for (const [col, v] of Object.entries(extraCols)) push(col, v);
  if (spec.textPk) push(spec.pkCol, vals.pkValue);
  if (spec.numbered) {
    const given = vals.get(spec.byProp.get('numero'));
    const clash = given ? (await client.query(`SELECT 1 FROM ${spec.sql} WHERE numero = $1`, [given])).rowCount : 1;
    if (clash) {
      const n = await nextNumero(client, spec);
      const i = cols.indexOf('numero');
      if (i >= 0) params[i] = n; else push('numero', n);
    }
  }
  const stripped = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== null));
  if (Object.keys(stripped).length) push('extra', JSON.stringify(stripped), '::jsonb');
  const sql = cols.length
    ? `INSERT INTO ${spec.sql} (${cols.join(',')}) VALUES (${ph.join(',')}) RETURNING ${spec.pkCol}`
    : `INSERT INTO ${spec.sql} DEFAULT VALUES RETURNING ${spec.pkCol}`;
  const r = await client.query(sql, params);
  const id = r.rows[0][spec.pkCol];
  await applyPhoto(client, spec, id, obj && obj.photoDataUrl);
  return id;
}

async function insertMany(client, spec, rows) {
  // Insertion en lots (cartes électorales de plusieurs milliers de bureaux).
  const ids = [];
  const colDefs = spec.cols;
  const per = colDefs.length + 1;
  const chunk = Math.max(1, Math.floor(30000 / per));
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params = []; const tuples = [];
    for (const obj of part) {
      const { vals, extra } = splitInput(spec, obj);
      const t = [];
      for (const c of colDefs) {
        let v;
        if (vals.has(c)) v = vals.get(c);
        else v = toSql(c.type, undefined);
        params.push(v);
        t.push(`$${params.length}${['json', 'jsonn', 'jsonarr'].includes(c.type) ? '::jsonb' : ''}`);
      }
      const stripped = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== null));
      params.push(Object.keys(stripped).length ? JSON.stringify(stripped) : null);
      t.push(`$${params.length}::jsonb`);
      tuples.push(`(${t.join(',')})`);
    }
    const sql = `INSERT INTO ${spec.sql} (${colDefs.map((c) => c.col).join(',')}, extra) VALUES ${tuples.join(',')} RETURNING ${spec.pkCol}`;
    const r = await client.query(sql, params);
    for (const row of r.rows) ids.push(row[spec.pkCol]);
  }
  return ids;
}

async function updateRow(client, spec, id, changes) {
  const { vals, extra } = splitInput(spec, changes);
  const sets = []; const params = [];
  for (const [c, v] of vals) {
    params.push(v);
    sets.push(`${c.col} = $${params.length}${['json', 'jsonn', 'jsonarr'].includes(c.type) ? '::jsonb' : ''}`);
  }
  if (Object.keys(extra).length) {
    params.push(JSON.stringify(extra));
    sets.push(`extra = NULLIF(jsonb_strip_nulls(COALESCE(extra, '{}'::jsonb) || $${params.length}::jsonb), '{}'::jsonb)`);
  }
  let found = true;
  if (sets.length) {
    params.push(id);
    const r = await client.query(`UPDATE ${spec.sql} SET ${sets.join(', ')} WHERE ${spec.pkCol} = $${params.length}`, params);
    found = r.rowCount > 0;
  } else {
    const r = await client.query(`SELECT 1 FROM ${spec.sql} WHERE ${spec.pkCol} = $1`, [id]);
    found = r.rowCount > 0;
  }
  if (found) await applyPhoto(client, spec, id, changes && changes.photoDataUrl);
  return found;
}

// Équivalent de Dexie put() pour la table des styles (clé = niveau).
async function upsertStyle(client, spec, obj) {
  const { vals, extra } = splitInput(spec, obj);
  const cols = [spec.pkCol]; const params = [String(obj[spec.pk])]; const upd = [];
  for (const c of spec.cols) {
    cols.push(c.col); params.push(vals.has(c) ? vals.get(c) : null);
    upd.push(`${c.col} = EXCLUDED.${c.col}`);
  }
  const stripped = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== null));
  cols.push('extra'); params.push(Object.keys(stripped).length ? JSON.stringify(stripped) : null); upd.push('extra = EXCLUDED.extra');
  const ph = params.map((_, i) => `$${i + 1}${cols[i] === 'extra' ? '::jsonb' : ''}`);
  await client.query(
    `INSERT INTO ${spec.sql} (${cols.join(',')}) VALUES (${ph.join(',')}) ON CONFLICT (${spec.pkCol}) DO UPDATE SET ${upd.join(', ')}`, params);
  return String(obj[spec.pk]);
}

async function deleteRows(client, spec, ids) {
  if (!ids.length) return 0;
  const r = await client.query(`DELETE FROM ${spec.sql} WHERE ${spec.pkCol} = ANY($1)`, [ids]);
  return r.rowCount;
}
async function clearTable(client, spec) {
  const r = await client.query(`DELETE FROM ${spec.sql}`);
  return r.rowCount;
}

// --- Schéma (migrations) -------------------------------------------------------
const SQL_TYPE = {
  text: "text NOT NULL DEFAULT ''", textn: 'text', int: 'integer NOT NULL DEFAULT 0', fk: 'integer',
  num: 'double precision NOT NULL DEFAULT 0', numn: 'double precision', bool: 'boolean', boolt: 'boolean NOT NULL DEFAULT true',
  date: 'date', ts: 'timestamptz', tsnow: 'timestamptz NOT NULL DEFAULT now()',
  json: 'jsonb', jsonn: 'jsonb', jsonarr: "jsonb NOT NULL DEFAULT '[]'::jsonb",
};

function createTableSql(spec) {
  const lines = [];
  lines.push(spec.textPk ? `${spec.pkCol} text PRIMARY KEY` : `${spec.pkCol} serial PRIMARY KEY`);
  if (spec.api === 'users') lines.push('password_hash text NOT NULL');
  for (const c of spec.cols) lines.push(`${c.col} ${SQL_TYPE[c.type]}`);
  lines.push('extra jsonb');
  return `CREATE TABLE IF NOT EXISTS ${spec.sql} (\n  ${lines.join(',\n  ')}\n)`;
}

function addConstraint(table, name, definition) {
  return `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}') THEN
      ALTER TABLE ${table} ADD CONSTRAINT ${name} ${definition};
    END IF; END $$`;
}

function migration1() {
  const sql = [];
  sql.push(`CREATE TABLE IF NOT EXISTS sgbd_versions (name text PRIMARY KEY, version bigint NOT NULL DEFAULT 0)`);
  sql.push(`CREATE OR REPLACE FUNCTION sgbd_bump() RETURNS trigger AS $f$
    BEGIN
      INSERT INTO sgbd_versions (name, version) VALUES (TG_ARGV[0], 1)
      ON CONFLICT (name) DO UPDATE SET version = sgbd_versions.version + 1;
      RETURN NULL;
    END $f$ LANGUAGE plpgsql`);
  for (const spec of Object.values(TABLES)) sql.push(createTableSql(spec));
  // Photos : stockées à part (octets), servies par URL signée, pas dans les listes.
  sql.push(`CREATE TABLE IF NOT EXISTS photos_membres (
    membre_id integer PRIMARY KEY REFERENCES membres(id) ON DELETE CASCADE,
    mime text NOT NULL, data bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
  sql.push(`CREATE TABLE IF NOT EXISTS photos_utilisateurs (
    utilisateur_id integer PRIMARY KEY REFERENCES utilisateurs(id) ON DELETE CASCADE,
    mime text NOT NULL, data bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp())`);

  const roleCols = (props) => props.map((p) => snake(p));
  const cellRoles = roleCols(['responsableCelluleId', ...ROLES_COMMUNS]);
  const sectRoles = roleCols(['responsableSectionId', ...ROLES_COMMUNS]);
  // Clés étrangères
  const fks = [
    ['membres', 'membres_cellule_fk', 'FOREIGN KEY (cellule_id) REFERENCES cellules(id) ON DELETE SET NULL'],
    ['membres', 'membres_section_fk', 'FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE SET NULL'],
    ['cellules', 'cellules_section_fk', 'FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE SET NULL'],
    ['cellules', 'cellules_quartier_fk', 'FOREIGN KEY (quartier_id) REFERENCES quartiers(id) ON DELETE RESTRICT'],
    ['bureaux_vote', 'bureaux_cellule_fk', 'FOREIGN KEY (cellule_id) REFERENCES cellules(id) ON DELETE SET NULL'],
    ['depouillements', 'depouillements_election_fk', 'FOREIGN KEY (election_id) REFERENCES elections(id) ON DELETE CASCADE'],
    ['depouillements', 'depouillements_bureau_fk', 'FOREIGN KEY (bureau_id) REFERENCES bureaux_vote(id) ON DELETE CASCADE'],
    ['resultats', 'resultats_election_fk', 'FOREIGN KEY (election_id) REFERENCES elections(id) ON DELETE CASCADE'],
    ['resultats', 'resultats_bureau_fk', 'FOREIGN KEY (bureau_id) REFERENCES bureaux_vote(id) ON DELETE CASCADE'],
  ];
  for (const c of cellRoles) fks.push(['cellules', `cellules_${c}_fk`, `FOREIGN KEY (${c}) REFERENCES membres(id) ON DELETE SET NULL`]);
  for (const c of sectRoles) fks.push(['sections', `sections_${c}_fk`, `FOREIGN KEY (${c}) REFERENCES membres(id) ON DELETE SET NULL`]);
  for (const [t, n, d] of fks) sql.push(addConstraint(t, n, d));

  // Contraintes de valeurs
  const checks = [
    ['utilisateurs', 'utilisateurs_identifiant_ck', "CHECK (identifiant <> '')"],
    ['utilisateurs', 'utilisateurs_role_ck', "CHECK (role IN ('admin_principal','admin_secondaire','utilisateur'))"],
    ['membres', 'membres_sexe_ck', "CHECK (sexe IN ('','M','F'))"],
    ['membres', 'membres_electeur_ck', "CHECK (electeur IN ('','Oui','Non'))"],
    ['membres', 'membres_carte_membre_ck', "CHECK (carte_membre IN ('','Oui','Non'))"],
    ['membres', 'membres_adhesion_ck', "CHECK (adhesion IN ('','Ancien','Nouveau'))"],
    ['bureaux_vote', 'bureaux_inscrits_ck', 'CHECK (inscrits >= 0)'],
    ['resultats', 'resultats_voix_ck', 'CHECK (voix >= 0)'],
  ];
  for (const [t, n, d] of checks) sql.push(addConstraint(t, n, d));

  // Unicité et index
  sql.push('CREATE UNIQUE INDEX IF NOT EXISTS utilisateurs_identifiant_uq ON utilisateurs (identifiant)');
  sql.push("CREATE UNIQUE INDEX IF NOT EXISTS membres_numero_electeur_uq ON membres (numero_electeur) WHERE numero_electeur <> ''");
  sql.push('CREATE UNIQUE INDEX IF NOT EXISTS membres_numero_uq ON membres (numero)');
  sql.push('CREATE UNIQUE INDEX IF NOT EXISTS cellules_numero_uq ON cellules (numero)');
  sql.push('CREATE UNIQUE INDEX IF NOT EXISTS sections_numero_uq ON sections (numero)');
  sql.push('CREATE UNIQUE INDEX IF NOT EXISTS quartiers_numero_uq ON quartiers (numero)');
  sql.push('CREATE UNIQUE INDEX IF NOT EXISTS quartiers_commune_nom_uq ON quartiers (commune, nom)');
  sql.push('CREATE UNIQUE INDEX IF NOT EXISTS bureaux_cle_uq ON bureaux_vote (cle)');
  sql.push('CREATE UNIQUE INDEX IF NOT EXISTS elections_scrutin_uq ON elections (type, annee, tour)');
  sql.push('CREATE UNIQUE INDEX IF NOT EXISTS depouillements_uq ON depouillements (election_id, bureau_id)');
  for (const [t, c] of [
    ['membres', 'cellule_id'], ['membres', 'section_id'], ['membres', 'commune'], ['membres', 'commune_vote'],
    ['membres', 'electeur'], ['membres', 'lieu_vote, bureau_vote'], ['membres', 'numero_carte_membre'],
    ['cellules', 'section_id'], ['cellules', 'quartier_id'], ['bureaux_vote', 'commune'], ['bureaux_vote', 'lieu_vote'],
    ['bureaux_vote', 'cellule_id'], ['resultats', 'election_id, bureau_id'], ['resultats', 'bureau_id'],
    ['depouillements', 'bureau_id'], ['couches', 'niveau'],
  ]) sql.push(`CREATE INDEX IF NOT EXISTS ${t}_${c.replace(/[^a-z_]+/g, '_')}_idx ON ${t} (${c})`);

  // Versions par table (validation du cache du navigateur)
  const bumped = Object.values(TABLES).map((t) => [t.sql, t.api]);
  for (const [sqlName, api] of bumped) {
    sql.push(`DROP TRIGGER IF EXISTS ${sqlName}_bump ON ${sqlName}`);
    sql.push(`CREATE TRIGGER ${sqlName}_bump AFTER INSERT OR UPDATE OR DELETE ON ${sqlName}
              FOR EACH STATEMENT EXECUTE FUNCTION sgbd_bump('${api}')`);
    sql.push(`INSERT INTO sgbd_versions (name, version) VALUES ('${api}', 0) ON CONFLICT (name) DO NOTHING`);
  }
  for (const [photoTable, api] of [['photos_membres', 'membres'], ['photos_utilisateurs', 'users']]) {
    sql.push(`DROP TRIGGER IF EXISTS ${photoTable}_bump ON ${photoTable}`);
    sql.push(`CREATE TRIGGER ${photoTable}_bump AFTER INSERT OR UPDATE OR DELETE ON ${photoTable}
              FOR EACH STATEMENT EXECUTE FUNCTION sgbd_bump('${api}')`);
  }
  return sql;
}

const MIGRATIONS = [{ id: 1, name: 'schema initial', statements: migration1 }];

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');       // un seul démarrage à la fois
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT id FROM schema_migrations')).rows.map((r) => r.id));
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      console.log(`[db] migration ${m.id} : ${m.name}`);
      await client.query('BEGIN');
      try {
        for (const stmt of m.statements()) await client.query(stmt);
        await client.query('INSERT INTO schema_migrations (id, name) VALUES ($1,$2)', [m.id, m.name]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(727001)'); } catch { /* ignore */ }
    client.release();
  }
}

async function seedAdmin() {
  const n = (await pool.query('SELECT count(*)::int AS n FROM utilisateurs')).rows[0].n;
  if (n > 0) return;
  const identifiant = process.env.ADMIN_USER || 'admin';
  const motDePasse = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = await hashPassword(motDePasse);
  await pool.query(
    "INSERT INTO utilisateurs (identifiant, password_hash, role, actif) VALUES ($1,$2,'admin_principal',true)",
    [identifiant, hash]);
  console.log(`[db] compte administrateur principal créé : "${identifiant}"`);
  if (!process.env.ADMIN_PASSWORD) {
    console.warn('[db] ATTENTION : mot de passe par défaut (admin123). Changez-le dès la première connexion ou définissez ADMIN_PASSWORD.');
  }
}

async function init() {
  let lastError;
  for (let i = 1; i <= 12; i++) {                                  // la base peut démarrer après le serveur
    try { await pool.query('SELECT 1'); lastError = null; break; }
    catch (e) { lastError = e; console.log(`[db] base indisponible (${e.message}) — nouvel essai ${i}/12`); await new Promise((r) => setTimeout(r, 5000)); }
  }
  if (lastError) throw lastError;
  await migrate();
  await seedAdmin();
  console.log('[db] base prête.');
}

module.exports = {
  pool, TABLES, init, withTables, getVersion, listRows, getRow, insertRow, insertMany, updateRow, upsertStyle,
  deleteRows, clearTable, fromRow, selectSql, setPhotoUrlBuilder, parsePhoto, hashPassword, verifyPassword,
  _internals: { toSql, splitInput, migration1 },
};
