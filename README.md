# SGBD PASTEF Rufisque — guide de déploiement

Application de gestion (membres, cellules, sections, quartiers, carte électorale, élections, couches cartographiques) avec une vraie base **PostgreSQL**.

```
sgbd-pastef-rufisque/
├── server.js        → API REST + logique serveur (droits, authentification, fichiers statiques)
├── db.js            → connexion PostgreSQL + création / migration des tables
├── package.json     → une seule dépendance : pg
├── public/          → interface (index.html, style.css, app.js, api-client.js, config.js)
├── netlify/functions/api.mjs → l'API sous forme de fonction (Option 3 « Netlify seul » uniquement)
├── README.md        → ce guide
├── .env.example     ┐
├── render.yaml      │ fichiers ajoutés pour faciliter le déploiement
├── netlify.toml     │ (facultatifs)
└── .gitignore       ┘
```

L'interface est identique à l'ancien fichier HTML. Seule la couche de données a changé : au lieu d'IndexedDB (navigateur), `api-client.js` appelle l'API, qui lit et écrit dans PostgreSQL. Les données sont donc partagées entre tous les appareils et utilisateurs.

---

## 1. Comment ça marche

- Au démarrage, `db.js` se connecte à PostgreSQL et **crée toutes les tables** (opération rejouable sans risque, avec verrou pour éviter les conflits si plusieurs instances démarrent).
- Au premier démarrage, un compte **administrateur principal** est créé à partir de `ADMIN_USER` / `ADMIN_PASSWORD` (par défaut `admin` / `admin123`, avec un avertissement : changez-le).
- Connexion : `POST /api/login` renvoie un jeton signé (12 h par défaut). Les mots de passe sont hachés avec scrypt.
- Les droits sont **appliqués côté serveur** : administrateur principal (tout), administrateur (structure + données), utilisateur (selon ses droits de modification/suppression). Le dernier administrateur principal actif ne peut être ni supprimé, ni rétrogradé, ni désactivé.
- Les photos sont stockées dans PostgreSQL (tables `photos_membres`, `photos_utilisateurs`).

### Tables principales

`utilisateurs`, `membres`, `cellules`, `sections`, `quartiers`, `bureaux_vote`, `elections`, `depouillements`, `resultats`, `couches`, `styles_couches`, `photos_membres`, `photos_utilisateurs`, `sgbd_versions`, `schema_migrations`.
Clés étrangères, contraintes d'unicité (identifiant, numéro d'électeur, numéro de cellule…) et contrôles de valeurs sont définis dans `db.js`.

---

## 2. Lancer en local

Prérequis : Node.js 18+ et PostgreSQL.

```bash
createdb sgbd_pastef
npm install
export DATABASE_URL=postgres://postgres:motdepasse@localhost:5432/sgbd_pastef
export JWT_SECRET=une-longue-chaine-aleatoire
export ADMIN_USER=admin
export ADMIN_PASSWORD=UnMotDePasseSolide
npm start
```

Ouvrez http://localhost:3000. (Voir `.env.example` pour toutes les variables.)

---

## 3. Choisir son déploiement

| | Option 1 : **Render seul** | Option 2 : **Render + Netlify** | Option 3 : **Netlify seul** |
|---|---|---|---|
| Base PostgreSQL | Render | Render | PostgreSQL hébergée (Neon / Netlify DB, Supabase…) |
| API (`server.js`) | Render (serveur permanent) | Render (serveur permanent) | Netlify Function (`netlify/functions/api.mjs`) |
| Interface (`public/`) | servie par Render | servie par Netlify | servie par Netlify |
| Adresse d'accès | `…onrender.com` | `…netlify.app` | `…netlify.app` |
| Réglages en plus | aucun | `config.js` + `CORS_ORIGIN` | variables Netlify (§6), `config.js` inchangé |
| Limites | service endormi (gratuit) | idem | requêtes ≤ ~6 Mo (gros imports à découper), durée d'une requête limitée (10 s par défaut) |

Pour les options 1 et 2, **commencez par l'étape A et B** (§4) ; l'option 2 s'y ajoute avec l'étape C (§5). L'option 3 n'utilise pas Render du tout (§6).

Prérequis : mettez le dossier du projet dans un dépôt **GitHub** (`git init`, `git add .`, `git commit`, puis poussez-le sur un nouveau dépôt).

---

## 4. Render — base de données et API (obligatoire dans les deux options)

### A. Créer la base PostgreSQL

