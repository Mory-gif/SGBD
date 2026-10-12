# SYSPLANS — Guide de déploiement

SYSPLANS est l'application de planification et de suivi des opérations du BPCSO.
Cette version remplace le « fichier HTML unique » par une vraie application :

```
Navigateur  ──►  Serveur Node.js (server.js)  ──►  Base PostgreSQL (db.js)
 (public/)        API REST + droits + photos          utilisateurs, activités, PV…
```

```
Sysplans/
├── server.js        → API REST + logique serveur (droits, authentification, photos)
├── db.js            → connexion PostgreSQL + création automatique des tables
├── package.json     → dépendances et commandes (npm start)
├── public/          → interface (index.html + config.js)
│   ├── index.html      l'application (HTML/CSS/JS)
│   └── config.js       adresse de l'API (utile seulement avec Netlify)
├── render.yaml      → « Blueprint » Render : crée serveur + base en un clic
├── netlify.toml     → réglages Netlify (interface seule)
├── .env.example     → modèle des variables d'environnement
├── tests/           → tests automatiques de l'API et de l'interface
└── README.md        → ce guide
```

**Ce que vous obtenez par rapport à l'ancienne version**

| Avant (fichier HTML) | Maintenant |
|---|---|
| Données dans le navigateur de chacun | Données centralisées dans PostgreSQL, partagées en temps réel (actualisation toutes les 45 s) |
| Mots de passe en clair | Mots de passe hachés (bcrypt), connexion par jeton signé |
| Droits appliqués seulement à l'écran | Droits appliqués **par le serveur** : périmètre de visibilité, clôture, validation, suppression |
| Photos dans le JSON des fiches | Photos stockées à part (table `fichiers`) : listes d'activités légères |
| Aucune trace | Journal d'audit (connexions, comptes, suppressions) |

---

## 1. Avant de commencer

Il vous faut :

