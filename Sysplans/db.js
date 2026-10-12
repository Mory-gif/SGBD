'use strict';
/* ============================================================================
   SYSPLANS — db.js
   Connexion PostgreSQL + création / mise à jour automatique des tables.

   Modèle « hybride » : les données qui servent à filtrer, relier ou contrôler
   les droits (identifiants, rôles, dates, statuts, créateur, affectation…)
   sont de vraies colonnes typées avec clés étrangères et index ; le détail
   variable de chaque fiche (PV d'opération, logistique, géométries, champs
   propres à chaque type d'activité…) est conservé en JSONB dans la colonne
   « donnees », ce qui évite d'éclater le modèle en dizaines de tables tout en
   restant interrogeable en SQL (opérateurs JSONB, index GIN).
   ============================================================================ */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

if (!process.env.DATABASE_URL) {
  console.error('[db] Variable d\'environnement DATABASE_URL manquante (voir README.md).');
  process.exit(1);
}

/* SSL : activé par défaut pour une base distante (Render, Neon, Supabase…),
   désactivé pour une base locale. Forçable avec DATABASE_SSL=true|false. */
function sslConfig() {
  const forced = (process.env.DATABASE_SSL || '').toLowerCase();
  if (forced === 'false') return false;
  if (forced === 'true') return { rejectUnauthorized: false };
  return /@(localhost|127\.0\.0\.1|::1)(:|\/)/.test(process.env.DATABASE_URL)
    ? false
    : { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: sslConfig(),
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

pool.on('error', (err) => console.error('[db] Erreur inattendue sur une connexion inactive :', err.message));

/* ---------------------------------------------------------------------------
   Schéma. Chaque instruction est idempotente (IF NOT EXISTS) : on peut relancer
   le serveur autant de fois que nécessaire. Pour faire évoluer le schéma plus
   tard, ajoutez des ALTER TABLE ... ADD COLUMN IF NOT EXISTS à la fin de la liste.
   --------------------------------------------------------------------------- */
const SCHEMA = [
  /* Comptes utilisateurs. Le mot de passe n'est JAMAIS stocké en clair. */
  `CREATE TABLE IF NOT EXISTS utilisateurs (
     id              TEXT PRIMARY KEY,
     identifiant     TEXT NOT NULL,
     nom             TEXT NOT NULL,
     mot_de_passe_hash TEXT NOT NULL,
     role            TEXT NOT NULL DEFAULT 'utilisateur' CHECK (role IN ('admin','utilisateur')),
     responsable     BOOLEAN NOT NULL DEFAULT FALSE,
     actif           BOOLEAN NOT NULL DEFAULT TRUE,
     affectation     TEXT NOT NULL DEFAULT '',
     assignation     TEXT NOT NULL DEFAULT '',
     cree_par        TEXT REFERENCES utilisateurs(id) ON DELETE SET NULL,
     jeton_version   INTEGER NOT NULL DEFAULT 0,
     donnees         JSONB NOT NULL DEFAULT '{}'::jsonb,
     cree_le         TIMESTAMPTZ NOT NULL DEFAULT now(),
     modifie_le      TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS utilisateurs_identifiant_uq ON utilisateurs (lower(identifiant))`,

  /* Catégories d'activités. */
  `CREATE TABLE IF NOT EXISTS categories (
     id          TEXT PRIMARY KEY,
     intitule    TEXT NOT NULL,
     actif       BOOLEAN NOT NULL DEFAULT TRUE,
     cree_par    TEXT REFERENCES utilisateurs(id) ON DELETE SET NULL,
     donnees     JSONB NOT NULL DEFAULT '{}'::jsonb,
     cree_le     TIMESTAMPTZ NOT NULL DEFAULT now(),
     modifie_le  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  /* Activités (prospection, désencombrement, aménagement, suivi, événement). */
  `CREATE TABLE IF NOT EXISTS activites (
     id             TEXT PRIMARY KEY,
     type           TEXT NOT NULL CHECK (type IN ('prospection','desencombrement','amenagement','suivi','evenement')),
     titre          TEXT NOT NULL DEFAULT '',
     statut         TEXT NOT NULL DEFAULT 'en_attente',
     date_activite  DATE,
     departement    TEXT NOT NULL DEFAULT '',
     commune        TEXT NOT NULL DEFAULT '',
     zone           TEXT NOT NULL DEFAULT '',
     cree_par       TEXT REFERENCES utilisateurs(id) ON DELETE SET NULL,
     attribue_a     TEXT REFERENCES utilisateurs(id) ON DELETE SET NULL,
     categorie_id   TEXT REFERENCES categories(id) ON DELETE SET NULL,
     issu_de        TEXT,
     cloturee       BOOLEAN NOT NULL DEFAULT FALSE,
     donnees        JSONB NOT NULL,
     cree_le        TIMESTAMPTZ NOT NULL DEFAULT now(),
     modifie_le     TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS activites_cree_par_idx   ON activites (cree_par)`,
  `CREATE INDEX IF NOT EXISTS activites_attribue_a_idx ON activites (attribue_a)`,
  `CREATE INDEX IF NOT EXISTS activites_date_idx       ON activites (date_activite)`,
  `CREATE INDEX IF NOT EXISTS activites_statut_idx     ON activites (statut)`,
  `CREATE INDEX IF NOT EXISTS activites_type_idx       ON activites (type)`,
  `CREATE INDEX IF NOT EXISTS activites_donnees_gin    ON activites USING GIN (donnees jsonb_path_ops)`,

  /* Photos des activités : stockées à part (jamais dans le JSON des fiches)
     pour garder des listes d'activités légères. « cle » est un secret aléatoire
     de 128 bits qui sert d'adresse non devinable de l'image. */
  `CREATE TABLE IF NOT EXISTS fichiers (
     cle          TEXT PRIMARY KEY,
     activite_id  TEXT NOT NULL REFERENCES activites(id) ON DELETE CASCADE,
     photo_id     TEXT NOT NULL,
     nom          TEXT NOT NULL DEFAULT '',
     mime         TEXT NOT NULL,
     taille       INTEGER NOT NULL,
     contenu      BYTEA NOT NULL,
     cree_le      TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS fichiers_activite_idx ON fichiers (activite_id)`,

  /* Notifications destinées aux utilisateurs. */
  `CREATE TABLE IF NOT EXISTS notifications (
     id           TEXT PRIMARY KEY,
     user_id      TEXT NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
     activite_id  TEXT,
     message      TEXT NOT NULL DEFAULT '',
     lue          BOOLEAN NOT NULL DEFAULT FALSE,
     date_notif   TIMESTAMPTZ NOT NULL DEFAULT now(),
     donnees      JSONB NOT NULL DEFAULT '{}'::jsonb
   )`,
  `CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, lue)`,

  /* Paramètres partagés (champs personnalisés du formulaire Suivi, sous-types
     ajoutés / retirés dans la typologie du PV d'opération…). */
  `CREATE TABLE IF NOT EXISTS parametres (
     cle         TEXT PRIMARY KEY,
     valeur      JSONB NOT NULL,
     modifie_par TEXT,
     modifie_le  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  /* Journal d'audit : connexions, créations/suppressions de comptes, suppressions d'activités. */
  `CREATE TABLE IF NOT EXISTS journal (
     id         BIGSERIAL PRIMARY KEY,
     date_evt   TIMESTAMPTZ NOT NULL DEFAULT now(),
     user_id    TEXT,
     action     TEXT NOT NULL,
     entite     TEXT,
     entite_id  TEXT,
     detail     TEXT,
     ip         TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS journal_date_idx ON journal (date_evt DESC)`
];

const TOUS_LES_MODULES = ['cartographie', 'statistiques', 'suivi', 'suiviEval', 'pvOperation', 'live'];
const TOUS_LES_TYPES = ['prospection', 'desencombrement', 'amenagement', 'suivi', 'evenement'];

/* Mot de passe aléatoire lisible (pour le premier administrateur). */
function motDePasseAleatoire(longueur = 14) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const octets = crypto.randomBytes(longueur);
  let out = '';
  for (let i = 0; i < longueur; i++) out += alphabet[octets[i] % alphabet.length];
  return out;
}

/* Crée le compte administrateur initial si la table des utilisateurs est vide. */
async function creerAdministrateurInitial() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM utilisateurs');
  if (rows[0].n > 0) return;

  const identifiant = process.env.ADMIN_IDENTIFIANT || 'admin';
  let motDePasse = process.env.ADMIN_PASSWORD;
  let genere = false;
  if (!motDePasse) { motDePasse = motDePasseAleatoire(); genere = true; }

  const hash = await bcrypt.hash(motDePasse, 12);
  const donnees = {
    typesAutorises: TOUS_LES_TYPES,
    modules: TOUS_LES_MODULES,
    poste: '', zoneNom: '', zoneRegions: []
  };
  await pool.query(
    `INSERT INTO utilisateurs
       (id, identifiant, nom, mot_de_passe_hash, role, responsable, actif, affectation, assignation, donnees)
     VALUES ($1,$2,$3,$4,'admin',FALSE,TRUE,'administrateur_principal','',$5)`,
    ['usr_admin_' + crypto.randomBytes(4).toString('hex'), identifiant, 'Administrateur', hash, donnees]
  );

  console.log('==========================================================');
  console.log(' Premier démarrage : compte administrateur créé');
  console.log('   Identifiant  : ' + identifiant);
  if (genere) {
    console.log('   Mot de passe : ' + motDePasse + '   (affiché une seule fois !)');
    console.log(' Notez-le puis changez-le depuis l\'application.');
  } else {
    console.log('   Mot de passe : celui de la variable ADMIN_PASSWORD');
  }
  console.log('==========================================================');
}

/* Crée les tables puis le premier administrateur. Appelé au démarrage. */
async function initDb() {
  const client = await pool.connect();
  try {
    /* Verrou consultatif : si plusieurs instances démarrent en même temps,
       une seule applique le schéma. */
    await client.query('SELECT pg_advisory_lock(727274)');
    try {
      for (const sql of SCHEMA) await client.query(sql);
    } finally {
      await client.query('SELECT pg_advisory_unlock(727274)');
    }
  } finally {
    client.release();
  }
  await creerAdministrateurInitial();
  console.log('[db] Base de données prête.');
}

/* Petit utilitaire : exécute plusieurs requêtes dans une transaction. */
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, initDb, transaction, TOUS_LES_MODULES, TOUS_LES_TYPES };