1. Créez un compte sur https://render.com et connectez GitHub.
2. *New +* → *PostgreSQL* avec ces paramètres :

   | Paramètre | Valeur |
   |---|---|
   | Name | `sgbd-pastef-db` |
   | Database | `sgbd_pastef` |
   | User | `sgbd` (ou laissez par défaut) |
   | Region | la plus proche de vos utilisateurs (ex. Frankfurt) — **la même que le service web** |
   | PostgreSQL Version | 16 (ou la plus récente) |
   | Plan | Free pour tester, plan payant pour un usage réel |

3. *Create Database*, attendez l'état *Available*.
4. Dans la page de la base, copiez l'**Internal Database URL** (elle sert au service web, dans la même région).

### B. Créer le service web (API)

*New +* → *Web Service* → choisissez votre dépôt GitHub, puis :

| Paramètre | Valeur |
|---|---|
| Name | `sgbd-pastef-rufisque` |
| Region | la même que la base |
| Branch | `main` |
| Root Directory | *(vide, sauf si le projet est dans un sous-dossier du dépôt)* |
| Runtime | **Node** |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path (Advanced) | `/api/health` |
| Plan | Free pour tester |

Variables d'environnement (*Environment*) :

| Variable | Obligatoire | Valeur |
|---|---|---|
| `DATABASE_URL` | oui | l'*Internal Database URL* copiée à l'étape A |
| `JWT_SECRET` | oui | longue chaîne aléatoire (ex. `openssl rand -hex 32`) |
| `ADMIN_USER` | recommandé | identifiant du premier administrateur principal (défaut `admin`) |
| `ADMIN_PASSWORD` | recommandé | mot de passe solide (défaut `admin123`) ; utilisé **uniquement** à la création du compte |
| `NODE_ENV` | recommandé | `production` |
| `DATABASE_SSL` | si besoin | `true` seulement si vous utilisez l'URL **externe** de la base |
| `CORS_ORIGIN` | Option 2 seulement | l'adresse Netlify, voir étape C |
| `TOKEN_TTL_HOURS` | non | durée de connexion, 12 par défaut |
| `JSON_LIMIT_MB` | non | taille max d'une requête (imports), 100 par défaut |
| `PG_POOL_MAX` | non | connexions simultanées à la base |
| `TRUST_PROXY` | non | `false` pour ignorer `X-Forwarded-For` (défaut : activé) |
| `PORT` | non | fourni par Render, ne pas le définir |

Cliquez *Create Web Service*. Les logs doivent afficher `[db] base prête.` puis l'adresse du serveur.

**Option 1 (Render seul) : c'est terminé.** Ouvrez `https://VOTRE-SERVICE.onrender.com`, connectez-vous et **changez le mot de passe administrateur**.

*Variante :* *New +* → *Blueprint* avec `render.yaml` crée la base et le service en une fois et vous demande `ADMIN_PASSWORD`.

> **Plan gratuit** : le service s'endort après inactivité (premier chargement ~30 s) et la base gratuite Render est limitée dans le temps.

---

## 5. Netlify — interface seule (Option 2)

À faire **après** l'étape B : l'interface est servie par Netlify et appelle l'API Render directement.

### C. Étapes

1. **Pointer l'interface vers l'API.** Dans `public/config.js`, remplacez la ligne par (sans `/` final) :

   ```js
   window.SGBD_API_BASE = "https://VOTRE-SERVICE.onrender.com";
   ```

   Poussez la modification sur GitHub.
2. **Créer le site Netlify** : https://app.netlify.com → *Add new site* → *Import an existing project* → GitHub → votre dépôt, avec :

   | Paramètre | Valeur |
   |---|---|
   | Branch to deploy | `main` |
   | Base directory | *(vide)* |
   | Build command | *(vide)* |
   | Publish directory | `public` |
   | Functions directory | *(vide)* |
   | Variables d'environnement | aucune |

   (`netlify.toml` contient déjà `publish = "public"`.) Cliquez *Deploy*.