- un compte **GitHub** (pour envoyer le code),
- un compte **Render** (https://render.com) — héberge le serveur et la base,
- un compte **Netlify** (https://netlify.com) — *facultatif*, seulement si vous voulez héberger l'interface séparément,
- pour tester sur votre ordinateur : **Node.js 18 ou plus** (https://nodejs.org).

> **Netlify ne peut pas remplacer Render.** Netlify héberge des pages statiques ; il ne sait pas faire tourner
> un serveur Node.js permanent ni une base PostgreSQL. Le serveur et la base sont donc **toujours sur Render**.
> Le plus simple est de laisser Render servir aussi l'interface (étapes 3 et 4). Netlify (étape 5) est une option.

---

## 2. Essai sur votre ordinateur (recommandé avant de déployer)

1. Installez PostgreSQL, ou lancez-le avec Docker :
   ```bash
   docker run -d --name sysplans-db -e POSTGRES_USER=sysplans -e POSTGRES_PASSWORD=sysplans \
     -e POSTGRES_DB=sysplans -p 5432:5432 postgres:16
   ```
2. Dans le dossier `Sysplans/`, copiez le modèle de configuration :
   ```bash
   cp .env.example .env
   ```
   puis ouvrez `.env` et choisissez `ADMIN_PASSWORD` et `JWT_SECRET`.
3. Installez et lancez :
   ```bash
   npm install
   npm start
   ```
4. Ouvrez http://localhost:3000 et connectez-vous avec `admin` et le mot de passe choisi.

Au premier démarrage, le serveur crée lui-même toutes les tables et le compte administrateur.
Relancer le serveur ne détruit rien.

---

## 3. Mettre le code sur GitHub

1. Sur https://github.com, cliquez **New repository**, nommez-le `sysplans`, choisissez **Private**, validez.
2. Dans le dossier `Sysplans/` :
   ```bash
   git init
   git add .
   git commit -m "SYSPLANS - première version"
   git branch -M main
   git remote add origin https://github.com/VOTRE-COMPTE/sysplans.git
   git push -u origin main
   ```
   Le fichier `.gitignore` empêche d'envoyer `node_modules/` et votre `.env` (qui contient des secrets).

---

## 4. Déployer sur Render (serveur + base + interface)

### Option A — Blueprint (la plus rapide)

1. Sur https://dashboard.render.com : **New +** → **Blueprint**.
2. Autorisez Render à lire GitHub, choisissez le dépôt `sysplans`, validez.
3. Render lit `render.yaml` et annonce **une base** `sysplans-db` et **un service web** `sysplans`.
4. Il demande la valeur de **`ADMIN_PASSWORD`** : saisissez le mot de passe du premier administrateur
   (au moins 8 caractères, mélangez lettres, chiffres, symboles). Laissez `CORS_ORIGINS` vide (sauf étape 5).
5. Cliquez **Apply**. Attendez que le service passe à **Live** (2 à 4 minutes).
6. Ouvrez l'adresse affichée en haut du service (`https://sysplans-xxxx.onrender.com`) et connectez-vous
   avec `admin` et votre mot de passe.

### Option B — Création manuelle

1. **Base de données** : **New +** → **PostgreSQL**. Nom `sysplans-db`, région la plus proche (ex. Frankfurt),
   choisissez le plan. Une fois créée, copiez l'**Internal Database URL**.
2. **Service web** : **New +** → **Web Service** → choisissez le dépôt GitHub.
   - Runtime : **Node**
   - Build Command : `npm install --omit=dev`
   - Start Command : `npm start`
   - Health Check Path (Advanced) : `/api/sante`
   - Région : **la même que la base**
3. Section **Environment** → ajoutez :

   | Variable | Valeur |
   |---|---|
   | `NODE_ENV` | `production` |
   | `DATABASE_URL` | l'Internal Database URL copiée à l'étape 1 |
   | `JWT_SECRET` | une longue valeur aléatoire (bouton *Generate* ou voir ci-dessous) |
   | `ADMIN_PASSWORD` | le mot de passe du premier administrateur |

   Générer un secret : `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
4. **Create Web Service**, attendez **Live**, ouvrez l'adresse et connectez-vous.

### Vérifier que tout fonctionne

- `https://VOTRE-SERVICE.onrender.com/api/sante` doit afficher `{"ok":true,...}`.
- Dans l'onglet **Logs** du service, vous devez lire « Base de données prête. ».
- Si vous n'avez pas défini `ADMIN_PASSWORD`, un mot de passe aléatoire est écrit **une seule fois** dans les logs
  au premier démarrage : cherchez le cadre « Premier démarrage : compte administrateur créé ».

### Après la première connexion

1. Changez le mot de passe de l'administrateur (menu d'administration → **Mon mot de passe**).
2. Créez les catégories, puis les comptes des utilisateurs.

### ⚠ Plan gratuit : à connaître avant un usage réel

D'après la documentation Render (https://render.com/docs/free) :

- le service web gratuit **s'endort après 15 minutes sans visite** ; la première requête suivante prend environ une minute ;
- la base PostgreSQL gratuite **expire 30 jours après sa création** (14 jours de grâce pour passer à un plan payant,
  sinon les données sont supprimées) et **n'a aucune sauvegarde**.

Pour un usage réel : passez la base à un plan payant (sauvegardes incluses) et le service web à `starter`
(plus de mise en veille). Les plans et prix évoluent : vérifiez-les sur le site de Render.

---

## 5. (Facultatif) Interface sur Netlify

Dans ce montage, Netlify sert les pages et **appelle l'API qui reste sur Render**.

1. **Rendez l'API joignable depuis Netlify** — sur Render, service `sysplans` → **Environment** → variable
   `CORS_ORIGINS` = l'adresse Netlify, **sans barre finale** (vous la connaîtrez à l'étape 4 ; vous pouvez revenir
   ici après). Plusieurs adresses : séparez-les par des virgules. Enregistrez (Render redémarre le service).
2. **Indiquez l'adresse de l'API** — ouvrez `public/config.js` et remplacez :
   ```js
   window.SYSPLANS_API_URL = 'https://VOTRE-SERVICE.onrender.com';
   ```
   (sans barre finale). Enregistrez, puis `git commit` et `git push`.
3. **Déployez sur Netlify** (deux façons) :
   - *Avec GitHub (recommandé)* : https://app.netlify.com → **Add new site** → **Import an existing project** →
     GitHub → dépôt `sysplans`. Netlify lit `netlify.toml` (dossier publié : `public`). Laissez la commande de
     build vide → **Deploy**.
   - *Sans GitHub* : https://app.netlify.com/drop et glissez-y le dossier `public/` (après avoir modifié `config.js`).
4. Netlify vous donne une adresse `https://nom-aleatoire.netlify.app` (modifiable dans *Site configuration →
   Change site name*). Revenez à l'étape 1 pour y mettre cette adresse dans `CORS_ORIGINS`.
5. Ouvrez l'adresse Netlify et connectez-vous.

**Variante sans CORS** : dans `netlify.toml`, décommentez le bloc `[[redirects]]` (remplacez l'adresse Render) et
laissez `window.SYSPLANS_API_URL = ''`. Netlify relaie alors `/api/*` vers Render, et `CORS_ORIGINS` devient inutile.

> La connexion utilise un jeton envoyé dans l'en-tête `Authorization` (pas de cookie) : elle fonctionne donc
> sans réglage particulier même quand l'interface et l'API sont sur deux domaines différents.

---

## 6. Reprendre les données de l'ancienne version

1. Dans l'**ancienne** application, connecté en administrateur : **Sauvegarder les données** → un fichier `.json`.
2. Dans la **nouvelle** application, connecté en administrateur : **Charger une sauvegarde** (ajoute sans écraser)
   ou **Restaurer une sauvegarde** (remplace tout), et choisissez le fichier.

À savoir :
- Les anciens mots de passe sont lus dans la sauvegarde puis **hachés** par le serveur. Si certains font moins de
  6 caractères, le serveur les refuse : ajoutez temporairement `MOT_DE_PASSE_MIN=4` dans les variables Render, importez,
  puis retirez-la et demandez à ces utilisateurs de changer leur mot de passe.
- Les sauvegardes faites **depuis cette nouvelle version ne contiennent pas les mots de passe** (ils ne sont plus
  récupérables, par conception). Un compte restauré sans mot de passe doit en recevoir un nouveau
  (réinitialisation par son créateur ou l'administrateur).
- Les photos sont déplacées automatiquement dans la table `fichiers`.

---

## 7. Sauvegardes de la base

- **Render, plan payant** : sauvegardes automatiques (onglet *Backups* de la base).
- **À la main** (toutes formules) — depuis votre ordinateur, avec l'**External Database URL** de la base. Par sécurité,
  `render.yaml` n'autorise que les connexions internes : ajoutez d'abord votre adresse IP dans la base →
  **Access Control** (ou « Networking »), puis :
  ```bash
  pg_dump "postgres://…external-url…" --no-owner -Fc -f sysplans-$(date +%F).dump
  # restauration :
  pg_restore --no-owner -d "postgres://…autre-base…" sysplans-2026-01-01.dump
  ```
- **Dans l'application** : *Sauvegarder les données* (réservé à l'administrateur) donne un fichier JSON lisible.

---

## 8. Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `DATABASE_URL` | oui | Adresse de la base PostgreSQL |
| `JWT_SECRET` | oui en production | Secret qui signe les connexions. Le changer déconnecte tout le monde |
| `ADMIN_PASSWORD` | conseillé | Mot de passe du premier administrateur (utilisé seulement si la base est vide) |
| `ADMIN_IDENTIFIANT` | non | Identifiant du premier administrateur (défaut `admin`) |
| `PORT` | non | Fourni par Render |
| `CORS_ORIGINS` | si Netlify | Adresses autorisées à appeler l'API, séparées par des virgules |
| `NODE_ENV` | non | `production` sur Render |
| `DATABASE_SSL` | non | `false` pour une base locale sans SSL (détecté automatiquement) |
| `JWT_DUREE` | non | Durée d'une connexion (défaut `12h`) |
| `MOT_DE_PASSE_MIN` | non | Longueur minimale des mots de passe (défaut 6, minimum 4) |
| `LOGIN_MAX` | non | Tentatives de connexion par 15 min et par IP (défaut 20) |
| `JSON_LIMIT` | non | Taille maximale d'une requête (défaut `30mb`) |

---

## 9. La base de données

Modèle « hybride » : ce qui sert à filtrer, relier et contrôler les droits est en colonnes typées avec clés
étrangères et index ; le détail propre à chaque fiche (PV d'opération, logistique, géométries, champs de
chaque type d'activité, champs personnalisés du suivi…) est en **JSONB**, interrogeable en SQL.

| Table | Contenu |
|---|---|
| `utilisateurs` | comptes : identifiant (unique, insensible à la casse), rôle, responsable, affectation, mot de passe haché |
| `categories` | catégories d'activités |
| `activites` | une ligne par activité : type, statut, date, lieu, créateur, affectation, catégorie, clôture + `donnees` (JSONB) |
| `fichiers` | photos des activités (binaire), supprimées avec leur activité |
| `notifications` | notifications par utilisateur |
| `parametres` | réglages partagés (champs personnalisés du Suivi, typologie du PV) |
| `journal` | journal d'audit |

```
utilisateurs ◄── activites ──► categories
     ▲              │
     │              └──► fichiers (photos)
     └── notifications
```

Exemples de requêtes utiles (dans la console SQL de Render) :
```sql
-- Activités terminées par département
SELECT departement, count(*) FROM activites WHERE statut = 'termine' GROUP BY 1 ORDER BY 2 DESC;
-- Activités d'aménagement avec leur surface
SELECT titre, donnees->>'amenagementSurface' AS surface_m2 FROM activites WHERE type = 'amenagement';
-- Dernières connexions
SELECT date_evt, user_id, ip FROM journal WHERE action = 'connexion' ORDER BY date_evt DESC LIMIT 20;
```

---

## 10. Sécurité : ce qui est en place, ce qu'il reste à savoir

**En place** : mots de passe hachés (bcrypt) ; connexions par jeton signé qui expire ; ancien jeton invalidé à
chaque changement de mot de passe ou désactivation du compte ; limitation des tentatives de connexion ;
en-têtes de sécurité (helmet) ; CORS restreint aux adresses déclarées ; droits vérifiés par le serveur à chaque
enregistrement ; journal d'audit ; HTTPS fourni par Render et Netlify.

**À savoir**
- Les photos sont servies par une adresse non devinable (clé aléatoire de 128 bits) : toute personne qui possède
  le lien peut voir l'image, sans connexion.
- L'accès aux **modules** (Cartographie, Live, etc.) est géré à l'écran ; ce sont les **données** (activités,
  comptes, catégories) que le serveur protège.
- **Live** : les vidéos importées *depuis un fichier* restent dans le navigateur qui les a importées ; les
  **liens** (YouTube, Facebook, TikTok…) sont, eux, partagés via la base.
- **Assistant IA** : la clé API éventuelle est enregistrée **dans le navigateur de chaque utilisateur**, jamais
  sur le serveur.
- Deux personnes qui modifient la **même fiche** au même instant : la dernière écriture l'emporte.

---

## 11. Référence de l'API

Toutes les routes (sauf `login`, `sante` et `fichiers`) exigent `Authorization: Bearer <jeton>`.

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/auth/login` | Connexion → jeton + profil |
| GET | `/api/auth/me` | Profil de la session |
| POST | `/api/auth/mot-de-passe` | Changer son mot de passe |
| GET / POST | `/api/utilisateurs` · `/sync` | Lister · créer, modifier, supprimer |
| GET / POST | `/api/categories` · `/sync` | idem (administrateur) |
| GET / POST | `/api/activites` · `/sync` | idem, selon le périmètre de l'utilisateur |
| GET / POST | `/api/notifications` · `/sync` | Ses propres notifications |
| GET / PUT | `/api/parametres/:cle` | Réglages partagés |
| GET | `/api/fichiers/:cle` | Photo (adresse non devinable) |
| GET | `/api/journal` | Journal d'audit (administrateur principal) |
| GET | `/api/sante` | Contrôle de santé |

Les routes `/sync` reçoivent `{ "upserts": [...], "deletes": ["id", ...] }` : l'interface n'envoie que les
éléments réellement ajoutés, modifiés ou supprimés.

---

## 12. Tests

Avec un serveur lancé sur une base de **test** (ne jamais viser la base réelle) :
```bash
BASE=http://localhost:3000 npm run test:api   # 57 vérifications : droits, clôture, photos, notifications…
BASE=http://localhost:3000 npm run test:ui    # navigateur simulé : connexion, création d'activité, déconnexion
```

---

## 13. Dépannage

| Symptôme | Cause probable et remède |
|---|---|
| Le service Render échoue au démarrage avec « DATABASE_URL manquante » | Variable absente : Environment → ajoutez-la (Internal Database URL) |
| « JWT_SECRET est obligatoire en production » | Ajoutez la variable `JWT_SECRET` |
| « Serveur injoignable » à l'écran | Service endormi (plan gratuit) : patientez ~1 minute et réessayez ; ou `config.js` pointe vers une mauvaise adresse |
| Avec Netlify : erreurs CORS dans la console du navigateur | L'adresse Netlify n'est pas dans `CORS_ORIGINS` (sans barre finale, `https://…`) |
| « Votre session a expiré » | Connexion de plus de 12 h (`JWT_DUREE`) ou mot de passe changé : reconnectez-vous |
| « Identifiant ou mot de passe incorrect » alors que c'est le bon | `ADMIN_PASSWORD` n'est lu qu'à la **création** : si la base existait déjà, utilisez le mot de passe d'alors, ou réinitialisez-le en SQL (ci-dessous) |
| Erreur SSL à la connexion à la base en local | Ajoutez `DATABASE_SSL=false` dans `.env` |

**Mot de passe administrateur perdu** — générez un haché depuis votre ordinateur, puis mettez le compte à jour
dans la console SQL de la base :
```bash
node -e "require('bcryptjs').hash('NouveauMotDePasse!',12).then(console.log)"
```
```sql
UPDATE utilisateurs SET mot_de_passe_hash = '<haché>', jeton_version = jeton_version + 1 WHERE identifiant = 'admin';
```

---

## 14. Pistes d'évolution

- Stocker les photos sur un service d'objets (S3, Cloudinary) si leur volume devient important.
- Versionner les fiches pour détecter les modifications simultanées au lieu du « dernier qui écrit ».
- Envoyer des notifications par e-mail ; exports PDF/Excel côté serveur.
- Déplacer les vidéos importées (Live) vers un stockage partagé.