3. **Autoriser Netlify côté API.** Sur Render, dans le service web, ajoutez/modifiez :

   ```
   CORS_ORIGIN=https://VOTRE-SITE.netlify.app
   ```

   (plusieurs origines possibles, séparées par des virgules ; l'adresse doit correspondre exactement, sans `/` final). Render redéploie automatiquement.
4. Ouvrez `https://VOTRE-SITE.netlify.app` et connectez-vous.

Si vous utilisez un domaine personnalisé sur Netlify, mettez ce domaine dans `CORS_ORIGIN` (vous pouvez lister l'ancien et le nouveau).

---

## 6. Netlify seul — interface + API + base (Option 3)

Aucun compte Render. Netlify sert l'interface et exécute l'API dans une fonction (`netlify/functions/api.mjs`, route `/api/*`) ; la base PostgreSQL est hébergée ailleurs, car Netlify n'héberge pas lui-même PostgreSQL.

1. **Créer la base PostgreSQL** : une base gérée accessible par Internet, par exemple **Neon** (proposée dans Netlify sous le nom « Netlify DB ») ou **Supabase**. Copiez son URL de connexion (`postgres://…`, avec `?sslmode=require`). Si vous utilisez Netlify DB, la variable `NETLIFY_DATABASE_URL` est reconnue automatiquement par l'API.
2. **Laisser `public/config.js` tel quel** (`window.SGBD_API_BASE = "";`) : l'interface et l'API sont sur le même domaine, donc pas de CORS.
3. **Créer le site Netlify** : *Add new site* → *Import an existing project* → GitHub → votre dépôt, avec :

   | Paramètre | Valeur |
   |---|---|
   | Branch to deploy | `main` |
   | Build command | *(vide)* — Netlify installe `pg` d'après `package.json` |
   | Publish directory | `public` |
   | Functions directory | `netlify/functions` |

   (déjà indiqués dans `netlify.toml`)
4. **Variables d'environnement** (*Site configuration* → *Environment variables*) :

   | Variable | Obligatoire | Valeur |
   |---|---|---|
   | `DATABASE_URL` | oui* | URL de la base PostgreSQL (*inutile avec Netlify DB si `NETLIFY_DATABASE_URL` existe) |
   | `JWT_SECRET` | oui | longue chaîne aléatoire |
   | `ADMIN_USER` / `ADMIN_PASSWORD` | recommandé | premier administrateur principal |
   | `NODE_ENV` | recommandé | `production` |
   | `PG_POOL_MAX` | recommandé | `3` (limite les connexions ouvertes par les fonctions) |
   | `DATABASE_SSL` | si besoin | `true` si l'URL n'a pas `sslmode=require` |

5. *Deploy*, puis ouvrez `https://VOTRE-SITE.netlify.app` : le premier appel crée les tables.

Limites à connaître : une requête ne peut pas dépasser environ 6 Mo (importez les gros fichiers CSV en plusieurs parties), la durée d'une requête est limitée par Netlify, et la limitation des tentatives de connexion est propre à chaque instance de fonction.

---

## 7. Exploitation

- **Sauvegarde** : `pg_dump "$DATABASE_URL" > sauvegarde.sql` (restauration : `psql "$DATABASE_URL" < sauvegarde.sql`). Faites-le régulièrement ; les photos sont dans la base.
- **Mise à jour** : poussez sur GitHub, Render redéploie. Les migrations de schéma sont appliquées au démarrage.
- **Sécurité** : définissez toujours `JWT_SECRET` (sinon un secret temporaire est généré et les connexions sautent à chaque redémarrage), changez le mot de passe par défaut, gardez HTTPS (fourni par Render/Netlify).
- **Plusieurs instances** : possible (verrou de migration, versions de tables en base), mais une seule suffit pour ce volume.
- **Variables optionnelles** : `PORT`, `TOKEN_TTL_HOURS` (12), `JSON_LIMIT_MB` (100), `PG_POOL_MAX`, `TRUST_PROXY` (`false` pour désactiver la lecture de `X-Forwarded-For`).

## 8. Dépannage

| Symptôme | Cause probable |
|---|---|
| Logs : `ECONNREFUSED` / `SSL` | mauvaise `DATABASE_URL` ; ajoutez `DATABASE_SSL=true` pour une URL externe |
| « Serveur injoignable » dans l'interface | service Render endormi (patientez) ou mauvaise URL dans `public/config.js` |
| Erreur 503 « Base de données injoignable » (Option 3) | `DATABASE_URL` absente/erronée ou SSL requis (`DATABASE_SSL=true`) |
| Erreur CORS (Option 2) | `CORS_ORIGIN` ne correspond pas exactement à l'URL Netlify |
| Déconnecté à chaque redéploiement | `JWT_SECRET` non défini |
| L'écran de connexion affiche `admin / admin123` | simple rappel d'interface d'origine ; utilisez `ADMIN_PASSWORD` et changez le mot de passe |
