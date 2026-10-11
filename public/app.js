"use strict";
/* =========================================================================
   SGBD MORY — Application de gestion (Membres / Cellules / Sections)
   Interface web — donnees stockees dans PostgreSQL via l'API (api-client.js)
   ========================================================================= */
// Un membre doit basculer automatiquement dans le module "Transferts et
// renouvellement" (onglet Renouvellement) des lors que l'annee d'expiration
// de sa CNI est anterieure a l'annee en cours.
function estCniExpiree(m) {
    if (!m.dateExpirationCNI)
        return false;
    const annee = new Date(m.dateExpirationCNI).getFullYear();
    return !isNaN(annee) && annee < new Date().getFullYear();
}
// Un membre est "Hors zone" lorsque sa commune de residence (Identite)
// differe de sa commune de vote : il est alors signale automatiquement dans
// "Transferts et renouvellement" (onglet Transferts). Traiter le transfert
// aligne la commune de vote sur la commune de residence (voir
// traiterTransfert) — la commune de vote redevient alors forcement la
// commune de residence.
function estHorsZone(m) {
    return m.electeur === "Oui" && !!m.commune && !!m.communeVote && m.commune !== m.communeVote;
}
// Roles composant le bureau d'une cellule. Chaque role reference l'id d'un
// Membre. Regle metier impérative : un membre selectionne pour un role de
// bureau doit obligatoirement appartenir a CETTE cellule (membre.celluleId
// === cellule.id). Voir bureauEstValide().
const CELLULE_BUREAU_ROLES = [
    { key: "responsableCelluleId", label: "Responsable cellule" },
    { key: "tresorierGeneralId", label: "Tresorier(e) general(e)" },
    { key: "secretaireGeneralId", label: "Secretaire general" },
    { key: "secretaireGeneralAdjointId", label: "Secretaire general adjoint" },
    { key: "commissionFinanceId", label: "Commission finances" },
    { key: "commissionCommunicationId", label: "Commission communication" },
    { key: "commissionMassificationId", label: "Commission massification" },
    { key: "responsableJeunesId", label: "Responsable des jeunes" },
    { key: "responsableFemmesId", label: "Responsable des femmes" },
];
// Regle metier impérative : un membre selectionne pour un role du bureau de
// section doit obligatoirement appartenir a CETTE section (membre.sectionId
// === section.id). Voir bureauEstValide().
const SECTION_BUREAU_ROLES = [
    { key: "responsableSectionId", label: "Responsable section" },
    { key: "tresorierGeneralId", label: "Tresorier(e) general(e)" },
    { key: "secretaireGeneralId", label: "Secretaire general" },
    { key: "secretaireGeneralAdjointId", label: "Secretaire general adjoint" },
    { key: "commissionFinanceId", label: "Commission finances" },
    { key: "commissionCommunicationId", label: "Commission communication" },
    { key: "commissionMassificationId", label: "Commission massification" },
    { key: "responsableJeunesId", label: "Responsable des jeunes" },
    { key: "responsableFemmesId", label: "Responsable des femmes" },
    { key: "responsableEnseignantsId", label: "Responsable des enseignants" },
];
// ------------------------------------------------------------------------
// 2. BASE DE DONNEES (API serveur / PostgreSQL — voir api-client.js)
// ------------------------------------------------------------------------
// Meme interface asynchrone que la base locale d'origine (toArray, get, add,
// update, where().equals()...), mais les donnees vivent dans PostgreSQL. Le
// hachage des mots de passe et la creation du compte administrateur initial
// sont desormais faits par le serveur.
const db = new SgbdApiDatabase();
const SESSION_KEY = "sgbd_mory_rufisque_session";
function getSession() {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
}
function setSession(s) {
    if (s)
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
    else
        sessionStorage.removeItem(SESSION_KEY);
}
async function login(identifiant, motDePasse) {
    const s = await sgbdApi.login(identifiant, motDePasse);
    if (!s)
        return null;
    setSession(s);
    return s;
}
function logout() {
    setSession(null);
    sgbdApi.resetAfterLogout();
    currentView = "dashboard";
    navHasBeenClicked = false;
    render();
}
// Matrice de droits simplifiee
const PERMISSIONS = {
    // Seul l'administrateur principal cree/modifie/supprime les cellules et sections.
    admin_principal: { manageUsers: true, manageStructure: true, editData: true, deleteData: true },
    admin_secondaire: { manageUsers: false, manageStructure: false, editData: true, deleteData: true },
    utilisateur: { manageUsers: false, manageStructure: false, editData: true, deleteData: false },
};
function can(role, action) {
    return PERMISSIONS[role][action];
}
const ROLE_LABELS = {
    admin_principal: "Administrateur principal",
    admin_secondaire: "Administrateur",
    utilisateur: "Utilisateur",
};
// ------------------------------------------------------------------------
// 3bis. MODULES — affectation fine, par utilisateur, des modules et
// sous-modules accessibles (independamment du role). L'administrateur
// principal peut affecter/desaffecter ces modules a la creation d'un compte
// ou depuis sa fiche, dans Gestion des utilisateurs.
// ------------------------------------------------------------------------
const MODULE_TREE = [
    { id: "dashboard", label: "Tableau de bord" },
    { id: "membres", label: "Membres" },
    { id: "cellules", label: "Cellules" },
    { id: "sections", label: "Sections" },
    { id: "cartographie", label: "Cartographie" },
    {
        id: "massification", label: "Massification",
        children: [
            { id: "massification.cartes", label: "Carte de membres" },
            { id: "massification.spatial", label: "Analyse spatiale" },
        ],
    },
    {
        id: "electorale", label: "Carte electorale",
        children: [
            { id: "electorale.bureaux", label: "Bureaux de vote" },
            { id: "electorale.elections", label: "Elections et resultats" },
            { id: "electorale.analyse", label: "Analyse electorale" },
            { id: "electorale.primo", label: "Primo-votants" },
            { id: "electorale.trouver", label: "Trouver un membre" },
        ],
    },
    {
        id: "transferts", label: "Transferts, Renouvellement & Non inscrits",
        children: [
            { id: "transferts.renouvellement", label: "Renouvellement" },
            { id: "transferts.transferts", label: "Transferts" },
            { id: "transferts.noninscrits", label: "Non inscrits" },
        ],
    },
    { id: "utilisateurs", label: "Gestion des utilisateurs" },
];
const ALL_MODULE_IDS = MODULE_TREE.flatMap(m => [m.id, ...(m.children?.map(c => c.id) ?? [])]);
// Jeu de modules accorde par defaut a un role, utilise quand un compte n'a
// pas encore de liste "modules" explicite (comptes crees avant cette
// fonctionnalite, ou non modifies depuis).
// Le module "Cartographie" n'est jamais accorde par defaut : seul
// l'administrateur principal y accede d'office ; tout autre compte doit se
// le voir explicitement affecter depuis Gestion des utilisateurs.
function modulesParDefaut(role) {
    if (role === "admin_principal")
        return ALL_MODULE_IDS.slice();
    return ALL_MODULE_IDS.filter(id => id !== "utilisateurs" && id !== "cartographie");
}
// L'administrateur principal dispose TOUJOURS de la totalite des modules,
// meme si une liste plus ancienne a ete enregistree sur son compte : sans
// cela, tout module ajoute apres la derniere modification de sa fiche
// resterait invisible dans son menu.
function modulesEffectifs(u) {
    if (u.role === "admin_principal")
        return ALL_MODULE_IDS.slice();
    return u.modules && u.modules.length ? u.modules : modulesParDefaut(u.role);
}
// Modules effectifs de l'utilisateur actuellement connecte.
async function modulesUtilisateurCourant() {
    const session = getSession();
    if (!session)
        return [];
    const u = await db.users.get(session.userId);
    if (!u)
        return [];
    return modulesEffectifs(u);
}
// ------------------------------------------------------------------------
// 4. UTILITAIRES
// ------------------------------------------------------------------------
function $(sel, parent = document) {
    const el = parent.querySelector(sel);
    if (!el)
        throw new Error("Element introuvable: " + sel);
    return el;
}
function el(tag, opts = {}) {
    const node = document.createElement(tag);
    Object.assign(node, opts);
    if (opts.html)
        node.innerHTML = opts.html;
    return node;
}
function toast(message, kind = "info") {
    const host = document.getElementById("toast-host");
    const t = el("div", { className: `toast toast--${kind}`, textContent: message });
    host.appendChild(t);
    requestAnimationFrame(() => t.classList.add("toast--show"));
    setTimeout(() => {
        t.classList.remove("toast--show");
        setTimeout(() => t.remove(), 250);
    }, 3200);
}
function formatDate(iso) {
    const d = new Date(iso);
    return d.toLocaleDateString("fr-FR") + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
// Formate une date (sans heure) au format jj/mm/aaaa demande pour la Date de
// naissance et les dates de CNI. Renvoie "—" si la date est vide/invalide.
function formatDateJJMMAAAA(iso) {
    if (!iso)
        return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime()))
        return "—";
    const jj = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${jj}/${mm}/${d.getFullYear()}`;
}
// Prochain numero d'enregistrement (champ "N°"). Les valeurs absentes ou
// non numeriques sont ignorees, afin qu'un enregistrement mal forme ne
// propage pas un NaN a toute la numerotation.
async function nextNumero(table) {
    const all = await table.toArray();
    let max = 0;
    for (const r of all) {
        const n = Number(r.numero);
        if (isFinite(n) && n > max)
            max = n;
    }
    return max + 1;
}
// Reference d'un membre : "JJMM.PN_NNN/ReferenceCellule"
// - JJMM : jour et mois de la date de NAISSANCE du membre
// - P : 1ere lettre du prenom (majuscule), N : 1ere lettre du nom (majuscule)
// - NNN : rang du membre DANS SA CELLULE, sur 3 chiffres
// - ReferenceCellule : reference complete de la cellule de rattachement
//   (absente si le membre n'est rattache a aucune cellule)
//
// IMPORTANT — comme pour les cellules et les sections, ce rang est
// INDEPENDANT du champ "N°" (numero d'enregistrement, jamais modifie) : les
// membres d'une meme cellule sont numerotes 1, 2, 3... dans leur ordre
// d'inscription, et chaque cellule repart de 1. Les membres sans cellule
// forment leur propre serie. Recalcule a chaque creation, modification du
// rattachement et suppression (voir resynchroniserReferencesMembres()).
function memberReference(rang, prenom, nom, dateNaissance, celluleReference) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateNaissance || "");
    const jj = m ? m[3] : "00";
    const mm = m ? m[2] : "00";
    const initP = (prenom || "").trim().charAt(0).toUpperCase();
    const initN = (nom || "").trim().charAt(0).toUpperCase();
    const num = String(rang).padStart(3, "0");
    const base = `${jj}${mm}.${initP}${initN}_${num}`;
    return celluleReference ? `${base}/${celluleReference}` : base;
}
// Nom complet d'affichage d'un membre : Prenom puis Nom (jamais l'inverse),
// utilise partout ou un membre est affiche (listes, fiches, formulaires).
function nomComplet(m) {
    return `${m.prenom} ${m.nom}`.trim();
}
// Reference d'une cellule : "C" + rang (4 chiffres) + "_" + nom.
// Reference d'une section : "S" + rang (4 chiffres) + "_" + nom + "_TPN".
//
// IMPORTANT — le rang porte par la reference est INDEPENDANT du champ "N°"
// (numero d'enregistrement, jamais modifie). Il s'agit d'une numerotation
// PROPRE A CHAQUE NOM : toutes les structures portant le meme nom sont
// numerotees 1, 2, 3... dans leur ordre de creation, et chaque nom different
// repart de 1. Exemple pour trois cellules nommees "Cite Agness" :
//   C0001_Cite Agness ; C0002_Cite Agness ; C0003_Cite Agness
// Recalculee a chaque creation, modification du nom et suppression, afin de
// rester exacte et contigue (voir recalculerReferencesStructures()).
function structureReference(prefix, rang, nom, suffix = "") {
    return `${prefix}${String(rang).padStart(4, "0")}_${nom}${suffix}`.trim();
}
// Cle de comparaison des noms : insensible a la casse, aux accents et aux
// espaces multiples, pour que "Cite Agness" et "cité  agness" soient bien
// consideres comme un seul et meme nom.
function cleNom(nom) {
    return (nom || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .trim().toLowerCase().replace(/\s+/g, " ");
}
// Renumerote les references de toutes les cellules (ou de toutes les
// sections) : les enregistrements sont parcourus dans leur ordre de creation
// (champ N°) et chaque groupe de meme nom recoit une numerotation continue
// 1, 2, 3... Renvoie true si au moins une reference a change.
async function recalculerReferencesStructures(kind) {
    const table = kind === "cellule" ? db.cellules : db.sections;
    const prefix = kind === "cellule" ? "C" : "S";
    const suffix = kind === "cellule" ? "" : "_TPN";
    const all = (await table.toArray()).sort((a, b) => (a.numero || 0) - (b.numero || 0));
    const compteurs = new Map();
    const aMettreAJour = [];
    for (const item of all) {
        const cle = cleNom(item.nom);
        const rang = (compteurs.get(cle) || 0) + 1;
        compteurs.set(cle, rang);
        const reference = structureReference(prefix, rang, item.nom, suffix);
        if (item.reference !== reference)
            aMettreAJour.push({ id: item.id, reference });
    }
    for (const maj of aMettreAJour)
        await table.update(maj.id, { reference: maj.reference });
    return aMettreAJour.length > 0;
}
// Renumerote les references de tous les membres : parcours dans l'ordre
// d'inscription (champ N°), avec un compteur propre a chaque cellule. Les
// membres sans cellule forment une serie distincte.
async function resynchroniserReferencesMembres() {
    const [membres, cellules] = await Promise.all([db.membres.toArray(), db.cellules.toArray()]);
    const compteurs = new Map();
    const tries = membres.slice().sort((a, b) => (a.numero || 0) - (b.numero || 0));
    for (const m of tries) {
        const cle = m.celluleId ? `c${m.celluleId}` : "sans-cellule";
        const rang = (compteurs.get(cle) || 0) + 1;
        compteurs.set(cle, rang);
        const cellule = m.celluleId ? cellules.find(c => c.id === m.celluleId) : undefined;
        const reference = memberReference(rang, m.prenom, m.nom, m.dateNaissance, cellule?.reference);
        if (m.reference !== reference)
            await db.membres.update(m.id, { reference });
    }
}
// Rang qu'occuperait un nouveau membre dans une cellule donnee (utilise pour
// l'apercu d'import et la creation manuelle).
function rangDansCellule(membres, celluleId) {
    return membres.filter(m => (m.celluleId || null) === (celluleId || null)).length + 1;
}
// Remet a plat l'ensemble des references (cellules, sections, puis membres).
// Appelee apres toute creation / modification / suppression et une fois au
// demarrage, afin de migrer les donnees existantes.
async function synchroniserReferences() {
    await recalculerReferencesStructures("cellule");
    await recalculerReferencesStructures("section");
    await resynchroniserReferencesMembres();
}
// ------------------------------------------------------------------------
// 4bis. GEOMETRIE (GeoJSON) — outils communs a la cartographie
//
// Une cellule peut porter une geometrie (Polygon ou MultiPolygon GeoJSON,
// coordonnees [longitude, latitude] en WGS84) dessinee sur la carte ou
// importee au format JSON. La geometrie d'une SECTION n'est jamais stockee :
// elle est toujours recalculee en regroupant les geometries des cellules qui
// lui sont rattachees, de sorte qu'elle se met a jour automatiquement des
// qu'une cellule est modifiee (voir geometrieSection()).
// ------------------------------------------------------------------------
// Rayon terrestre moyen (WGS84) utilise pour les mesures spheriques.
const RAYON_TERRE = 6378137;
// Ramene n'importe quelle forme GeoJSON acceptee a une liste de polygones,
// chaque polygone etant une liste d'anneaux, chaque anneau une liste de
// points [longitude, latitude].
function polygonesDeGeometrie(geom) {
    if (!geom)
        return [];
    if (geom.type === "FeatureCollection")
        return (geom.features || []).flatMap(f => polygonesDeGeometrie(f));
    const g = geom.type === "Feature" ? geom.geometry : geom;
    if (!g || !g.coordinates)
        return [];
    if (g.type === "Polygon")
        return [g.coordinates];
    if (g.type === "MultiPolygon")
        return g.coordinates;
    return [];
}
// Reconstruit une geometrie GeoJSON a partir d'une liste de polygones.
function geometrieDepuisPolygones(polygones) {
    const valides = polygones.filter(p => Array.isArray(p) && p.length && Array.isArray(p[0]) && p[0].length >= 4);
    if (!valides.length)
        return null;
    if (valides.length === 1)
        return { type: "Polygon", coordinates: valides[0] };
    return { type: "MultiPolygon", coordinates: valides };
}
function aUneGeometrie(item) {
    return polygonesDeGeometrie(item?.geometry).length > 0;
}
// Geometrie d'une section : regroupement automatique (MultiPolygon) des
// geometries de toutes les cellules rattachees a cette section. Aucune
// saisie manuelle n'est possible : toute modification de la geometrie d'une
// cellule se repercute instantanement sur sa section.
function geometrieSection(section, cellules) {
    const polygones = [];
    for (const c of cellules) {
        if (c.sectionId === section.id)
            polygones.push(...polygonesDeGeometrie(c.geometry));
    }
    return geometrieDepuisPolygones(polygones);
}
// Interprete un contenu JSON importe (FeatureCollection, Feature, geometrie
// brute, ou simple tableau de coordonnees) et le ramene a un Polygon /
// MultiPolygon exploitable. Renvoie null si rien d'utilisable n'est trouve.
function normaliserGeometrieImportee(json) {
    let source = json;
    // Tableau brut de points [[lng,lat], ...] ou d'anneaux.
    if (Array.isArray(source)) {
        if (Array.isArray(source[0]) && typeof source[0][0] === "number")
            source = { type: "Polygon", coordinates: [source] };
        else if (Array.isArray(source[0]) && Array.isArray(source[0][0]) && typeof source[0][0][0] === "number")
            source = { type: "Polygon", coordinates: source };
        else
            return null;
    }
    const polygones = polygonesDeGeometrie(source).map(fermerPolygone).filter(Boolean);
    return geometrieDepuisPolygones(polygones);
}
// Un anneau GeoJSON doit etre ferme (premier point == dernier point).
function fermerPolygone(anneaux) {
    const sortie = [];
    for (const anneau of anneaux) {
        const pts = (anneau || []).filter(p => Array.isArray(p) && p.length >= 2 &&
            isFinite(Number(p[0])) && isFinite(Number(p[1]))).map(p => [Number(p[0]), Number(p[1])]);
        if (pts.length < 3)
            continue;
        const a = pts[0], b = pts[pts.length - 1];
        if (a[0] !== b[0] || a[1] !== b[1])
            pts.push([a[0], a[1]]);
        sortie.push(pts);
    }
    return sortie.length ? sortie : null;
}
// Aire spherique (m2) d'un anneau exprime en [longitude, latitude].
function aireAnneau(anneau) {
    const n = anneau.length;
    if (n < 3)
        return 0;
    let total = 0;
    for (let i = 0; i < n - 1; i++) {
        const [lng1, lat1] = anneau[i];
        const [lng2, lat2] = anneau[i + 1];
        total += (lng2 - lng1) * Math.PI / 180 *
            (2 + Math.sin(lat1 * Math.PI / 180) + Math.sin(lat2 * Math.PI / 180));
    }
    return Math.abs(total * RAYON_TERRE * RAYON_TERRE / 2);
}
// Superficie totale d'une geometrie (m2) : anneau exterieur moins les trous.
function aireGeometrie(geom) {
    let total = 0;
    for (const polygone of polygonesDeGeometrie(geom)) {
        polygone.forEach((anneau, i) => {
            const a = aireAnneau(anneau);
            total += i === 0 ? a : -a;
        });
    }
    return Math.max(0, total);
}
// Perimetre total (m) de l'enveloppe exterieure d'une geometrie.
function perimetreGeometrie(geom) {
    let total = 0;
    for (const polygone of polygonesDeGeometrie(geom)) {
        const anneau = polygone[0] || [];
        for (let i = 0; i < anneau.length - 1; i++)
            total += distanceMetres([anneau[i][1], anneau[i][0]], [anneau[i + 1][1], anneau[i + 1][0]]);
    }
    return total;
}
// Distance orthodromique (m) entre deux points [latitude, longitude].
function distanceMetres(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad;
    const dLng = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * RAYON_TERRE * Math.asin(Math.min(1, Math.sqrt(h)));
}
// Centre d'une geometrie : centroide surfacique du plus grand polygone, en
// [latitude, longitude] — c'est le point ou se declenche le scintillement de
// la recherche geographique.
function centreGeometrie(geom) {
    const polygones = polygonesDeGeometrie(geom);
    if (!polygones.length)
        return null;
    let meilleur = null;
    let meilleureAire = -1;
    for (const polygone of polygones) {
        const a = aireAnneau(polygone[0] || []);
        if (a > meilleureAire) {
            meilleureAire = a;
            meilleur = polygone[0];
        }
    }
    if (!meilleur || meilleur.length < 3)
        return null;
    // Centroide polygonal (formule de la surface signee), avec repli sur la
    // moyenne des sommets si le polygone est degenere.
    let surface = 0, cx = 0, cy = 0;
    for (let i = 0; i < meilleur.length - 1; i++) {
        const [x1, y1] = meilleur[i];
        const [x2, y2] = meilleur[i + 1];
        const f = x1 * y2 - x2 * y1;
        surface += f;
        cx += (x1 + x2) * f;
        cy += (y1 + y2) * f;
    }
    if (Math.abs(surface) < 1e-12) {
        const somme = meilleur.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1]], [0, 0]);
        return [somme[1] / meilleur.length, somme[0] / meilleur.length];
    }
    surface *= 0.5;
    return [cy / (6 * surface), cx / (6 * surface)];
}
// Test d'appartenance d'un point a un anneau (algorithme du lancer de rayon).
function pointDansAnneau(x, y, anneau) {
    let dedans = false;
    for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) {
        const xi = anneau[i][0], yi = anneau[i][1];
        const xj = anneau[j][0], yj = anneau[j][1];
        const traverse = (yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
        if (traverse)
            dedans = !dedans;
    }
    return dedans;
}
// Le point [longitude, latitude] est-il a l'interieur de la geometrie ?
// Les anneaux interieurs (trous) sont exclus.
function pointDansGeometrie(point, geom) {
    const [x, y] = point;
    for (const polygone of polygonesDeGeometrie(geom)) {
        let dansContour = false, dansTrou = false;
        polygone.forEach((anneau, i) => {
            if (!pointDansAnneau(x, y, anneau))
                return;
            if (i === 0)
                dansContour = true;
            else
                dansTrou = true;
        });
        if (dansContour && !dansTrou)
            return true;
    }
    return false;
}
// Emprise [[latMin,lngMin],[latMax,lngMax]] d'une geometrie.
function empriseGeometrie(geom) {
    let latMin = 90, latMax = -90, lngMin = 180, lngMax = -180, vide = true;
    for (const polygone of polygonesDeGeometrie(geom)) {
        for (const anneau of polygone) {
            for (const [lng, lat] of anneau) {
                vide = false;
                latMin = Math.min(latMin, lat);
                latMax = Math.max(latMax, lat);
                lngMin = Math.min(lngMin, lng);
                lngMax = Math.max(lngMax, lng);
            }
        }
    }
    return vide ? null : [[latMin, lngMin], [latMax, lngMax]];
}
// Mises en forme lisibles des mesures.
function formatSuperficie(m2) {
    if (!m2)
        return "—";
    if (m2 >= 1e6)
        return `${(m2 / 1e6).toLocaleString("fr-FR", { maximumFractionDigits: 3 })} km² (${(m2 / 1e4).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} ha)`;
    if (m2 >= 1e4)
        return `${(m2 / 1e4).toLocaleString("fr-FR", { maximumFractionDigits: 2 })} ha (${Math.round(m2).toLocaleString("fr-FR")} m²)`;
    return `${Math.round(m2).toLocaleString("fr-FR")} m²`;
}
function formatDistance(m) {
    if (!m)
        return "—";
    return m >= 1000
        ? `${(m / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 3 })} km`
        : `${m.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} m`;
}
// Lit un fichier image selectionne par l'utilisateur, le redimensionne (cote
// max ~400px) et le renvoie encode en base64 (data URL) afin de le stocker
// directement dans IndexedDB sans dependance serveur.
function fileToResizedDataUrl(file, maxSize = 400) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Lecture du fichier impossible."));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error("Image invalide."));
            img.onload = () => {
                let { width, height } = img;
                if (width > height && width > maxSize) {
                    height = Math.round(height * (maxSize / width));
                    width = maxSize;
                }
                else if (height > maxSize) {
                    width = Math.round(width * (maxSize / height));
                    height = maxSize;
                }
                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL("image/jpeg", 0.85));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}
// Lit un fichier image et le renvoie tel quel en data URL (sans
// redimensionnement) : le recadrage se charge ensuite de la mise a l'echelle.
function fichierEnDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Lecture du fichier impossible."));
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
    });
}
// Recadrage carre interactif d'une photo (membre ou utilisateur) : deplacement
// a la souris ou au doigt, zoom a la molette ou au curseur, apercu en temps
// reel. Renvoie une data URL carree de 400 px de cote, ou null si l'operation
// est annulee.
function ouvrirRecadragePhoto(dataUrl) {
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous"; // photo deja enregistree : servie par l'API (peut etre sur un autre domaine)
        img.onerror = () => {
            toast("Image illisible.", "error");
            resolve(null);
        };
        img.onload = () => {
            const V = 320; // cote de la zone de recadrage, en pixels ecran
            const SORTIE = 400; // cote de l'image produite
            const echelleBase = Math.max(V / img.naturalWidth, V / img.naturalHeight);
            let zoom = 1, decalageX = 0, decalageY = 0;
            let termine = false;
            const dimensions = () => ({
                l: img.naturalWidth * echelleBase * zoom,
                h: img.naturalHeight * echelleBase * zoom,
            });
            // L'image doit toujours couvrir entierement la zone de recadrage.
            const contraindre = () => {
                const { l, h } = dimensions();
                decalageX = Math.min(0, Math.max(V - l, decalageX));
                decalageY = Math.min(0, Math.max(V - h, decalageY));
            };
            const centrer = () => {
                const { l, h } = dimensions();
                decalageX = (V - l) / 2;
                decalageY = (V - h) / 2;
            };
            centrer();
            ouvrirModale({
                titre: "Recadrer la photo",
                contenuHtml: `
          <p class="form-note">Faites glisser l'image pour la positionner, et utilisez le curseur (ou la molette) pour zoomer. La zone visible correspond exactement a la photo enregistree.</p>
          <div class="recadrage">
            <canvas id="rec-canvas" width="${V}" height="${V}"></canvas>
          </div>
          <label class="field field--full" style="margin-top:12px;">
            <span>Zoom</span>
            <input type="range" id="rec-zoom" min="1" max="4" step="0.01" value="1">
          </label>
          <div class="modal__actions" style="position:static;margin:12px 0 0;padding-top:12px;">
            <button type="button" class="btn btn--ghost" id="rec-centrer">Recentrer</button>
            <button type="button" class="btn btn--ghost" id="rec-annuler">Annuler</button>
            <button type="button" class="btn btn--primary" id="rec-valider">Appliquer</button>
          </div>`,
                onMonte: (contenu, fermerModale) => {
                    const canvas = contenu.querySelector("#rec-canvas");
                    const ctx = canvas.getContext("2d");
                    const curseurZoom = contenu.querySelector("#rec-zoom");
                    const dessiner = () => {
                        contraindre();
                        const { l, h } = dimensions();
                        ctx.clearRect(0, 0, V, V);
                        ctx.drawImage(img, decalageX, decalageY, l, h);
                    };
                    dessiner();
                    // Deplacement (souris et tactile via les evenements pointeur).
                    let glisse = false, xDepart = 0, yDepart = 0;
                    canvas.addEventListener("pointerdown", (e) => {
                        glisse = true;
                        xDepart = e.clientX - decalageX;
                        yDepart = e.clientY - decalageY;
                        canvas.setPointerCapture(e.pointerId);
                    });
                    canvas.addEventListener("pointermove", (e) => {
                        if (!glisse)
                            return;
                        decalageX = e.clientX - xDepart;
                        decalageY = e.clientY - yDepart;
                        dessiner();
                    });
                    const finGlisse = () => { glisse = false; };
                    canvas.addEventListener("pointerup", finGlisse);
                    canvas.addEventListener("pointercancel", finGlisse);
                    // Zoom centre sur le milieu de la zone.
                    const appliquerZoom = (nouveau) => {
                        const ancien = zoom;
                        zoom = Math.min(4, Math.max(1, nouveau));
                        const facteur = zoom / ancien;
                        decalageX = V / 2 - (V / 2 - decalageX) * facteur;
                        decalageY = V / 2 - (V / 2 - decalageY) * facteur;
                        curseurZoom.value = String(zoom);
                        dessiner();
                    };
                    curseurZoom.addEventListener("input", () => appliquerZoom(Number(curseurZoom.value)));
                    canvas.addEventListener("wheel", (e) => {
                        e.preventDefault();
                        appliquerZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
                    }, { passive: false });
                    contenu.querySelector("#rec-centrer").addEventListener("click", () => {
                        zoom = 1;
                        curseurZoom.value = "1";
                        centrer();
                        dessiner();
                    });
                    contenu.querySelector("#rec-annuler").addEventListener("click", fermerModale);
                    contenu.querySelector("#rec-valider").addEventListener("click", () => {
                        contraindre();
                        const { l, h } = dimensions();
                        const facteur = SORTIE / V;
                        const sortie = document.createElement("canvas");
                        sortie.width = SORTIE;
                        sortie.height = SORTIE;
                        const c = sortie.getContext("2d");
                        c.fillStyle = "#FFFFFF";
                        c.fillRect(0, 0, SORTIE, SORTIE);
                        c.drawImage(img, decalageX * facteur, decalageY * facteur, l * facteur, h * facteur);
                        termine = true;
                        resolve(sortie.toDataURL("image/jpeg", 0.88));
                        fermerModale();
                    });
                },
                // Fermeture par la croix, l'arriere-plan ou Echap : aucun recadrage.
                onFerme: () => { if (!termine) resolve(null); },
            });
        };
        img.src = dataUrl;
    });
}
function avatarHtml(dataUrl, label, size = "sm") {
    const cls = `avatar-img avatar-img--${size}`;
    if (dataUrl)
        return `<img src="${dataUrl}" class="${cls}" alt="${escapeHtml(label)}">`;
    const initials = escapeHtml((label || "?").trim().slice(0, 2).toUpperCase());
    return `<span class="${cls} avatar-img--placeholder">${initials}</span>`;
}
// ------------------------------------------------------------------------
// 5. REGLES METIER (portage des fonctions VBA)
// ------------------------------------------------------------------------
// Doublon : meme numero d'electeur, OU meme numero de carte membre (ce
// dernier uniquement compare lorsqu'il est effectivement renseigne, puisque
// la majorite des membres n'ont pas de carte membre).
async function membreEstDoublon(numeroElecteur, numeroCarteMembre, excludeId) {
    const matches = await db.membres
        .filter(m => m.id !== excludeId && ((!!numeroElecteur && m.numeroElecteur === numeroElecteur) ||
        (!!numeroCarteMembre && m.numeroCarteMembre === numeroCarteMembre)))
        .count();
    return matches > 0;
}
async function celluleEstDoublon(responsableId, tresorierId, secretaireId, excludeId) {
    if (!responsableId && !tresorierId && !secretaireId)
        return false;
    const matches = await db.cellules
        .filter(c => c.id !== excludeId && c.responsableCelluleId === responsableId && c.tresorierGeneralId === tresorierId && c.secretaireGeneralId === secretaireId)
        .count();
    return matches > 0;
}
async function sectionEstDoublon(responsableId, tresorierId, secretaireId, excludeId) {
    if (!responsableId && !tresorierId && !secretaireId)
        return false;
    const matches = await db.sections
        .filter(s => s.id !== excludeId && s.responsableSectionId === responsableId && s.tresorierGeneralId === tresorierId && s.secretaireGeneralId === secretaireId)
        .count();
    return matches > 0;
}
// Regle metier impérative : tout membre affecte a un role du bureau d'une
// cellule (ou d'une section) doit obligatoirement appartenir a cette meme
// cellule (ou section). Un membre n'appartient qu'a une seule cellule et
// qu'a une seule section (champ unique celluleId / sectionId sur Membre).
async function bureauEstValide(kind, structureId, roles, payload) {
    const rolesTenus = new Map(); // membreId -> role deja attribue
    for (const role of roles) {
        const membreId = payload[role.key];
        if (!membreId)
            continue;
        const membre = await db.membres.get(Number(membreId));
        if (!membre)
            return { ok: false, message: `Membre introuvable pour le role "${role.label}".` };
        const appartientBien = kind === "cellule" ? membre.celluleId === structureId : membre.sectionId === structureId;
        if (!appartientBien) {
            return { ok: false, message: `"${nomComplet(membre)}" n'appartient pas a cette ${kind}. Le bureau d'une ${kind} doit imperativement etre compose de membres de cette meme ${kind}.` };
        }
        const idNum = Number(membreId);
        if (rolesTenus.has(idNum)) {
            return { ok: false, message: `"${nomComplet(membre)}" ne peut pas occuper deux postes a la fois ("${rolesTenus.get(idNum)}" et "${role.label}").` };
        }
        rolesTenus.set(idNum, role.label);
    }
    return { ok: true, message: "" };
}
// Un bureau n'est considere "complet" que lorsque tous ses postes sont pourvus.
function bureauCompletude(item, roles) {
    const pourvus = roles.filter(r => !!item[r.key]).length;
    return { pourvus, total: roles.length, complet: pourvus === roles.length };
}
// Normalise un libelle de colonne CSV pour la comparaison (minuscule, sans accents).
function normalizeHeader(s) {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}
// Parseur CSV minimal (sans dependance externe) : detecte automatiquement le
// separateur (`,` ou `;`), gere les champs entre guillemets (avec `""` pour
// echapper un guillemet) et les fins de ligne CRLF/LF.
function parseCSV(text) {
    const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const firstLine = src.slice(0, src.indexOf("\n") > -1 ? src.indexOf("\n") : src.length);
    const delim = firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (inQuotes) {
            if (c === '"') {
                if (src[i + 1] === '"') {
                    field += '"';
                    i++;
                }
                else {
                    inQuotes = false;
                }
            }
            else
                field += c;
        }
        else {
            if (c === '"')
                inQuotes = true;
            else if (c === delim) {
                row.push(field);
                field = "";
            }
            else if (c === "\n") {
                row.push(field);
                rows.push(row);
                row = [];
                field = "";
            }
            else
                field += c;
        }
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return rows.filter(r => r.some(c => c.trim() !== ""));
}
// Serialise un tableau de lignes en texte CSV (separateur virgule, guillemets
// echappes au besoin).
// Le point-virgule est utilise comme separateur (et non la virgule) car
// c'est le separateur de liste par defaut d'Excel en configuration
// francophone : avec une virgule, Excel regroupe tous les champs dans une
// seule cellule a l'ouverture directe du fichier au lieu de les repartir
// correctement en colonnes. parseCSV() (a l'import) detecte de toute facon
// automatiquement le separateur utilise, virgule ou point-virgule.
function toCSV(rows) {
    return rows.map(r => r.map(v => {
        const s = String(v ?? "");
        return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(";")).join("\r\n");
}
// Genere le contenu d'un modele CSV (en-tete + ligne d'exemple) pour l'import
// en masse de Membres, Cellules ou Sections. Les en-tetes correspondent aux
// libelles utilises dans les formulaires (voir FIELD_DEFS) afin que les
// colonnes soient reconnues automatiquement lors de l'import.
function csvModele(kind) {
    if (kind === "membre") {
        const header = ["Nom", "Prenom", "Date de naissance", "Lieu de naissance", "Sexe",
            "Zone electorale", "Departement (ou Pays si Etranger)", "Commune (ou Localite si Etranger)",
            "Quartier / Village", "Numero de telephone", "Email",
            "Date de delivrance CNI", "Date d'expiration CNI",
            "Electeur", "Commune de vote", "Numero d'electeur", "Lieu de vote", "Bureau de vote",
            "Adhesion", "Annee d'adhesion", "Carte membre", "N° carte membre",
            "Fonction", "Mouvements affilies", "Cellule", "Section"];
        const exemple = ["Diop", "Awa", "15/03/1990", "Dakar", "F",
            "National", "RUFISQUE", "TIVAOUANE PEULH - NIAGA", "Keur Awa", "771234567", "awa.diop@email.com",
            "01/01/2015", "01/01/2030",
            "Oui", "TIVAOUANE PEULH - NIAGA", "123456789", "Ecole 1", "01",
            "Nouveau", "2024", "Oui", "M-0001",
            "Menagere", "Mouvement des femmes ; Jeunesse active", "", ""];
        return toCSV([header, exemple]);
    }
    if (kind === "cellule") {
        const header = ["Nom de la cellule", "Quartier", "Contact du responsable", "Section de rattachement"];
        const exemple = ["Cellule A", "Keur Awa", "771234567", ""];
        return toCSV([header, exemple]);
    }
    const header = ["Nom de la section", "Contact du responsable section"];
    const exemple = ["Section A", "771234567"];
    return toCSV([header, exemple]);
}
// Declenche le telechargement d'un fichier texte (modele CSV) depuis le
// navigateur. Un BOM UTF-8 est ajoute pour que les accents s'affichent
// correctement a l'ouverture dans Excel.
// Les fichiers JSON / GeoJSON sont ecrits sans BOM (il rendrait le fichier
// illisible par la plupart des analyseurs JSON), contrairement au CSV ou le
// BOM garantit l'affichage correct des accents dans Excel.
function telechargerFichierTexte(nomFichier, contenu) {
    const estJson = /\.(geo)?json$/i.test(nomFichier);
    const blob = estJson
        ? new Blob([contenu], { type: "application/json;charset=utf-8;" })
        : new Blob(["\ufeff" + contenu], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nomFichier;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// Interprete une date saisie au format jj/mm/aaaa ou aaaa-mm-jj et la
// renvoie au format ISO (aaaa-mm-jj) attendu par le reste de l'application.
// Renvoie une chaine vide si la date est absente ou invalide.
function parseDateFlexible(s) {
    const v = (s || "").trim();
    if (!v)
        return "";
    let m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m)
        return v;
    m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
        const jj = m[1].padStart(2, "0"), mm = m[2].padStart(2, "0"), aaaa = m[3];
        return `${aaaa}-${mm}-${jj}`;
    }
    return "";
}
// `differerSync` est utilise par l'import CSV en masse : la renumerotation
// des references n'est alors effectuee qu'une seule fois, a la fin.
async function ajouterMembre(data, differerSync = false) {
    if (await membreEstDoublon(data.numeroElecteur, data.numeroCarteMembre)) {
        return { ok: false, message: "Doublon detecte : un membre avec ce numero d'electeur et/ou de carte membre existe deja." };
    }
    const numero = await nextNumero(db.membres);
    const now = new Date().toISOString();
    const cellule = data.celluleId ? await db.cellules.get(data.celluleId) : undefined;
    const rang = rangDansCellule(await db.membres.toArray(), data.celluleId);
    const reference = memberReference(rang, data.prenom, data.nom, data.dateNaissance, cellule?.reference);
    await db.membres.add({ ...data, numero, reference, createdAt: now, updatedAt: now });
    if (!differerSync)
        await resynchroniserReferencesMembres();
    return { ok: true, message: "Membre ajoute avec succes." };
}
// Import CSV en masse : meme resultat que ajouterMembre() applique ligne par
// ligne (doublons, numero, rang et reference calcules de la meme facon), mais
// envoye au serveur en une seule operation plutot qu'un aller-retour par ligne.
async function ajouterMembresEnMasse(liste) {
    const [existants, cellules] = await Promise.all([db.membres.toArray(), db.cellules.toArray()]);
    const electeurs = new Set(existants.map(m => m.numeroElecteur).filter(Boolean));
    const cartes = new Set(existants.map(m => m.numeroCarteMembre).filter(Boolean));
    const refCellule = new Map(cellules.map(c => [c.id, c.reference]));
    const rangs = new Map();
    let numero = 0;
    for (const m of existants) {
        const cle = m.celluleId || null;
        rangs.set(cle, (rangs.get(cle) || 0) + 1);
        const n = Number(m.numero);
        if (isFinite(n) && n > numero)
            numero = n;
    }
    const now = new Date().toISOString();
    const lignes = [];
    let ko = 0;
    for (const data of liste) {
        if ((data.numeroElecteur && electeurs.has(data.numeroElecteur)) || (data.numeroCarteMembre && cartes.has(data.numeroCarteMembre))) {
            ko++;
            continue;
        }
        if (data.numeroElecteur)
            electeurs.add(data.numeroElecteur);
        if (data.numeroCarteMembre)
            cartes.add(data.numeroCarteMembre);
        numero++;
        const cle = data.celluleId || null;
        const rang = (rangs.get(cle) || 0) + 1;
        rangs.set(cle, rang);
        const reference = memberReference(rang, data.prenom, data.nom, data.dateNaissance, data.celluleId ? refCellule.get(data.celluleId) : undefined);
        lignes.push({ ...data, numero, reference, createdAt: now, updatedAt: now });
    }
    if (lignes.length)
        await db.membres.bulkAdd(lignes);
    return { ok: lignes.length, ko };
}
// `differerSync` est utilise par l'import CSV en masse : la renumerotation
// des references n'est alors effectuee qu'une seule fois, a la fin.
async function ajouterCellule(data, differerSync = false) {
    if (await celluleEstDoublon(data.responsableCelluleId, data.tresorierGeneralId, data.secretaireGeneralId)) {
        return { ok: false, message: "Doublon detecte : une cellule avec les memes responsables existe deja." };
    }
    const numero = await nextNumero(db.cellules);
    const now = new Date().toISOString();
    const id = await db.cellules.add({ ...data, numero, reference: structureReference("C", numero, data.nom), createdAt: now, updatedAt: now });
    const check = await bureauEstValide("cellule", id, CELLULE_BUREAU_ROLES, data);
    if (!check.ok) {
        await db.cellules.delete(id);
        return check;
    }
    if (!differerSync)
        await synchroniserReferences();
    return { ok: true, message: "Bureau de cellule ajoute avec succes." };
}
async function ajouterSection(data, differerSync = false) {
    if (await sectionEstDoublon(data.responsableSectionId, data.tresorierGeneralId, data.secretaireGeneralId)) {
        return { ok: false, message: "Doublon detecte : une section avec les memes responsables existe deja." };
    }
    const numero = await nextNumero(db.sections);
    const now = new Date().toISOString();
    const id = await db.sections.add({ ...data, numero, reference: structureReference("S", numero, data.nom, "_TPN"), createdAt: now, updatedAt: now });
    const check = await bureauEstValide("section", id, SECTION_BUREAU_ROLES, data);
    if (!check.ok) {
        await db.sections.delete(id);
        return check;
    }
    if (!differerSync)
        await synchroniserReferences();
    return { ok: true, message: "Bureau de section ajoute avec succes." };
}
let currentView = "dashboard";
let editingEntity = null;
let fichePreouverte = null; // id de membre a afficher automatiquement (ouvert depuis un autre ecran)
let navHasBeenClicked = false;
const APP_ROOT = () => document.getElementById("app-root");
// Logo de marque SGBD Mory — monogramme reseau (Membres / Cellules / Sections)
// reutilise a l'identique sur l'ecran de connexion et dans la sidebar.
const LOGO_SVG = `
<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Logo SGBD Mory">
  <defs>
    <linearGradient id="logoGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#006725"/>
      <stop offset="100%" stop-color="#9F1A16"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="48" height="48" rx="12" fill="url(#logoGrad)"/>
  <g stroke="#FBE3E1" stroke-width="1.6" fill="none" opacity="0.9">
    <line x1="24" y1="15" x2="14" y2="24"/>
    <line x1="24" y1="15" x2="34" y2="24"/>
    <line x1="14" y1="24" x2="24" y2="33"/>
    <line x1="34" y1="24" x2="24" y2="33"/>
    <line x1="14" y1="24" x2="34" y2="24"/>
  </g>
  <circle cx="24" cy="15" r="3.6" fill="#FFFFFF"/>
  <circle cx="14" cy="24" r="3.6" fill="#FFFFFF"/>
  <circle cx="34" cy="24" r="3.6" fill="#FFFFFF"/>
  <circle cx="24" cy="33" r="3.6" fill="#FFFFFF"/>
</svg>`;
// Logo officiel PASTEF (fourni par l'utilisateur), encode en base64 pour un fichier autonome.
const PASTEF_LOGO_B64 = "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";

// Filigrane (watermark) applique en fond de chaque module.
const WATERMARK_IMG_B64 = "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";
// ------------------------------------------------------------------------
// 7. RENDU — PAGE D'ACCUEIL (presentation)
// ------------------------------------------------------------------------
function renderHome() {
    document.body.classList.add("on-login");
    APP_ROOT().innerHTML = `
    <div class="home-screen">
      <div class="home-card">
        <img class="home-card__logo" src="data:image/png;base64,${PASTEF_LOGO_B64}" alt="Logo PASTEF - Patriotes du Senegal" />
        <h1 class="home-card__title">SGBD Mory</h1>
        <p class="home-card__subtitle">Systeme de Gestion &middot; Membres &middot; Cellules &middot; Sections</p>
        <p class="home-card__desc">
          Plateforme de gestion des adherents, cellules et sections. Enregistrement des membres,
          suivi du maillage territorial et pilotage des donnees d'organisation, en un seul endroit.
        </p>
        <button type="button" class="btn btn--primary btn--block home-card__cta" id="home-enter-btn">
          Acceder a l'application <span class="arrow">&#8594;</span>
        </button>
      </div>
    </div>
  `;
    $("#home-enter-btn").addEventListener("click", () => {
        renderLogin();
    });
}
// ------------------------------------------------------------------------
// 8. RENDU — PAGE DE CONNEXION
// ------------------------------------------------------------------------
function renderLogin() {
    document.body.classList.add("on-login");
    APP_ROOT().innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-brand">
          <span class="login-brand__badge">${LOGO_SVG}</span>
          <h1>SGBD Mory</h1>
          <p>Systeme de Gestion &middot; Membres &middot; Cellules &middot; Sections</p>
        </div>
        <form id="login-form" class="login-form" autocomplete="off">
          <div class="login-photo-preview" id="login-photo-preview"></div>
          <label class="field">
            <span>Identifiant</span>
            <input type="text" id="login-user" required placeholder="ex: admin" />
          </label>
          <label class="field">
            <span>Mot de passe</span>
            <input type="password" id="login-pass" required placeholder="********" />
          </label>
          <button type="submit" class="btn btn--primary btn--block">Se connecter</button>
          <p class="login-hint">Compte de demonstration : <b>admin</b> / <b>admin123</b> (Administrateur principal)</p>
        </form>
      </div>
    </div>
  `;
    const loginUserInput = $("#login-user");
    const loginPreview = $("#login-photo-preview");
    let previewTimer;
    loginUserInput.addEventListener("input", () => {
        window.clearTimeout(previewTimer);
        const val = loginUserInput.value.trim();
        previewTimer = window.setTimeout(async () => {
            if (!val) {
                loginPreview.innerHTML = "";
                return;
            }
            const user = await sgbdApi.loginPreview(val);
            loginPreview.innerHTML = user
                ? `${avatarHtml(user.photoDataUrl, user.identifiant, "lg")}<span class="login-photo-preview__name">${escapeHtml(user.identifiant)}</span>`
                : "";
        }, 200);
    });
    $("#login-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const identifiant = $("#login-user").value.trim();
        const pass = $("#login-pass").value;
        const session = await login(identifiant, pass);
        if (session) {
            document.body.classList.remove("on-login");
            toast(`Bienvenue, ${session.identifiant} (${ROLE_LABELS[session.role]})`, "success");
            currentView = "dashboard";
            render();
        }
        else {
            toast("Identifiant ou mot de passe incorrect, ou compte desactive.", "error");
        }
    });
}
// ------------------------------------------------------------------------
// 8. RENDU — SHELL APPLICATIF (sidebar + topbar)
// ------------------------------------------------------------------------
function navItem(view, label, icon, visible) {
    if (!visible)
        return "";
    const active = navHasBeenClicked && currentView === view ? "nav-link--active" : "";
    return `<button class="nav-link ${active}" data-view="${view}"><span class="nav-icon">${icon}</span>${label}</button>`;
}
async function renderShell() {
    const session = getSession();
    const sessionUser = await db.users.get(session.userId);
    const mods = sessionUser ? modulesEffectifs(sessionUser) : modulesParDefaut(session.role);
    const hasMod = (id) => mods.includes(id);
    // Si la vue courante n'est plus autorisee (module retire entretemps),
    // on retombe sur le premier module accessible.
    const viewModule = {
        dashboard: "dashboard", membres: "membres", cellules: "cellules",
        sections: "sections", cartographie: "cartographie", massification: "massification",
        electorale: "electorale", transferts: "transferts", utilisateurs: "utilisateurs",
    };
    if (!hasMod(viewModule[currentView]) || (currentView === "utilisateurs" && !can(session.role, "manageUsers"))) {
        const ordre = ["dashboard", "membres", "cellules", "sections", "cartographie", "massification", "electorale", "transferts", "utilisateurs"];
        const fallback = ordre.find(v => hasMod(viewModule[v]) && (v !== "utilisateurs" || can(session.role, "manageUsers")));
        currentView = fallback ?? "dashboard";
    }
    APP_ROOT().innerHTML = `
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <div class="sidebar__brand">
          <span class="login-brand__badge login-brand__badge--sm">${LOGO_SVG}</span>
          <div>
            <div class="sidebar__title">SGBD Mory</div>
            <div class="sidebar__subtitle">Département de Rufisque</div>
          </div>
        </div>
        <nav class="sidebar__nav">
          ${navItem("membres", "Membres", "&#128100;", hasMod("membres"))}
          ${navItem("cellules", "Cellules", "&#127961;", hasMod("cellules"))}
          ${navItem("sections", "Sections", "&#128506;", hasMod("sections"))}
          ${navItem("cartographie", "Cartographie", "&#127757;", hasMod("cartographie"))}
          ${navItem("massification", "Massification", "&#128200;", hasMod("massification"))}
          ${navItem("electorale", "Carte electorale", "&#128499;", hasMod("electorale"))}
          ${navItem("transferts", "Transferts, Renouvellement &amp; Non inscrits", "&#9888;", hasMod("transferts"))}
          ${navItem("dashboard", "Tableau de bord", "&#9737;", hasMod("dashboard"))}
          ${navItem("utilisateurs", "Utilisateurs", "&#128272;", can(session.role, "manageUsers") && hasMod("utilisateurs"))}
        </nav>
        <div class="sidebar__footer">
          <div class="user-chip">
            <div class="user-chip__avatar">${avatarHtml(sessionUser?.photoDataUrl, session.identifiant, "sm")}</div>
            <div>
              <div class="user-chip__name">${session.identifiant}</div>
              <div class="user-chip__role">${ROLE_LABELS[session.role]}</div>
            </div>
          </div>
          <button class="btn btn--ghost btn--block" id="logout-btn">Se deconnecter</button>
        </div>
      </aside>
      <div class="app-main">
        <header class="topbar">
          <button class="hamburger" id="hamburger-btn" aria-label="Menu">&#9776;</button>
          <h2 id="view-title" class="topbar__title"></h2>
          <div class="topbar__role-badge">${ROLE_LABELS[session.role]}</div>
        </header>
        <main class="view-container" id="view-container"></main>
      </div>
    </div>
    <div class="sidebar-overlay" id="sidebar-overlay"></div>
  `;
    $("#logout-btn").addEventListener("click", logout);
    $("#hamburger-btn").addEventListener("click", () => {
        $("#sidebar").classList.add("sidebar--open");
        $("#sidebar-overlay").classList.add("sidebar-overlay--show");
    });
    $("#sidebar-overlay").addEventListener("click", () => closeSidebar());
    document.querySelectorAll(".nav-link").forEach(btn => {
        btn.addEventListener("click", () => {
            currentView = btn.dataset.view;
            editingEntity = null;
            fichePreouverte = null;
            navHasBeenClicked = true;
            document.querySelectorAll(".nav-link").forEach(l => l.classList.toggle("nav-link--active", l.dataset.view === currentView));
            closeSidebar();
            renderView();
        });
    });
    renderView();
}
function closeSidebar() {
    $("#sidebar").classList.remove("sidebar--open");
    $("#sidebar-overlay").classList.remove("sidebar-overlay--show");
}
const VIEW_TITLES = {
    dashboard: "Tableau de bord",
    membres: "Département de Rufisque",
    cellules: "Gestion des cellules",
    sections: "Gestion des sections",
    cartographie: "Cartographie",
    massification: "Massification",
    electorale: "Carte electorale",
    transferts: "Transferts, Renouvellement & Non inscrits",
    utilisateurs: "Gestion des utilisateurs",
};
async function renderView() {
    $("#view-title").textContent = VIEW_TITLES[currentView];
    // La carte du module Cartographie est detruite des qu'on quitte la vue :
    // son conteneur disparait avec le HTML, mais Leaflet garde sinon des
    // ecouteurs actifs (redimensionnement de la fenetre, etc.).
    if (carteModuleCtx && currentView !== "cartographie") {
        try {
            carteModuleCtx.map.remove();
        }
        catch { /* carte deja detruite */ }
        carteModuleCtx = null;
    }
    if (carteAnalyseCtx && currentView !== "massification") {
        try {
            carteAnalyseCtx.map.remove();
        }
        catch { /* carte deja detruite */ }
        carteAnalyseCtx = null;
    }
    const container = $("#view-container");
    container.innerHTML = `<div class="loading">Chargement...</div>`;
    const session = getSession();
    if (session) {
        const mods = await modulesUtilisateurCourant();
        const viewModule = {
            dashboard: "dashboard", membres: "membres", cellules: "cellules",
            sections: "sections", cartographie: "cartographie", massification: "massification",
            electorale: "electorale", transferts: "transferts", utilisateurs: "utilisateurs",
        };
        const autorise = mods.includes(viewModule[currentView]) && (currentView !== "utilisateurs" || can(session.role, "manageUsers"));
        if (!autorise) {
            container.innerHTML = emptyState("Acces non autorise a ce module.");
            return;
        }
    }
    switch (currentView) {
        case "dashboard": return renderDashboard(container);
        case "membres": return renderEntityView(container, "membre");
        case "cellules": return renderEntityView(container, "cellule");
        case "sections": return renderEntityView(container, "section");
        case "cartographie": return renderCartographieView(container);
        case "massification": return renderMassificationView(container);
        case "electorale": return renderElectoraleView(container);
        case "transferts": return renderTransfertsView(container);
        case "utilisateurs": return renderUsersView(container);
    }
}
let sousOngletTransferts = "renouvellement";
// Date limite (facultative, saisie par l'utilisateur) : en plus des CNI deja
// expirees (toujours affichees), affiche egalement les CNI qui arriveront a
// expiration avant cette date — pour anticiper les renouvellements a venir.
let dateLimiteRenouvellement = "";
// Commune de residence (facultative) : restreint les deux listes (Renouvellement
// et Transferts) aux membres de cette seule commune.
let communeFiltreTransferts = "";
async function renderTransfertsView(container) {
    const session = getSession();
    const peutTraiter = can(session.role, "editData");
    const mods = await modulesUtilisateurCourant();
    let peutRenouvellement = mods.includes("transferts.renouvellement");
    let peutTransferts = mods.includes("transferts.transferts");
    let peutNonInscrits = mods.includes("transferts.noninscrits");
    // Si aucun des sous-modules n'est explicitement accorde (compte cree
    // avant cette fonctionnalite, ou case a cocher parent laissee seule), on
    // autorise tous les onglets par defaut plutot que d'afficher une page vide.
    if (!peutRenouvellement && !peutTransferts && !peutNonInscrits) {
        peutRenouvellement = true;
        peutTransferts = true;
        peutNonInscrits = true;
    }
    const ongletsAutorises = [peutRenouvellement && "renouvellement", peutTransferts && "transferts", peutNonInscrits && "noninscrits"].filter(Boolean);
    if (!ongletsAutorises.includes(sousOngletTransferts))
        sousOngletTransferts = ongletsAutorises[0];
    const [membres, cellules, sections, bureauxElectoraux] = await Promise.all([db.membres.toArray(), db.cellules.toArray(), db.sections.toArray(), db.bureauxVote.toArray()]);
    const rattachement = (m) => {
        const c = cellules.find(c => c.id === m.celluleId)?.nom;
        const s = sections.find(s => s.id === m.sectionId)?.nom;
        return [c, s].filter(Boolean).join(" / ") || "—";
    };
    // Les cas deja traites restent affiches (historique) : une fois traite,
    // un membre ne remplit plus le critere automatique (CNI a jour, commune de
    // vote revenue dans la zone) mais doit rester tracable dans le module.
    // Seuil optionnel choisi par l'utilisateur : une CNI qui expirera avant
    // cette date (mais n'a pas encore expire) est egalement remontee, en plus
    // des CNI deja expirees (toujours incluses).
    const seuilRenouvellement = dateLimiteRenouvellement ? new Date(dateLimiteRenouvellement) : null;
    const cniExpireBientot = (m) => !!seuilRenouvellement && !estCniExpiree(m) && !!m.dateExpirationCNI && new Date(m.dateExpirationCNI) <= seuilRenouvellement;
    const motifRenouvellement = (m) => {
        if (estCniExpiree(m))
            return "CNI expiree";
        if (cniExpireBientot(m))
            return `CNI expire avant le ${formatDateJJMMAAAA(dateLimiteRenouvellement)}`;
        return "CNI (traite)";
    };
    // Liste des communes de residence presentes parmi les membres, pour le
    // filtre optionnel "commune" applique aux deux listes ci-dessous.
    const communesDisponibles = [...new Set(membres.map(m => m.commune).filter(Boolean))].sort((a, b) => a.localeCompare(b, "fr"));
    if (communeFiltreTransferts && !communesDisponibles.includes(communeFiltreTransferts))
        communeFiltreTransferts = "";
    const parCommune = (m) => !communeFiltreTransferts || m.commune === communeFiltreTransferts;
    const renouvellement = membres.filter(m => (estCniExpiree(m) || cniExpireBientot(m) || !!m.renouvellementTraiteLe) && parCommune(m));
    const transferts = membres.filter(m => (estHorsZone(m) || !!m.transfertTraiteLe) && parCommune(m));
    // Non inscrit sur le fichier electoral : Electeur = Non (un champ Electeur
    // laisse vide n'est pas considere comme non inscrit).
    const nonInscrits = membres.filter(m => m.electeur === "Non" && parCommune(m))
        .sort((a, b) => nomComplet(a).localeCompare(nomComplet(b), "fr"));
    const renouvellementEnAttente = renouvellement.filter(m => !m.renouvellementTraiteLe);
    const transfertsEnAttente = transferts.filter(m => !m.transfertTraiteLe);
    const nonInscritsEnAttente = nonInscrits.filter(m => !m.nonInscritTraiteLe);
    const dresserTableau = (liste, motif, dateCol, traiteLe, action) => {
        if (!liste.length)
            return emptyState(`Aucun cas de ${(typeof motif === "function" ? "renouvellement" : motif.toLowerCase())} pour le moment.`);
        const aTraiter = liste.filter(m => !traiteLe(m));
        const traites = liste.filter(m => !!traiteLe(m));
        const ligne = (m) => {
            const estTraite = !!traiteLe(m);
            const motifLigne = typeof motif === "function" ? motif(m) : motif;
            return `
        <tr class="data-row--clickable" data-view-row="${m.id}">
          <td>${avatarHtml(m.photoDataUrl, nomComplet(m), "sm")}</td>
          <td>${escapeHtml(nomComplet(m))}<div class="fiche-bureau-row__role">${escapeHtml(m.reference)}</div></td>
          <td>${escapeHtml(rattachement(m))}</td>
          <td>${escapeHtml(m.commune || "—")}</td>
          <td>${escapeHtml(motifLigne)}</td>
          <td>${escapeHtml(dateCol(m))}</td>
          <td>${estTraite
                ? `<span class="badge badge--success">Traite le ${formatDateJJMMAAAA(traiteLe(m))}</span>`
                : `<span class="badge badge--warn">A traiter</span>`}</td>
          <td class="row-actions">
            <button class="icon-btn" data-localiser="${m.id}" title="Recherche geographique — localiser sur la carte">&#127757;</button>
            <button class="icon-btn" data-corriger="${m.id}" title="Corriger la fiche">&#9998;</button>
            ${peutTraiter ? (estTraite
                ? `<button class="icon-btn" data-reprendre="${m.id}" data-action-type="${action}" title="Remettre a traiter">&#8635;</button>`
                : `<button class="icon-btn" data-marquer="${m.id}" data-action-type="${action}" title="Traiter ce cas">&#10003;</button>`) : ""}
          </td>
        </tr>`;
        };
        return `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>
            <th></th><th>Membre</th><th>Cellule / Section</th><th>Commune</th><th>Motif</th><th>Detecte le</th><th>Statut</th><th></th>
          </tr></thead>
          <tbody>${aTraiter.map(ligne).join("")}${traites.map(ligne).join("")}</tbody>
        </table>
      </div>`;
    };
    const dresserTableauNonInscrits = (liste) => {
        if (!liste.length)
            return emptyState("Aucun membre non inscrit sur le fichier electoral pour le moment.");
        const aTraiter = liste.filter(m => !m.nonInscritTraiteLe);
        const traites = liste.filter(m => !!m.nonInscritTraiteLe);
        const ligne = (m) => {
            const estTraite = !!m.nonInscritTraiteLe;
            return `
        <tr class="data-row--clickable" data-view-row="${m.id}">
          <td>${avatarHtml(m.photoDataUrl, nomComplet(m), "sm")}</td>
          <td>${escapeHtml(nomComplet(m))}<div class="fiche-bureau-row__role">${escapeHtml(m.reference)}</div></td>
          <td>${escapeHtml(formatDateJJMMAAAA(m.dateNaissance))}</td>
          <td>${escapeHtml(rattachement(m))}</td>
          <td>${escapeHtml(m.commune || "—")}</td>
          <td>${escapeHtml(m.quartierVillage || "—")}</td>
          <td>${escapeHtml(m.telephone || "—")}</td>
          <td>${estTraite
                ? `<span class="badge badge--success">Traite le ${formatDateJJMMAAAA(m.nonInscritTraiteLe)}</span>`
                : `<span class="badge badge--warn">A traiter</span>`}</td>
          <td class="row-actions">
            <button class="icon-btn" data-localiser="${m.id}" title="Recherche geographique — localiser sur la carte">&#127757;</button>
            <button class="icon-btn" data-corriger="${m.id}" title="Corriger la fiche (ex. passer Electeur a Oui apres inscription)">&#9998;</button>
            ${peutTraiter ? (estTraite
                ? `<button class="icon-btn" data-reprendre="${m.id}" data-action-type="noninscrits" title="Remettre a traiter">&#8635;</button>`
                : `<button class="icon-btn" data-marquer="${m.id}" data-action-type="noninscrits" title="Marquer comme traite">&#10003;</button>`) : ""}
          </td>
        </tr>`;
        };
        return `
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>
            <th></th><th>Membre</th><th>Date de naissance</th><th>Cellule / Section</th><th>Commune</th><th>Quartier / Village</th><th>Telephone</th><th>Statut</th><th></th>
          </tr></thead>
          <tbody>${aTraiter.map(ligne).join("")}${traites.map(ligne).join("")}</tbody>
        </table>
      </div>`;
    };
    container.innerHTML = `
    <div class="view-banner view-banner--red">
      <div class="view-banner__eyebrow">Suivi automatique</div>
      <h2 class="view-banner__title">Transferts, Renouvellement &amp; Non inscrits</h2>
      <p class="view-banner__subtitle">Listes alimentees automatiquement depuis les fiches Membre : CNI arrivant a expiration, membres votant Hors zone, et membres non inscrits sur le fichier electoral (Electeur = Non).</p>
    </div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-card__value">${renouvellementEnAttente.length}</div><div class="stat-card__label">CNI a renouveler</div></div>
      <div class="stat-card"><div class="stat-card__value">${transfertsEnAttente.length}</div><div class="stat-card__label">Membres Hors zone</div></div>
      <div class="stat-card"><div class="stat-card__value">${nonInscrits.length}</div><div class="stat-card__label">Non inscrits</div></div>
      <div class="stat-card"><div class="stat-card__value">${renouvellementEnAttente.length + transfertsEnAttente.length + nonInscritsEnAttente.length}</div><div class="stat-card__label">Cas encore a traiter</div></div>
      <div class="stat-card"><div class="stat-card__value">${renouvellement.length - renouvellementEnAttente.length + transferts.length - transfertsEnAttente.length + nonInscrits.length - nonInscritsEnAttente.length}</div><div class="stat-card__label">Cas traites</div></div>
    </div>
    <div class="btn-group">
      ${peutRenouvellement ? `<button type="button" class="btn ${sousOngletTransferts === "renouvellement" ? "btn--primary" : "btn--ghost"}" id="onglet-renouvellement">Renouvellement (${renouvellement.length})</button>` : ""}
      ${peutTransferts ? `<button type="button" class="btn ${sousOngletTransferts === "transferts" ? "btn--primary" : "btn--ghost"}" id="onglet-transferts">Transferts (${transferts.length})</button>` : ""}
      ${peutNonInscrits ? `<button type="button" class="btn ${sousOngletTransferts === "noninscrits" ? "btn--primary" : "btn--ghost"}" id="onglet-noninscrits">Non inscrits (${nonInscrits.length})</button>` : ""}
      <button type="button" class="btn btn--ghost" id="transferts-pdf">&#128438; Exporter PDF</button>
      <button type="button" class="btn btn--ghost" id="transferts-csv">&#8681; Exporter CSV</button>
    </div>
    <div class="filter-row" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:10px 0;">
      <label class="field" style="margin:0;"><span>Filtrer par commune</span>
        <select id="transferts-commune">
          <option value="">Toutes les communes</option>
          ${communesDisponibles.map(c => `<option value="${escapeHtml(c)}" ${c === communeFiltreTransferts ? "selected" : ""}>${escapeHtml(c)}</option>`).join("")}
        </select>
      </label>
    </div>
    ${sousOngletTransferts === "renouvellement" ? `
    <div class="filter-row" style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap;margin:10px 0;">
      <label class="field" style="margin:0;"><span>Voir aussi les CNI arrivant a expiration avant le</span>
        <input type="date" id="renouv-date-limite" value="${escapeHtml(dateLimiteRenouvellement)}">
      </label>
      <button type="button" class="btn btn--ghost" id="renouv-date-appliquer">Appliquer</button>
      ${dateLimiteRenouvellement ? `<button type="button" class="btn btn--ghost" id="renouv-date-reinitialiser">Reinitialiser (CNI deja expirees uniquement)</button>` : ""}
    </div>` : ""}
    <div id="transferts-content"></div>
  `;
    const content = $("#transferts-content");
    // --- Traitement d'un renouvellement : les nouvelles dates de CNI
    // remplacent automatiquement les anciennes valeurs sur la fiche membre.
    function traiterRenouvellement(membre) {
        const anneeCourante = new Date().getFullYear();
        ouvrirModale({
            titre: `Renouvellement de CNI — ${nomComplet(membre)}`,
            contenuHtml: `
        <p class="form-note">Renseignez les dates figurant sur la <b>nouvelle</b> carte nationale d'identite. Elles remplaceront automatiquement les valeurs actuelles de la fiche du membre.</p>
        <div class="fiche-grid" style="margin-bottom:14px;">
          <div class="fiche-row"><span class="fiche-row__label">Ancienne date de delivrance</span><span class="fiche-row__value">${formatDateJJMMAAAA(membre.dateDelivranceCNI)}</span></div>
          <div class="fiche-row"><span class="fiche-row__label">Ancienne date d'expiration</span><span class="fiche-row__value">${formatDateJJMMAAAA(membre.dateExpirationCNI)}</span></div>
        </div>
        <form id="renouv-form" class="entity-form" style="padding:0;">
          <label class="field"><span>Nouvelle date de delivrance *</span><input type="date" name="dateDelivranceCNI" value="${escapeHtml(membre.dateDelivranceCNI || "")}" required></label>
          <label class="field"><span>Nouvelle date d'expiration *</span><input type="date" name="dateExpirationCNI" value="${escapeHtml(membre.dateExpirationCNI || "")}" required></label>
          <div class="modal__actions" style="margin:10px 0 0;padding:14px 0 0;position:static;">
            <button type="button" class="btn btn--ghost" id="renouv-annuler">Annuler</button>
            <button type="submit" class="btn btn--primary">Enregistrer et marquer traite</button>
          </div>
        </form>`,
            onMonte: (contenu, fermer) => {
                contenu.querySelector("#renouv-annuler").addEventListener("click", fermer);
                contenu.querySelector("#renouv-form").onsubmit = async (e) => {
                    e.preventDefault();
                    const fd = new FormData(e.target);
                    const delivrance = String(fd.get("dateDelivranceCNI") || "");
                    const expiration = String(fd.get("dateExpirationCNI") || "");
                    if (!delivrance || !expiration) {
                        toast("Les deux dates sont obligatoires.", "error");
                        return;
                    }
                    if (new Date(expiration) <= new Date(delivrance)) {
                        toast("La date d'expiration doit etre posterieure a la date de delivrance.", "error");
                        return;
                    }
                    if (new Date(expiration).getFullYear() < anneeCourante) {
                        toast("La nouvelle date d'expiration est deja depassee : le membre resterait signale en renouvellement.", "error");
                        return;
                    }
                    await db.membres.update(membre.id, {
                        dateDelivranceCNI: delivrance,
                        dateExpirationCNI: expiration,
                        renouvellementTraiteLe: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    });
                    toast("Renouvellement traite : les dates de CNI ont ete mises a jour sur la fiche du membre.", "success");
                    fermer();
                    renderView();
                };
            },
        });
    }
    // --- Traitement d'un transfert : la commune de vote du membre est
    // alignee sur sa commune de residence (Identite), et le nouveau lieu et
    // bureau de vote (dans cette commune) doivent etre choisis AVANT de
    // valider — impossible de deviner un bureau precis automatiquement.
    async function traiterTransfert(membre) {
        const zone = membre.zoneElectorale === "Etranger" ? "Etranger" : "National";
        const nouvelleCommune = membre.commune || "";
        if (!nouvelleCommune) {
            toast("Ce membre n'a pas de commune de residence renseignee : impossible de determiner sa nouvelle commune de vote.", "error");
            return;
        }
        ouvrirModale({
            titre: `Transfert — ${nomComplet(membre)}`,
            contenuHtml: `
        <p class="form-note">La commune de vote va passer de "${escapeHtml(membre.communeVote || "—")}" a "${escapeHtml(nouvelleCommune)}" (sa commune de residence). Choisissez le nouveau lieu et bureau de vote avant de valider.</p>
        <form id="transfert-form" class="entity-form" style="padding:0;">
          ${comboboxHtml("lieuVoteTransfert", "Lieu de vote", true, "")}
          ${comboboxHtml("bureauVoteTransfert", "Bureau de vote", true, "")}
          <div class="modal__actions" style="margin:10px 0 0;padding:14px 0 0;position:static;">
            <button type="button" class="btn btn--ghost" id="transfert-annuler">Annuler</button>
            <button type="submit" class="btn btn--primary">Valider le transfert</button>
          </div>
        </form>`,
            onMonte: (contenu, fermer) => {
                const form = contenu.querySelector("#transfert-form");
                const lieuInput = form.querySelector('[name="lieuVoteTransfert"]');
                const bureauInput = form.querySelector('[name="bureauVoteTransfert"]');
                const lieuCombobox = attacherCombobox(form, "lieuVoteTransfert", () => lieuxDeVoteElectoraux(bureauxElectoraux, zone, nouvelleCommune));
                const bureauCombobox = attacherCombobox(form, "bureauVoteTransfert", () => bureauxDuLieuVote(bureauxElectoraux, zone, nouvelleCommune, lieuInput.value));
                lieuInput.addEventListener("change", () => { bureauInput.value = ""; bureauCombobox.rafraichir(); });
                contenu.querySelector("#transfert-annuler").addEventListener("click", fermer);
                form.onsubmit = async (e) => {
                    e.preventDefault();
                    const lieuVote = lieuInput.value.trim();
                    const bureauVote = bureauInput.value.trim();
                    const lieuxValides = lieuxDeVoteElectoraux(bureauxElectoraux, zone, nouvelleCommune);
                    const bureauxValides = bureauxDuLieuVote(bureauxElectoraux, zone, nouvelleCommune, lieuVote);
                    if (!lieuxValides.includes(lieuVote) || !bureauxValides.includes(bureauVote)) {
                        toast("Choisissez un lieu et un bureau de vote valides dans la liste (issus de la carte electorale importee).", "error");
                        return;
                    }
                    await db.membres.update(membre.id, {
                        communeVote: nouvelleCommune,
                        lieuVote, bureauVote,
                        transfertTraiteLe: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                    });
                    toast(`Transfert traite : commune de vote alignee sur "${nouvelleCommune}".`, "success");
                    fermer();
                    renderView();
                };
            },
        });
    }
    function dessiner() {
        content.innerHTML = sousOngletTransferts === "renouvellement"
            ? dresserTableau(renouvellement, motifRenouvellement, m => formatDateJJMMAAAA(m.dateExpirationCNI), m => m.renouvellementTraiteLe, "renouvellement")
            : sousOngletTransferts === "noninscrits"
                ? dresserTableauNonInscrits(nonInscrits)
                : dresserTableau(transferts, "Hors zone", m => `${m.commune || "—"} → ${m.communeVote || "—"}`, m => m.transfertTraiteLe, "transferts");
        content.querySelectorAll("[data-view-row]").forEach(row => {
            row.addEventListener("click", (e) => {
                if (e.target.closest(".row-actions"))
                    return;
                ouvrirFicheMembreDepuisAilleurs(Number(row.dataset.viewRow));
            });
        });
        content.querySelectorAll("[data-localiser]").forEach(b => b.addEventListener("click", () => ouvrirRechercheGeographique("membre", Number(b.dataset.localiser))));
        content.querySelectorAll("[data-corriger]").forEach(b => b.addEventListener("click", () => { currentView = "membres"; navHasBeenClicked = true; editingEntity = { kind: "membre", id: Number(b.dataset.corriger) }; renderShell(); }));
        content.querySelectorAll("[data-marquer]").forEach(b => b.addEventListener("click", () => {
            const membre = membres.find(m => m.id === Number(b.dataset.marquer));
            if (!membre)
                return;
            if (b.dataset.actionType === "renouvellement")
                traiterRenouvellement(membre);
            else if (b.dataset.actionType === "noninscrits") {
                if (!confirm(`Marquer ${nomComplet(membre)} comme traite (non inscrit pris en charge) ? Le membre reste dans la liste tant que son champ Electeur est « Non ».`))
                    return;
                db.membres.update(membre.id, { nonInscritTraiteLe: new Date().toISOString() }).then(() => {
                    toast("Cas marque comme traite.", "success");
                    renderView();
                });
            }
            else
                traiterTransfert(membre);
        }));
        content.querySelectorAll("[data-reprendre]").forEach(b => b.addEventListener("click", async () => {
            const id = Number(b.dataset.reprendre);
            if (b.dataset.actionType === "renouvellement") {
                if (!confirm("Remettre ce renouvellement a traiter ? Les dates de CNI enregistrees sont conservees."))
                    return;
                await db.membres.update(id, { renouvellementTraiteLe: undefined });
            }
            else if (b.dataset.actionType === "noninscrits") {
                if (!confirm("Remettre ce non inscrit a traiter ?"))
                    return;
                await db.membres.update(id, { nonInscritTraiteLe: undefined });
            }
            else {
                if (!confirm(`Remettre ce transfert a traiter ? La commune de vote du membre sera repositionnee sur "Hors zone".`))
                    return;
                await db.membres.update(id, { transfertTraiteLe: undefined, communeVote: "Hors zone" });
            }
            toast("Cas remis a traiter.", "info");
            renderView();
        }));
    }
    // --- Exports de la liste affichee (renouvellements OU transferts) -------
    const donneesExport = () => {
        const enRenouvellement = sousOngletTransferts === "renouvellement";
        const liste = enRenouvellement ? renouvellement : transferts;
        const entetes = ["N°", "Reference", "Prenom & nom", "Cellule / Section", "Commune", "Telephone", "Motif",
            enRenouvellement ? "Date d'expiration CNI" : "Commune de vote", "Statut", "Traite le"];
        const lignes = liste.map(m => [
            m.numero, m.reference, nomComplet(m), rattachement(m), m.commune || "—", m.telephone || "—",
            enRenouvellement ? motifRenouvellement(m) : "Hors zone",
            enRenouvellement ? formatDateJJMMAAAA(m.dateExpirationCNI) : (m.communeVote || "—"),
            (enRenouvellement ? m.renouvellementTraiteLe : m.transfertTraiteLe) ? "Traite" : "A traiter",
            formatDateJJMMAAAA(enRenouvellement ? m.renouvellementTraiteLe : m.transfertTraiteLe),
        ]);
        return { enRenouvellement, liste, entetes, lignes };
    };
    const exportNonInscrits = () => ({
        entetes: ["N°", "Reference", "Prenom & nom", "Date de naissance", "Cellule / Section", "Commune", "Quartier / Village", "Telephone", "Statut", "Traite le"],
        lignes: nonInscrits.map(m => [m.numero, m.reference, nomComplet(m), formatDateJJMMAAAA(m.dateNaissance), rattachement(m), m.commune || "—", m.quartierVillage || "—", m.telephone || "—", m.nonInscritTraiteLe ? "Traite" : "A traiter", formatDateJJMMAAAA(m.nonInscritTraiteLe)]),
    });
    $("#transferts-pdf").addEventListener("click", () => {
        if (sousOngletTransferts === "noninscrits") {
            if (!nonInscrits.length) {
                toast("Aucun membre non inscrit a exporter.", "info");
                return;
            }
            const { entetes, lignes } = exportNonInscrits();
            exporterPDF("Membres non inscrits sur le fichier electoral", `
      <div class="pdf-resume">
        <div class="pdf-tuile"><b>${nonInscrits.length}</b><span>Non inscrits</span></div>
        <div class="pdf-tuile"><b>${nonInscritsEnAttente.length}</b><span>A traiter</span></div>
        <div class="pdf-tuile"><b>${nonInscrits.length - nonInscritsEnAttente.length}</b><span>Traites</span></div>
      </div>
      ${communeFiltreTransferts ? `<div class="pdf-meta">Commune : ${escapeHtml(communeFiltreTransferts)}</div>` : ""}
      <h2>Membres dont le champ Electeur est « Non »</h2>
      ${tableauPDF(entetes, lignes)}`, "landscape");
            return;
        }
        const { enRenouvellement, liste, entetes, lignes } = donneesExport();
        if (!liste.length) {
            toast("Aucun cas a exporter dans cet onglet.", "info");
            return;
        }
        const traites = liste.filter(m => !!(enRenouvellement ? m.renouvellementTraiteLe : m.transfertTraiteLe)).length;
        exporterPDF(enRenouvellement ? "Renouvellements de CNI" : "Transferts (membres Hors zone)", `
      <div class="pdf-resume">
        <div class="pdf-tuile"><b>${liste.length}</b><span>Cas au total</span></div>
        <div class="pdf-tuile"><b>${liste.length - traites}</b><span>A traiter</span></div>
        <div class="pdf-tuile"><b>${traites}</b><span>Traites</span></div>
      </div>
      ${communeFiltreTransferts ? `<div class="pdf-meta">Commune : ${escapeHtml(communeFiltreTransferts)}</div>` : ""}
      <h2>${enRenouvellement ? (dateLimiteRenouvellement ? `Membres dont la CNI est deja expiree, ou expire avant le ${formatDateJJMMAAAA(dateLimiteRenouvellement)}` : "Membres dont la CNI est deja expiree") : "Membres a transferer (commune de vote hors zone)"}</h2>
      ${tableauPDF(entetes, lignes)}`, "landscape");
    });
    $("#transferts-csv").addEventListener("click", () => {
        if (sousOngletTransferts === "noninscrits") {
            if (!nonInscrits.length) {
                toast("Aucun membre non inscrit a exporter.", "info");
                return;
            }
            const { entetes, lignes } = exportNonInscrits();
            exporterCSV("membres_non_inscrits.csv", entetes, lignes);
            return;
        }
        const { enRenouvellement, liste, entetes, lignes } = donneesExport();
        if (!liste.length) {
            toast("Aucun cas a exporter dans cet onglet.", "info");
            return;
        }
        exporterCSV(enRenouvellement ? "renouvellements_cni.csv" : "transferts_hors_zone.csv", entetes, lignes);
    });
    dessiner();
    if (peutRenouvellement) $("#onglet-renouvellement").addEventListener("click", () => { sousOngletTransferts = "renouvellement"; renderView(); });
    if (peutTransferts) $("#onglet-transferts").addEventListener("click", () => { sousOngletTransferts = "transferts"; renderView(); });
    if (peutNonInscrits) $("#onglet-noninscrits").addEventListener("click", () => { sousOngletTransferts = "noninscrits"; renderView(); });
    $("#transferts-commune")?.addEventListener("change", (e) => {
        communeFiltreTransferts = e.target.value || "";
        renderView();
    });
    $("#renouv-date-appliquer")?.addEventListener("click", () => {
        const valeur = $("#renouv-date-limite")?.value || "";
        if (valeur && new Date(valeur) < new Date(new Date().toDateString())) {
            toast("La date choisie est deja passee : les CNI deja expirees sont de toute facon toujours affichees ci-dessus.", "info");
        }
        dateLimiteRenouvellement = valeur;
        renderView();
    });
    $("#renouv-date-reinitialiser")?.addEventListener("click", () => {
        dateLimiteRenouvellement = "";
        renderView();
    });
}
// Ouvre directement la fiche d'un membre depuis un autre ecran (ex. module
// Transferts et renouvellement) sans passer par la liste des Membres.
function ouvrirFicheMembreDepuisAilleurs(membreId) {
    currentView = "membres";
    navHasBeenClicked = true;
    editingEntity = null;
    fichePreouverte = membreId;
    renderShell();
}
// ------------------------------------------------------------------------
// 9. TABLEAU DE BORD
// ------------------------------------------------------------------------
// Onglets du tableau de bord : Membres jusqu'a Transferts et renouvellement,
// alignes en une seule rangee de boutons. Cliquer sur un onglet affiche les
// statistiques propres a ce module (graphiques diversifies selon la nature
// des donnees : barres a bascule Nombre/Taux pour les repartitions
// geographiques, classement pour les cellules, mini-jauges pour les taux de
// completude, comparaison simple pour Transferts/renouvellement).
const MODULES_DASHBOARD = [
    { id: "membres", label: "Membres", icone: "&#128100;" },
    { id: "cellules", label: "Cellules", icone: "&#127961;" },
    { id: "sections", label: "Sections", icone: "&#128209;" },
    { id: "cartographie", label: "Cartographie", icone: "&#128506;" },
    { id: "massification", label: "Massification", icone: "&#128200;" },
    { id: "electorale", label: "Carte electorale", icone: "&#128499;" },
    { id: "transferts", label: "Transferts, Renouvellement & Non inscrits", icone: "&#128260;" },
];
let dashboardOnglet = "membres";
async function renderDashboard(container) {
  const [membres, cellules, sections, bureauxElectoraux, couches] = await Promise.all([
    db.membres.toArray(), db.cellules.toArray(), db.sections.toArray(), db.bureauxVote.toArray(), db.couches.toArray(),
  ]);
  if (!MODULES_DASHBOARD.some(o => o.id === dashboardOnglet))
    dashboardOnglet = "membres";

  const nomCellule = (id) => cellules.find(c => c.id === id)?.nom || "Sans cellule";
  const nomSection = (id) => sections.find(s => s.id === id)?.nom || "Sans section";

  const byDeptGlobal = new Map();
  for (const m of membres) byDeptGlobal.set(m.departement || "Non renseigne", (byDeptGlobal.get(m.departement || "Non renseigne") || 0) + 1);

  // Barres statiques (sans bascule Nombre/Taux) : utilisees pour les
  // panneaux de synthese (Cartographie, Massification, Carte electorale).
  const barRows = (map, limit = 8) => {
    const entries = Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit);
    const max = Math.max(1, ...entries.map(([, v]) => v));
    return entries.map(([label, val]) => `
        <div class="bar-row">
          <div class="bar-row__label">${escapeHtml(label)}</div>
          <div class="bar-row__track"><div class="bar-row__fill" style="width:${(val / max) * 100}%"></div></div>
          <div class="bar-row__value">${val}</div>
        </div>`).join("");
  };

  // Panneau avec bascule Nombre/Taux (repartitions geographiques Membres/
  // Sections/Cellules) : renvoie le HTML du panneau ; l'appelant doit ensuite
  // appeler wireRepartitionPanels() une fois le HTML insere dans le DOM.
  const panelRepartitionHtml = (id, titre) => `
    <div class="panel">
      <div class="panel__header">
        <h3 class="panel__title">${escapeHtml(titre)}</h3>
        <div class="btn-group" style="margin:0;gap:6px;" id="${id}-toggle">
          <button type="button" class="btn btn--primary btn--xs" data-mode="nombre">Nombre</button>
          <button type="button" class="btn btn--ghost btn--xs" data-mode="taux">Taux</button>
        </div>
      </div>
      <div id="${id}-body"></div>
    </div>`;
  const wireRepartitionPanels = (mapsById) => {
    Object.entries(mapsById).forEach(([id, map]) => {
      const toggle = document.getElementById(`${id}-toggle`);
      const body = document.getElementById(`${id}-body`);
      if (!toggle || !body)
        return;
      const redessiner = () => {
        const mode = toggle.querySelector(".btn--primary")?.dataset.mode || "nombre";
        const total = Array.from(map.values()).reduce((t, v) => t + v, 0);
        const entries = Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8);
        const valeurs = entries.map(([, v]) => mode === "taux" ? (total ? (v / total) * 100 : 0) : v);
        const max = Math.max(1, ...valeurs);
        body.innerHTML = entries.length ? entries.map(([label], i) => {
          const v = valeurs[i];
          const affiche = mode === "taux" ? v.toFixed(1) + " %" : String(entries[i][1]);
          return `<div class="bar-row bar-row--pct">
            <div class="bar-row__label">${escapeHtml(label)}</div>
            <div class="bar-row__track"><div class="bar-row__fill" style="width:${(v / max) * 100}%"></div></div>
            <div class="bar-row__value">${affiche}</div>
          </div>`;
        }).join("") : emptyState("Aucune donnee pour le moment.");
      };
      toggle.querySelectorAll("button").forEach(btn => btn.addEventListener("click", () => {
        toggle.querySelectorAll("button").forEach(b => { b.classList.remove("btn--primary"); b.classList.add("btn--ghost"); });
        btn.classList.remove("btn--ghost");
        btn.classList.add("btn--primary");
        redessiner();
      }));
      redessiner();
    });
  };
  // Repartitions geographiques des membres — reutilisees telles quelles pour
  // les onglets Membres, Sections et Cellules (memes 4 axes de lecture).
  const repartitionsMembres = () => {
    const byRegion = new Map(), byDept = new Map(), byCommune = new Map(), byQuartier = new Map();
    for (const m of membres) {
      const dept = m.departement || "Non renseigne";
      const region = m.departement ? (regionDuDepartement(bureauxElectoraux, m.departement) || "Non renseignee") : "Non renseignee";
      byRegion.set(region, (byRegion.get(region) || 0) + 1);
      byDept.set(dept, (byDept.get(dept) || 0) + 1);
      byCommune.set(m.commune || "Non renseignee", (byCommune.get(m.commune || "Non renseignee") || 0) + 1);
      byQuartier.set(m.quartierVillage || "Non renseigne", (byQuartier.get(m.quartierVillage || "Non renseigne") || 0) + 1);
    }
    return { byRegion, byDept, byCommune, byQuartier };
  };
  const panneauxRepartitionHtml = (prefixe) => `
    <div class="panel-grid">
      ${panelRepartitionHtml(`${prefixe}-region`, "Membres par region")}
      ${panelRepartitionHtml(`${prefixe}-dept`, "Membres par departement")}
      ${panelRepartitionHtml(`${prefixe}-commune`, "Membres par commune")}
      ${panelRepartitionHtml(`${prefixe}-quartier`, "Membres par quartier / village")}
    </div>`;
  const wirePanneauxRepartition = (prefixe) => {
    const { byRegion, byDept, byCommune, byQuartier } = repartitionsMembres();
    wireRepartitionPanels({
      [`${prefixe}-region`]: byRegion, [`${prefixe}-dept`]: byDept,
      [`${prefixe}-commune`]: byCommune, [`${prefixe}-quartier`]: byQuartier,
    });
  };

  container.innerHTML = `
    <section class="dash-section">
      <div class="dash-section__header">
        <div>
          <h3 class="dash-section__title">&#128202; Statistiques generales</h3>
          <p class="dash-section__subtitle">Vue d'ensemble de la base a l'instant present.</p>
        </div>
      </div>
      <div class="stat-grid">
        <div class="stat-card stat-card--blue"><div class="stat-card__value">${membres.length}</div><div class="stat-card__label">Membres</div></div>
        <div class="stat-card stat-card--green"><div class="stat-card__value">${cellules.length}</div><div class="stat-card__label">Cellules</div></div>
        <div class="stat-card stat-card--amber"><div class="stat-card__value">${sections.length}</div><div class="stat-card__label">Sections</div></div>
        <div class="stat-card stat-card--slate"><div class="stat-card__value">${byDeptGlobal.size}</div><div class="stat-card__label">Departements couverts</div></div>
      </div>
    </section>

    <section class="dash-section">
      <div class="btn-group" id="dash-onglets">
        ${MODULES_DASHBOARD.map(o => `<button type="button" class="btn ${dashboardOnglet === o.id ? "btn--primary" : "btn--ghost"}" data-onglet="${o.id}">${o.icone} ${escapeHtml(o.label)}</button>`).join("")}
      </div>
      <div id="dash-onglet-contenu"></div>
    </section>
  `;

  const allerVersModule = (vue) => {
    currentView = vue;
    editingEntity = null;
    navHasBeenClicked = true;
    document.querySelectorAll(".nav-link").forEach(l => l.classList.toggle("nav-link--active", (l).dataset.view === currentView));
    $("#view-title").textContent = VIEW_TITLES[currentView];
    renderView();
  };

  function rendreOngletDashboard() {
    document.querySelectorAll("#dash-onglets button").forEach(b => {
      const actif = b.dataset.onglet === dashboardOnglet;
      b.classList.toggle("btn--primary", actif);
      b.classList.toggle("btn--ghost", !actif);
    });
    const zone = document.getElementById("dash-onglet-contenu");

    if (dashboardOnglet === "membres") {
      zone.innerHTML = panneauxRepartitionHtml("dash-mb");
      wirePanneauxRepartition("dash-mb");
    }
    else if (dashboardOnglet === "sections") {
      zone.innerHTML = panneauxRepartitionHtml("dash-sec");
      wirePanneauxRepartition("dash-sec");
    }
    else if (dashboardOnglet === "cellules") {
      const classementCellules = cellules
        .map(c => ({ nom: c.nom, section: nomSection(c.sectionId), count: membres.filter(m => m.celluleId === c.id).length }))
        .sort((a, b) => b.count - a.count);
      const maxClassement = Math.max(1, ...classementCellules.map(c => c.count));
      const rangSuffixe = (i) => (i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "default");
      const leaderboardHtml = (list) => list.length ? list.map((c, i) => `
        <div class="leaderboard-row">
          <div class="leaderboard-row__rank leaderboard-row__rank--${rangSuffixe(i)}">${i + 1}</div>
          <div class="leaderboard-row__info">
            <div class="leaderboard-row__name">${escapeHtml(c.nom)}</div>
            <div class="leaderboard-row__meta">${escapeHtml(c.section)}</div>
          </div>
          <div class="leaderboard-row__bar"><div class="leaderboard-row__bar-fill" style="width:${(c.count / maxClassement) * 100}%"></div></div>
          <div class="leaderboard-row__count">${c.count}</div>
        </div>`).join("") : emptyState("Aucune cellule enregistree pour le moment.");
      const byCelluleParSection = new Map();
      for (const c of cellules) byCelluleParSection.set(nomSection(c.sectionId), (byCelluleParSection.get(nomSection(c.sectionId)) || 0) + 1);
      zone.innerHTML = `
        ${panneauxRepartitionHtml("dash-cel")}
        <div class="panel-grid" style="margin-top:16px;">
          <div class="panel panel--wide">
            <div class="panel__header">
              <h3 class="panel__title">Classement des cellules par nombre de membres</h3>
              <select id="dash-top-filter" class="select-inline">
                <option value="5">Top 5</option>
                <option value="10" selected>Top 10</option>
                <option value="15">Top 15</option>
                <option value="20">Top 20</option>
                <option value="all">Toutes les cellules</option>
              </select>
            </div>
            <div id="dash-leaderboard" class="leaderboard">${leaderboardHtml(classementCellules.slice(0, 10))}</div>
          </div>
          <div class="panel">
            <h3 class="panel__title">Cellules par section</h3>
            ${byCelluleParSection.size ? barRows(byCelluleParSection, 10) : emptyState("Aucune cellule enregistree pour le moment.")}
          </div>
          <div class="panel">
            <div class="panel__header">
              <h3 class="panel__title">Constitution des bureaux</h3>
              <div class="btn-group" style="margin:0;gap:6px;" id="dash-bureaux-toggle">
                <button type="button" class="btn btn--primary btn--xs" data-mode="taux">Taux</button>
                <button type="button" class="btn btn--ghost btn--xs" data-mode="nombre">Nombre</button>
              </div>
            </div>
            <label class="filtre-groupe" style="margin-bottom:10px;">
              <span>Filtrer par section</span>
              <select id="dash-bureaux-filtre">
                <option value="toutes">Toutes les sections</option>
                ${sections.map(s => `<option value="${s.id}">${escapeHtml(s.nom)}</option>`).join("")}
              </select>
            </label>
            <div id="dash-bureaux-body"></div>
          </div>
        </div>`;
      wirePanneauxRepartition("dash-cel");
      $("#dash-top-filter").addEventListener("change", (e) => {
        const val = e.target.value;
        const liste = val === "all" ? classementCellules : classementCellules.slice(0, Number(val));
        $("#dash-leaderboard").innerHTML = leaderboardHtml(liste);
      });
      const toggleBureaux = document.getElementById("dash-bureaux-toggle");
      const filtreBureaux = document.getElementById("dash-bureaux-filtre");
      const redessinerBureaux = () => {
        const mode = toggleBureaux.querySelector(".btn--primary")?.dataset.mode || "taux";
        const sel = filtreBureaux.value;
        const cellulesScope = sel === "toutes" ? cellules : cellules.filter(c => String(c.sectionId) === sel);
        const sectionsScope = sel === "toutes" ? sections : sections.filter(s => String(s.id) === sel);
        const bC = cellulesScope.map(c => bureauCompletude(c, CELLULE_BUREAU_ROLES));
        const cComplets = bC.filter(b => b.complet).length;
        const pctC = cellulesScope.length ? Math.round((cComplets / cellulesScope.length) * 100) : 0;
        const bS = sectionsScope.map(s => bureauCompletude(s, SECTION_BUREAU_ROLES));
        const sComplets = bS.filter(b => b.complet).length;
        const pctS = sectionsScope.length ? Math.round((sComplets / sectionsScope.length) * 100) : 0;
        document.getElementById("dash-bureaux-body").innerHTML = `
          <div class="mini-stat">
            <div class="mini-stat__value">${mode === "taux" ? pctC + "%" : cComplets + "/" + cellulesScope.length}</div>
            <div class="mini-stat__label">Bureaux de cellule complets</div>
            <div class="mini-stat-track"><div class="mini-stat-fill" style="width:${pctC}%"></div></div>
          </div>
          <div class="mini-stat-row"><span class="mini-stat-row__label">Bureaux de section complets</span><span class="mini-stat-row__value">${mode === "taux" ? pctS + "%" : sComplets + "/" + sectionsScope.length}</span></div>
          ${sel === "toutes" ? `<div class="mini-stat-row"><span class="mini-stat-row__label">Cellules sans section rattachee</span><span class="mini-stat-row__value">${cellules.filter(c => !c.sectionId).length}</span></div>` : ""}`;
      };
      toggleBureaux.querySelectorAll("button").forEach(btn => btn.addEventListener("click", () => {
        toggleBureaux.querySelectorAll("button").forEach(b => { b.classList.remove("btn--primary"); b.classList.add("btn--ghost"); });
        btn.classList.remove("btn--ghost");
        btn.classList.add("btn--primary");
        redessinerBureaux();
      }));
      filtreBureaux.addEventListener("change", redessinerBureaux);
      redessinerBureaux();
    }
    else if (dashboardOnglet === "cartographie") {
      const couchesParNiveau = new Map();
      for (const c of couches) couchesParNiveau.set(c.niveau, (couchesParNiveau.get(c.niveau) || 0) + 1);
      const avecGeometrie = cellules.filter(c => c.geometry).length;
      zone.innerHTML = `
        <div class="stat-grid">
          <div class="stat-card stat-card--blue"><div class="stat-card__value">${couches.length}</div><div class="stat-card__label">Couches importees</div></div>
          <div class="stat-card stat-card--green"><div class="stat-card__value">${avecGeometrie}</div><div class="stat-card__label">Cellules avec geometrie</div></div>
          <div class="stat-card stat-card--amber"><div class="stat-card__value">${cellules.length - avecGeometrie}</div><div class="stat-card__label">Cellules sans geometrie</div></div>
        </div>
        <div class="panel-grid">
          <div class="panel"><h3 class="panel__title">Couches par niveau administratif</h3>${couchesParNiveau.size ? barRows(couchesParNiveau) : emptyState("Aucune couche importee.")}</div>
          <div class="panel">
            <h3 class="panel__title">Acces rapide</h3>
            <p class="form-note">Consultez la carte interactive complete (couches, symbologie, agregats par zoom) dans le module Cartographie.</p>
            <button type="button" class="btn btn--primary" data-goto-module="cartographie">Ouvrir la cartographie &rarr;</button>
          </div>
        </div>`;
    }
    else if (dashboardOnglet === "massification") {
      const mouvementsCount = new Map();
      for (const m of membres)
        for (const mv of (m.mouvements || []))
          mouvementsCount.set(mv, (mouvementsCount.get(mv) || 0) + 1);
      const carteOui = membres.filter(m => m.carteMembre === "Oui").length;
      zone.innerHTML = `
        <div class="stat-grid">
          <div class="stat-card stat-card--green"><div class="stat-card__value">${carteOui}</div><div class="stat-card__label">Porteurs de carte membre</div></div>
          <div class="stat-card stat-card--amber"><div class="stat-card__value">${membres.length - carteOui}</div><div class="stat-card__label">Sans carte membre</div></div>
          <div class="stat-card stat-card--blue"><div class="stat-card__value">${mouvementsCount.size}</div><div class="stat-card__label">Mouvements affilies distincts</div></div>
        </div>
        <div class="panel-grid">
          <div class="panel"><h3 class="panel__title">Membres par mouvement affilie</h3>${mouvementsCount.size ? barRows(mouvementsCount) : emptyState("Aucun mouvement affilie renseigne.")}</div>
          <div class="panel">
            <h3 class="panel__title">Acces rapide</h3>
            <p class="form-note">Le module Massification permet des extractions personnalisees (colonnes au choix) et un filtrage fin de la base.</p>
            <button type="button" class="btn btn--primary" data-goto-module="massification">Ouvrir la massification &rarr;</button>
          </div>
        </div>`;
    }
    else if (dashboardOnglet === "electorale") {
      const inscritsTotal = bureauxElectoraux.reduce((t, b) => t + (b.inscrits || 0), 0);
      const clesConnues = new Set(bureauxElectoraux.map(b => b.cle));
      const membresRattaches = membres.filter(m => clesConnues.has(cleBureauMembre(m))).length;
      const parCommune = new Map();
      for (const b of bureauxElectoraux) parCommune.set(b.commune || "Non renseignee", (parCommune.get(b.commune || "Non renseignee") || 0) + (b.inscrits || 0));
      zone.innerHTML = `
        <div class="stat-grid">
          <div class="stat-card stat-card--blue"><div class="stat-card__value">${bureauxElectoraux.length}</div><div class="stat-card__label">Bureaux de vote</div></div>
          <div class="stat-card stat-card--green"><div class="stat-card__value">${inscritsTotal.toLocaleString("fr-FR")}</div><div class="stat-card__label">Electeurs inscrits</div></div>
          <div class="stat-card stat-card--slate"><div class="stat-card__value">${inscritsTotal ? ((membresRattaches / inscritsTotal) * 100).toFixed(1) + " %" : "—"}</div><div class="stat-card__label">Penetration globale</div></div>
        </div>
        <div class="panel-grid">
          <div class="panel"><h3 class="panel__title">Inscrits par commune (top 8)</h3>${parCommune.size ? barRows(parCommune) : emptyState("Aucune carte electorale importee.")}</div>
          <div class="panel">
            <h3 class="panel__title">Acces rapide</h3>
            <p class="form-note">Import de la carte electorale, resultats de scrutins et analyse detaillee dans le module Carte electorale.</p>
            <button type="button" class="btn btn--primary" data-goto-module="electorale">Ouvrir la carte electorale &rarr;</button>
          </div>
        </div>`;
    }
    else {
      const cniAVerifier = membres.filter(estCniExpiree).length;
      const horsZone = membres.filter(estHorsZone).length;
      const nonInscritsDash = membres.filter(m => m.electeur === "Non").length;
      const max = Math.max(1, cniAVerifier, horsZone, nonInscritsDash);
      zone.innerHTML = `
        <div class="stat-grid">
          <div class="stat-card stat-card--amber"><div class="stat-card__value">${cniAVerifier}</div><div class="stat-card__label">CNI a renouveler</div></div>
          <div class="stat-card stat-card--slate"><div class="stat-card__value">${horsZone}</div><div class="stat-card__label">Membres Hors zone</div></div>
          <div class="stat-card stat-card--slate"><div class="stat-card__value">${nonInscritsDash}</div><div class="stat-card__label">Non inscrits</div></div>
        </div>
        <div class="panel-grid">
          <div class="panel">
            <h3 class="panel__title">Repartition par motif</h3>
            <div class="bar-row"><div class="bar-row__label">CNI expiree</div><div class="bar-row__track"><div class="bar-row__fill" style="width:${(cniAVerifier / max) * 100}%"></div></div><div class="bar-row__value">${cniAVerifier}</div></div>
            <div class="bar-row"><div class="bar-row__label">Hors zone</div><div class="bar-row__track"><div class="bar-row__fill" style="width:${(horsZone / max) * 100}%"></div></div><div class="bar-row__value">${horsZone}</div></div>
            <div class="bar-row"><div class="bar-row__label">Non inscrits</div><div class="bar-row__track"><div class="bar-row__fill" style="width:${(nonInscritsDash / max) * 100}%"></div></div><div class="bar-row__value">${nonInscritsDash}</div></div>
          </div>
          <div class="panel">
            <h3 class="panel__title">Acces rapide</h3>
            <p class="form-note">Traitez les renouvellements de CNI et les transferts (alignement de la commune de vote), et consultez les membres non inscrits sur le fichier electoral, dans le module dedie.</p>
            <button type="button" class="btn btn--primary" data-goto-module="transferts">Ouvrir le module &rarr;</button>
          </div>
        </div>`;
    }
    zone.querySelectorAll("[data-goto-module]").forEach(btn => btn.addEventListener("click", () => allerVersModule(btn.dataset.gotoModule)));
  }

  document.querySelectorAll("#dash-onglets button").forEach(btn => btn.addEventListener("click", () => {
    dashboardOnglet = btn.dataset.onglet;
    rendreOngletDashboard();
  }));
  rendreOngletDashboard();
}

function emptyState(msg) {
    return `<div class="empty-state">${escapeHtml(msg)}</div>`;
}
function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s ?? "";
    return d.innerHTML;
}
// ------------------------------------------------------------------------
// 6bis. CARTE ELECTORALE (reference Departement/Commune/Commune de vote/
// Lieu de vote/Bureau de vote/Pays/Localite)
//
// La reference electorale n est plus une donnee figee dans le code : elle
// est CHARGEE par l administrateur (voir ouvrirImportCarteElectorale) dans
// la table db.bureauxVote, puis DERIVEE dynamiquement par les fonctions
// ci-dessous a partir de ce qui a ete importe. Tant qu aucun import n a ete
// fait, ces listes sont vides et le formulaire Membre l indique clairement.
// ------------------------------------------------------------------------
// ------------------------------------------------------------------------
// PERIMETRE MULTI-DEPARTEMENTS — cette copie de l application est ancree
// (branding) sur le departement de RUFISQUE, mais
// elle accepte desormais TOUS les departements presents dans la carte
// electorale importee : aucun bureau, commune, membre ou departement n est
// plus ecarte a cause de son seul rattachement administratif. La carte
// electorale Etranger / diaspora reste retiree de cette extraction (voir
// plus bas), ce qui est independant de cette question de departement.
// DEPARTEMENT_PRINCIPAL n est utilise que pour presenter Rufisque en
// premier / par defaut dans l interface, jamais pour filtrer ou rejeter des
// donnees.
// ------------------------------------------------------------------------
const DEPARTEMENT_PRINCIPAL = "RUFISQUE";
function bureauxDeLaZone(bureaux, zone) {
    return bureaux.filter(b => (b.zoneElectorale || "National") === zone);
}
function departementsElectoraux(bureaux, zone) {
    return [...new Set(bureauxDeLaZone(bureaux, zone).map(b => b.departement))]
        .filter(Boolean).sort((a, b) => a.localeCompare(b, "fr"));
}
// Region (National uniquement) associee a un departement, deduite de la
// carte electorale importee — un departement appartient a une seule region.
function regionDuDepartement(bureaux, departement) {
    return bureauxDeLaZone(bureaux, "National").find(b => b.departement === departement && b.region)?.region || "";
}
function communesElectorales(bureaux, zone, departement) {
    return [...new Set(bureauxDeLaZone(bureaux, zone).filter(b => b.departement === departement).map(b => b.commune))]
        .filter(Boolean).sort((a, b) => a.localeCompare(b, "fr"));
}
function toutesCommunesElectorales(bureaux, zone) {
    return [...new Set(bureauxDeLaZone(bureaux, zone).map(b => b.commune))]
        .filter(Boolean).sort((a, b) => a.localeCompare(b, "fr"));
}
function lieuxDeVoteElectoraux(bureaux, zone, commune) {
    return [...new Set(bureauxDeLaZone(bureaux, zone).filter(b => b.commune === commune).map(b => b.lieuVote))]
        .filter(Boolean).sort((a, b) => a.localeCompare(b, "fr"));
}
function bureauxDuLieuVote(bureaux, zone, commune, lieuVote) {
    return [...new Set(bureauxDeLaZone(bureaux, zone).filter(b => b.commune === commune && b.lieuVote === lieuVote).map(b => b.numeroBureau))]
        .filter(Boolean).sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
}
// Rapproche une localisation saisie AVANT cette fonctionnalite (texte libre,
// donc potentiellement mal orthographiee ou incomplete) des valeurs
// officielles importees. Deux passes, jamais de devinette hasardeuse :
//  1) correspondance EXACTE (insensible a la casse/aux accents) ;
//  2) a defaut, et uniquement si le departement est deja reconnu, une
//     correspondance par inclusion de chaine SI ELLE DESIGNE UNE SEULE
//     commune sans ambiguite.
// Sans correspondance fiable, la fiche est laissee telle quelle pour verification manuelle.
function normaliserLocalisationOfficielle(bureaux, departementSaisi, communeSaisie) {
    const depCle = cleNom(departementSaisi);
    const departements = departementsElectoraux(bureaux, "National");
    const departement = departements.find(d => cleNom(d) === depCle);
    if (!departement)
        return { ok: false };
    const communes = communesElectorales(bureaux, "National", departement);
    const communeCle = cleNom(communeSaisie);
    const exact = communes.find(c => cleNom(c) === communeCle);
    if (exact)
        return { ok: true, departement, commune: exact, methode: "exact" };
    if (!communeCle)
        return { ok: false };
    const approx = communes.filter(c => {
        const cCle = cleNom(c);
        return cCle.includes(communeCle) || communeCle.includes(cCle);
    });
    if (approx.length === 1)
        return { ok: true, departement, commune: approx[0], methode: "approximatif" };
    return { ok: false };
}
// ------------------------------------------------------------------------
// 6ter. COMBOBOX A SELECTION STRICTE
//
// Champ texte + liste filtree qui apparait des la premiere lettre tapee ;
// contrairement a un <input list="datalist"> (simple suggestion), la
// valeur saisie est INVALIDEE (setCustomValidity) si elle ne correspond pas
// EXACTEMENT a l une des options — aucune saisie libre n est acceptee.
// ------------------------------------------------------------------------
function comboboxHtml(name, label, required, valeur) {
    return `<label class="field" data-field="${name}">
    <span>${escapeHtml(label)}${required ? " *" : ""}</span>
    <div class="combobox">
      <input type="text" name="${name}" value="${escapeHtml(valeur || "")}" autocomplete="off" spellcheck="false" ${required ? "required" : ""}>
      <div class="combobox__liste" hidden></div>
    </div>
  </label>`;
}
// Attache le comportement a un champ rendu par comboboxHtml(). `getOptions`
// est ré-appelee a chaque interaction (permet les listes en cascade : les
// communes dependent du departement choisi). Renvoie { rafraichir,
// redessiner } pour que l appelant puisse forcer une revalidation/un
// nouvel affichage lors d un changement externe (bascule National/Etranger).
function attacherCombobox(form, name, getOptions) {
    const input = form.querySelector(`[name="${name}"]`);
    const liste = input.parentElement.querySelector(".combobox__liste");
    const valider = () => {
        const options = getOptions();
        input.setCustomValidity(!input.value || options.includes(input.value) ? "" : "Choisissez une valeur dans la liste (aucune saisie libre).");
    };
    const fermer = () => { liste.hidden = true; };
    const dessiner = () => {
        const options = getOptions();
        const q = cleNom(input.value || "");
        const filtrees = (q ? options.filter(o => cleNom(o).includes(q)) : options).slice(0, 200);
        liste.innerHTML = filtrees.length
            ? filtrees.map(o => `<button type="button" class="combobox__item">${escapeHtml(o)}</button>`).join("")
            : `<p class="combobox__vide">Aucun resultat.</p>`;
        liste.hidden = false;
        liste.querySelectorAll(".combobox__item").forEach(btn => btn.addEventListener("mousedown", (e) => {
            // mousedown (et non click) : se declenche avant le blur de l input,
            // sinon la fermeture de la liste annulerait la selection.
            e.preventDefault();
            input.value = btn.textContent;
            fermer();
            valider();
            input.dispatchEvent(new Event("change", { bubbles: true }));
        }));
    };
    input.addEventListener("focus", dessiner);
    input.addEventListener("input", () => { dessiner(); valider(); });
    input.addEventListener("blur", () => { setTimeout(fermer, 120); valider(); });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Escape")
            fermer();
        else if (e.key === "Enter" && !liste.hidden) {
            const premier = liste.querySelector(".combobox__item");
            if (premier) {
                e.preventDefault();
                premier.dispatchEvent(new MouseEvent("mousedown"));
            }
        }
    });
    valider();
    return { rafraichir: valider, redessiner: dessiner };
}
// Variante de comboboxHtml/attacherCombobox pour les cas ou la valeur
// VALIDE n'est pas le texte affiche lui-meme mais un IDENTIFIANT associe
// (ex. choisir un quartier par son nom, mais enregistrer son id). Le texte
// se saisit/filtre normalement ; un champ cache recoit l'id correspondant,
// remis a vide des que le texte ne correspond plus exactement a une option.
function comboboxIdHtml(nomTexte, nomId, label, required, texte, id) {
    return `<label class="field" data-field="${nomTexte}">
    <span>${escapeHtml(label)}${required ? " *" : ""}</span>
    <div class="combobox">
      <input type="text" name="${nomTexte}" value="${escapeHtml(texte || "")}" autocomplete="off" spellcheck="false" ${required ? "required" : ""}>
      <div class="combobox__liste" hidden></div>
    </div>
    <input type="hidden" name="${nomId}" value="${id ?? ""}">
  </label>`;
}
// `getOptions` renvoie [{ id, texte }]. Comportement identique a
// attacherCombobox, avec en plus la mise a jour du champ cache `nomId`.
function attacherComboboxId(form, nomTexte, nomId, getOptions) {
    const input = form.querySelector(`[name="${nomTexte}"]`);
    const hidden = form.querySelector(`[name="${nomId}"]`);
    const liste = input.parentElement.querySelector(".combobox__liste");
    const valider = () => {
        const trouve = getOptions().find(o => o.texte === input.value);
        hidden.value = trouve ? String(trouve.id) : "";
        input.setCustomValidity(!input.value || trouve ? "" : "Choisissez une valeur dans la liste (aucune saisie libre).");
    };
    const fermer = () => { liste.hidden = true; };
    const dessiner = () => {
        const options = getOptions();
        const q = cleNom(input.value || "");
        const filtrees = (q ? options.filter(o => cleNom(o.texte).includes(q)) : options).slice(0, 200);
        liste.innerHTML = filtrees.length
            ? filtrees.map(o => `<button type="button" class="combobox__item" data-id="${o.id}">${escapeHtml(o.texte)}</button>`).join("")
            : `<p class="combobox__vide">Aucun resultat.</p>`;
        liste.hidden = false;
        liste.querySelectorAll(".combobox__item").forEach(btn => btn.addEventListener("mousedown", (e) => {
            e.preventDefault();
            input.value = btn.textContent;
            fermer();
            valider();
            input.dispatchEvent(new Event("change", { bubbles: true }));
        }));
    };
    input.addEventListener("focus", dessiner);
    input.addEventListener("input", () => { dessiner(); valider(); });
    input.addEventListener("blur", () => { setTimeout(fermer, 120); valider(); });
    input.addEventListener("keydown", (e) => {
        if (e.key === "Escape")
            fermer();
        else if (e.key === "Enter" && !liste.hidden) {
            const premier = liste.querySelector(".combobox__item");
            if (premier) {
                e.preventDefault();
                premier.dispatchEvent(new MouseEvent("mousedown"));
            }
        }
    });
    valider();
    return { rafraichir: valider, redessiner: dessiner };
}
// ------------------------------------------------------------------------
// 6quater. QUARTIERS
//
// Un quartier est cree exclusivement par l'administrateur principal, se
// rattache a une commune officielle (issue de la carte electorale importee)
// et ne peut pas se dupliquer au sein d'une meme commune. Les cellules
// choisissent ensuite un quartier existant par selection stricte (voir
// comboboxIdHtml/quartierId).
// ------------------------------------------------------------------------
function libelleQuartier(q) {
    return `${q.nom} (${q.commune})`;
}
async function ajouterQuartier(nom, commune) {
    nom = nom.trim();
    if (!nom || !commune)
        return { ok: false, message: "Nom et commune sont obligatoires." };
    const communesConnues = toutesCommunesElectorales(await db.bureauxVote.toArray(), "National");
    if (!communesConnues.includes(commune))
        return { ok: false, message: "Commune inconnue (voir la carte electorale importee)." };
    const existants = await db.quartiers.where("commune").equals(commune).toArray();
    if (existants.some(q => cleNom(q.nom) === cleNom(nom)))
        return { ok: false, message: `Le quartier "${nom}" existe deja dans ${commune}.` };
    const numero = await nextNumero(db.quartiers);
    await db.quartiers.add({ numero, nom, commune, createdAt: new Date().toISOString() });
    return { ok: true, message: "Quartier ajoute avec succes." };
}
// Supprime un quartier, sauf s'il est encore utilise par au moins une
// cellule (evite une reference orpheline silencieuse).
async function supprimerQuartier(id) {
    const enUsage = await db.cellules.where("quartierId").equals(id).count();
    if (enUsage > 0)
        return { ok: false, message: `Ce quartier est utilise par ${enUsage} cellule(s) : reaffectez-les avant de le supprimer.` };
    await db.quartiers.delete(id);
    return { ok: true, message: "Quartier supprime." };
}
// Fenetre de gestion des quartiers (creation, liste, suppression). Reservee
// a l'administrateur principal ; rouvrable a tout moment.
function ouvrirGestionQuartiers(apresModification) {
    if (!can(getSession().role, "manageStructure")) {
        toast("Gestion des quartiers reservee a l'administrateur principal.", "error");
        return;
    }
    ouvrirModale({
        titre: "Gestion des quartiers",
        taille: "wide",
        contenuHtml: `
      <p class="form-note">Un quartier se rattache a une commune officielle et ne peut pas se dupliquer au sein de cette commune. Les cellules choisissent ensuite un quartier existant.</p>
      <form id="quartier-form" class="filtre-bar" style="margin:0 0 14px;">
        ${comboboxHtml("communeQuartier", "Commune", true, "")}
        <label class="field" style="flex:1;min-width:180px;"><span>Nom du quartier *</span><input type="text" name="nomQuartier" required></label>
        <div class="filtre-bar__actions"><button type="submit" class="btn btn--primary">+ Ajouter</button></div>
      </form>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>N°</th><th>Nom</th><th>Commune</th><th></th></tr></thead>
          <tbody id="quartiers-tbody"></tbody>
        </table>
        <div id="quartiers-vide"></div>
      </div>`,
        onMonte: async (contenu) => {
            const form = contenu.querySelector("#quartier-form");
            const bureauxQuartier = await db.bureauxVote.toArray();
            attacherCombobox(form, "communeQuartier", () => toutesCommunesElectorales(bureauxQuartier, "National"));
            const tbody = contenu.querySelector("#quartiers-tbody");
            const vide = contenu.querySelector("#quartiers-vide");
            const dessiner = async () => {
                const quartiers = (await db.quartiers.toArray()).sort((a, b) => a.commune.localeCompare(b.commune, "fr") || a.nom.localeCompare(b.nom, "fr"));
                tbody.innerHTML = quartiers.map(q => `<tr>
          <td>${q.numero}</td><td>${escapeHtml(q.nom)}</td><td>${escapeHtml(q.commune)}</td>
          <td class="row-actions"><button class="icon-btn icon-btn--danger" data-supprimer-quartier="${q.id}" title="Supprimer">&#128465;</button></td>
        </tr>`).join("");
                vide.innerHTML = quartiers.length ? "" : emptyState("Aucun quartier cree pour le moment.");
                tbody.querySelectorAll("[data-supprimer-quartier]").forEach(b => b.addEventListener("click", async () => {
                    if (!confirm("Supprimer ce quartier ?"))
                        return;
                    const res = await supprimerQuartier(Number(b.dataset.supprimerQuartier));
                    toast(res.message, res.ok ? "success" : "error");
                    if (res.ok) {
                        await dessiner();
                        await apresModification?.();
                    }
                }));
            };
            form.addEventListener("submit", async (e) => {
                e.preventDefault();
                const commune = form.querySelector('[name="communeQuartier"]').value;
                const nom = form.querySelector('[name="nomQuartier"]').value;
                const res = await ajouterQuartier(nom, commune);
                toast(res.message, res.ok ? "success" : "error");
                if (res.ok) {
                    form.reset();
                    await dessiner();
                    await apresModification?.();
                }
            });
            await dessiner();
        },
    });
}
const FIELD_DEFS = {
    membre: [
        // --- Identite -----------------------------------------------------------
        { key: "prenom", label: "Prénom", required: true, section: "Identité" },
        { key: "nom", label: "Nom", required: true },
        { key: "dateNaissance", label: "Date de naissance", required: true, type: "date" },
        { key: "lieuNaissance", label: "Lieu de naissance", required: true },
        { key: "sexe", label: "Sexe", required: true, type: "select", options: ["M", "F"] },
        // --- Coordonnees & localisation ------------------------------------------
        // Departement/Commune ne figurent plus ici : ils sont rendus par un
        // bloc dedie (voir localisationHtml()) car ce sont des comboboxes a
        // selection stricte, en cascade, dependant d'un choix National/
        // Etranger et de la carte electorale importee (bureauxElectoraux).
        { key: "quartierVillage", label: "Quartier / Village", required: true, section: "Coordonnées & localisation" },
        { key: "telephone", label: "Numéro de téléphone", required: true, type: "tel" },
        { key: "email", label: "Email", type: "email" },
        // --- Piece d'identite (CNI) -----------------------------------------------
        // Le numero de carte nationale d'identite n'est plus collecte : seules
        // les dates de delivrance et d'expiration sont conservees.
        { key: "dateDelivranceCNI", label: "Date de délivrance", required: true, type: "date",
            section: "Carte Nationale d'Identité" },
        { key: "dateExpirationCNI", label: "Date d'expiration", required: true, type: "date" },
        // --- Situation electorale -------------------------------------------------
        // Commune de vote / Lieu de vote / Bureau de vote ne figurent plus ici :
        // rendus par situationVoteHtml() (comboboxes en cascade, sourcees de la
        // carte electorale importee — voir bureauxElectoraux).
        { key: "electeur", label: "Électeur", required: true, type: "select", options: ["Oui", "Non"], section: "Situation électorale" },
        { key: "numeroElecteur", label: "Numéro d'électeur", required: true, type: "digits",
            maxLength: 9, pattern: "\\d{9}", title: "9 chiffres" },
        // --- Adhesion ---------------------------------------------------------------
        { key: "adhesion", label: "Adhésion", required: true, type: "select", options: ["Ancien", "Nouveau"], section: "Adhésion" },
        { key: "dateAdhesion", label: "Année d'adhésion", required: true, type: "digits", maxLength: 4,
            pattern: "\\d{4}", title: "Année sur 4 chiffres" },
        { key: "carteMembre", label: "Carte membre", required: true, type: "select", options: ["Oui", "Non"] },
        { key: "numeroCarteMembre", label: "N° carte membre", type: "text",
            hint: "Renseigne uniquement si \"Carte membre\" = Oui." },
        // --- Autres --------------------------------------------------------------------
        { key: "fonction", label: "Fonction / Profession / Activite", required: true, liste: true, section: "Autres" },
        // Un membre peut etre affilie a plusieurs mouvements : le champ se
        // compose par selection dans la liste des mouvements deja connus, ou
        // par saisie d'un nouveau mouvement (voir type "mouvements").
        { key: "mouvements", label: "Mouvements affiliés", type: "mouvements",
            hint: "Choisissez dans la liste ou saisissez un nouveau mouvement ; plusieurs affiliations sont possibles." },
    ],
    // Quartier (cellule) et Contact responsable (cellule + section) sont
    // rendus par des blocs dedies (voir quartierHtml()/contactResponsableHtml()
    // dans openForm) : le premier est une combobox a selection stricte sur les
    // quartiers admin, le second recherche un membre existant pour auto-remplir
    // prenom/nom, ni l'un ni l'autre ne rentre dans le rendu generique.
    cellule: [
        { key: "nom", label: "Nom de la cellule", required: true },
    ],
    section: [
        { key: "nom", label: "Nom de la section / commune", required: true },
    ],
};
// Construit le controle HTML adapte au type d'un champ (texte, date, select,
// saisie numerique contrainte, ou CNI avec mise en forme automatique).
function renderField(f, editing, suggestions = {}) {
    const val = editing ? String(editing[f.key] ?? "") : "";
    const req = f.required ? "required" : "";
    const heading = f.section ? `<h4 class="form-section-title">${escapeHtml(f.section)}</h4>` : "";
    // Champ "mouvements affilies" : plusieurs valeurs, affichees en etiquettes
    // et alimentees par la liste des mouvements deja enregistres.
    if (f.type === "mouvements") {
        const choisis = Array.isArray(editing?.[f.key]) ? editing[f.key] : [];
        const connus = (suggestions[f.key] || []).filter(v => !choisis.includes(v));
        return `${heading}
    <div class="field field--full" data-field="${f.key}">
      <span>${escapeHtml(f.label)}</span>
      <div class="chips" id="chips-${f.key}">${choisis.map(v => chipHtml(v)).join("")}</div>
      <div class="chips-ajout">
        <input type="text" id="chips-saisie-${f.key}" list="dl-${f.key}" placeholder="Choisir ou saisir un mouvement...">
        <button type="button" class="btn btn--ghost btn--xs" id="chips-ajouter-${f.key}">+ Ajouter</button>
      </div>
      <datalist id="dl-${f.key}">${connus.map(v => `<option value="${escapeHtml(v)}"></option>`).join("")}</datalist>
      ${f.hint ? `<small class="field-hint">${escapeHtml(f.hint)}</small>` : ""}
    </div>`;
    }
    let control;
    if (f.type === "select") {
        const opts = (f.options || []).map(o => `<option value="${escapeHtml(o)}" ${val === o ? "selected" : ""}>${escapeHtml(o)}</option>`).join("");
        control = `<select name="${f.key}" ${req}><option value="">-- Choisir --</option>${opts}</select>`;
    }
    else if (f.type === "date") {
        control = `<input type="date" name="${f.key}" value="${escapeHtml(val)}" ${req}>`;
    }
    else {
        const inputType = f.type === "email" ? "email" : f.type === "tel" ? "tel" : "text";
        const maskAttr = f.type === "digits" ? `inputmode="numeric" data-mask="digits"` : "";
        const maxAttr = f.maxLength ? `maxlength="${f.maxLength}"` : "";
        const patternAttr = f.pattern ? `pattern="${f.pattern}"` : "";
        const titleAttr = f.title ? `title="${escapeHtml(f.title)}"` : "";
        // Autocompletion : les valeurs deja presentes dans la base sont
        // proposees des les premieres lettres saisies.
        const valeurs = f.liste ? (suggestions[f.key] || []) : [];
        const listeAttr = f.liste ? `list="dl-${f.key}" autocomplete="off"` : "";
        control = `<input type="${inputType}" name="${f.key}" value="${escapeHtml(val)}" ${maxAttr} ${maskAttr} ${patternAttr} ${titleAttr} ${listeAttr} ${req}>`
            + (f.liste ? `<datalist id="dl-${f.key}">${valeurs.map(v => `<option value="${escapeHtml(v)}"></option>`).join("")}</datalist>` : "");
    }
    const hint = f.hint ? `<small class="field-hint">${escapeHtml(f.hint)}</small>` : "";
    return `${heading}<label class="field" data-field="${f.key}"><span>${escapeHtml(f.label)}${f.required ? " *" : ""}</span>${control}${hint}</label>`;
}
// Etiquette supprimable d'une valeur multiple (mouvements affilies).
function chipHtml(valeur) {
    return `<span class="chip" data-valeur="${escapeHtml(valeur)}">${escapeHtml(valeur)}<button type="button" class="chip__x" title="Retirer">&times;</button></span>`;
}
const ENTITY_LABELS = {
    membre: { singular: "membre", plural: "membres" },
    cellule: { singular: "cellule", plural: "cellules" },
    section: { singular: "section", plural: "sections" },
};
const ENTITY_BANNERS = {
    membre: { color: "green", eyebrow: "Base de soutien", title: "Département de Rufisque", subtitle: "Ajout, recherche et suivi des adherents." },
    cellule: { color: "red", eyebrow: "Maillage de terrain", title: "Gestion des cellules", subtitle: "Bureaux de cellule et responsables associes." },
    section: { color: "green", eyebrow: "Organisation territoriale", title: "Gestion des sections", subtitle: "Bureaux de section et responsables associes." },
};
function tableFor(kind) {
    return kind === "membre" ? db.membres : kind === "cellule" ? db.cellules : db.sections;
}
async function renderEntityView(container, kind) {
    const session = getSession();
    const canEdit = can(session.role, kind === "membre" ? "editData" : "manageStructure") || (kind === "membre");
    const canDelete = can(session.role, "deleteData") && (kind !== "membre" ? can(session.role, "manageStructure") : true);
    const items = await tableFor(kind).toArray();
    const labels = ENTITY_LABELS[kind];
    const fields = FIELD_DEFS[kind];
    let cellules = [];
    let sections = [];
    let membresAll = [];
    let quartiers = [];
    let bureauxElectoraux = [];
    if (kind === "membre") {
        cellules = await db.cellules.toArray();
        sections = await db.sections.toArray();
        bureauxElectoraux = await db.bureauxVote.toArray();
    }
    if (kind === "cellule" || kind === "section") {
        membresAll = await db.membres.toArray();
    }
    if (kind === "cellule") {
        sections = await db.sections.toArray();
        quartiers = await db.quartiers.toArray();
    }
    // La vue Sections a besoin des cellules pour compter les cellules
    // regroupees et calculer la geometrie agregee de chaque section.
    if (kind === "section") {
        cellules = await db.cellules.toArray();
    }
    const bureauRoles = kind === "cellule" ? CELLULE_BUREAU_ROLES : kind === "section" ? SECTION_BUREAU_ROLES : [];
    const nomMembre = (id) => {
        if (!id)
            return "—";
        const m = membresAll.find(x => x.id === id);
        return m ? nomComplet(m) : "—";
    };
    const responsableKey = kind === "cellule" ? "responsableCelluleId" : "responsableSectionId";
    const contactKey = kind === "cellule" ? "contactResponsable" : "contactResponsableSection";
    // Import CSV : disponible pour les onglets Membres et Cellules. Pour les
    // Membres, les colonnes attendues reprennent exactement les champs du
    // formulaire membre (voir FIELD_DEFS.membre) + Cellule/Section de
    // rattachement (facultatives, par nom exact).
    const importDisponible = (kind === "cellule" || kind === "membre") && canEdit;
    const importTitre = kind === "membre" ? "Importer des membres (CSV)" : "Importer des cellules (CSV)";
    const importNote = kind === "membre"
        ? `Colonnes obligatoires : <b>Nom</b>, <b>Prenom</b>, <b>Date de naissance</b>, <b>Lieu de naissance</b>. Toutes les autres colonnes sont facultatives : si elles sont renseignees elles sont chargees (apres controle), si elles sont vides elles sont simplement ignorees. Colonnes facultatives : Sexe (M/F), Zone electorale (National/Etranger), Departement (ou Pays si Etranger), Commune (ou Localite si Etranger), Quartier / Village, Numero de telephone, Email, Date de delivrance CNI, Date d'expiration CNI, Electeur (Oui/Non), Commune de vote, Numero d'electeur (9 chiffres), Lieu de vote, Bureau de vote, Adhesion (Ancien/Nouveau), Annee d'adhesion, Carte membre (Oui/Non), N° carte membre, Fonction, Mouvements affilies (plusieurs separes par <b>;</b>), Cellule (nom exact d'une cellule existante), Section (nom exact d'une section existante). Quand Departement/Commune (ou Pays/Localite) et Commune/Lieu/Bureau de vote sont renseignes, ils doivent correspondre EXACTEMENT (casse et accents ignores) a la carte electorale importee, sans quoi la ligne est rejetee. Les dates sont acceptees au format jj/mm/aaaa ou aaaa-mm-jj. Utilisez le modele ci-dessous pour etre sur du format attendu.`
        : `Colonnes attendues : <b>Nom de la cellule</b> (obligatoire), <b>Quartier</b> (nom exact d'un quartier existant), <b>Contact du responsable</b>, <b>Section de rattachement</b> (nom exact d'une section existante). Le responsable et le reste du bureau se renseignent ensuite depuis la fiche de la cellule, une fois les membres qui lui sont rattaches importes.`;
    const importCelluleHtml = importDisponible ? `
    <div class="modal-backdrop" id="import-backdrop">
      <div class="modal modal--wide">
        <div class="modal__header">
          <h3>${importTitre}</h3>
          <button class="modal__close" id="import-close">&times;</button>
        </div>
        <div class="entity-form" style="overflow-y:auto;">
          <p class="form-note">${importNote}</p>
          <button type="button" class="btn btn--ghost" id="import-template-download">⬇ Telecharger le modele CSV</button>
          <label class="field field--full">
            <span>Fichier CSV</span>
            <input type="file" accept=".csv,text/csv" id="import-file">
          </label>
          <div id="import-preview" class="field--full"></div>
        </div>
        <div class="modal__actions">
          <button type="button" class="btn btn--ghost" id="import-cancel">Annuler</button>
          <button type="button" class="btn btn--primary" id="import-confirm" disabled>Confirmer l'import</button>
        </div>
      </div>
    </div>` : "";
    const carteElectoraleVide = kind === "membre" && bureauxElectoraux.length === 0;
    container.innerHTML = `
    <div class="view-banner view-banner--${ENTITY_BANNERS[kind].color}">
      <div class="view-banner__eyebrow">${ENTITY_BANNERS[kind].eyebrow}</div>
      <h2 class="view-banner__title">${ENTITY_BANNERS[kind].title}</h2>
      <p class="view-banner__subtitle">${ENTITY_BANNERS[kind].subtitle}</p>
    </div>
    ${carteElectoraleVide ? `
    <p class="form-note form-note--warn">
      Aucune carte electorale n'a encore ete importee : les champs Departement, Commune, Commune de vote, Lieu de vote et Bureau de vote ne pourront pas etre renseignes tant qu'elle n'est pas chargee.
      ${can(session.role, "manageStructure") ? `<button type="button" class="badge badge--warn badge--clickable" id="aller-carte-electorale">Importer la carte electorale</button>` : "Contactez l'administrateur principal pour l'importer."}
    </p>` : ""}
    <div class="toolbar">
      <input type="search" id="search-box" class="search-input" placeholder="Rechercher un ${labels.singular}...">
      ${kind === "membre" ? `
      <label class="filtre-groupe" style="min-width:0;flex-direction:row;align-items:center;gap:6px;" title="Tranche d'age : saisissez un minimum, un maximum, ou les deux">
        <span style="white-space:nowrap;">Age de</span>
        <input type="number" id="age-min" min="0" max="130" placeholder="min" style="width:72px;">
        <span>a</span>
        <input type="number" id="age-max" min="0" max="130" placeholder="max" style="width:72px;">
        <span>ans</span>
        <button type="button" class="btn btn--ghost" id="age-reset" style="display:none;" title="Effacer la tranche d'age">&times;</button>
      </label>` : ""}
      <button class="btn btn--ghost" id="export-csv-btn" title="Exporter la liste affichee au format CSV">&#8681; Exporter CSV</button>
      <button class="btn btn--ghost" id="export-pdf-btn" title="Exporter la liste affichee au format PDF">&#128438; Exporter PDF</button>
      ${importDisponible ? `<button class="btn btn--ghost" id="import-btn">Importer CSV</button>` : ""}
      ${kind === "cellule" && can(session.role, "manageStructure") ? `<button class="btn btn--ghost" id="gerer-quartiers-btn">&#127961; Gerer les quartiers</button>` : ""}
      ${canEdit ? `<button class="btn btn--primary" id="add-btn">+ Ajouter ${labels.singular === "membre" ? "un membre" : "une " + labels.singular}</button>` : ""}
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          ${kind === "membre" ? "<th></th>" : ""}
          <th>N°</th><th>Reference</th>
          ${kind === "membre" ? "<th>Prenom &amp; nom</th><th>Cellule</th><th>Commune</th><th>Telephone</th><th></th>" : ""}
          ${kind === "cellule" ? "<th>Nom</th><th>Quartier</th><th>Responsable (membre)</th><th>Contact</th><th>Bureau</th>" : ""}
          ${kind === "section" ? "<th>Nom</th><th>Responsable (membre)</th><th>Contact</th><th>Bureau</th>" : ""}
          <th></th>
        </tr></thead>
        <tbody id="entity-tbody"></tbody>
      </table>
      <div id="entity-empty"></div>
    </div>
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <div class="modal__header">
          <h3 id="modal-title"></h3>
          <button class="modal__close" id="modal-close">&times;</button>
        </div>
        <form id="entity-form" class="entity-form"></form>
      </div>
    </div>
    <div class="modal-backdrop" id="fiche-backdrop">
      <div class="modal modal--wide">
        <div class="modal__header">
          <h3 id="fiche-title"></h3>
          <button class="modal__close" id="fiche-close">&times;</button>
        </div>
        <div id="fiche-body" class="fiche-body"></div>
      </div>
    </div>
    ${importCelluleHtml}
  `;
    let listeAffichee = items;
    function draw(list) {
        listeAffichee = list;
        const tbody = $("#entity-tbody");
        const empty = $("#entity-empty");
        if (list.length === 0) {
            tbody.innerHTML = "";
            empty.innerHTML = emptyState(`Aucun ${labels.singular} enregistre pour le moment.`);
            return;
        }
        empty.innerHTML = "";
        tbody.innerHTML = list.map(item => {
            if (kind === "membre") {
                const celluleNom = cellules.find(c => c.id === item.celluleId)?.nom || "—";
                const alertes = [
                    estCniExpiree(item) ? `<span class="badge badge--warn" title="CNI expiree — a renouveler">CNI</span>` : "",
                    estHorsZone(item) ? `<span class="badge badge--warn" title="Hors zone — a transferer">HZ</span>` : "",
                ].filter(Boolean).join(" ");
                return `
        <tr class="data-row--clickable" data-view-row="${item.id}">
          <td>${avatarHtml(item.photoDataUrl, nomComplet(item), "sm")}</td>
          <td>${item.numero}</td>
          <td><span class="ref-badge">${item.reference}</span></td>
          <td>${escapeHtml(nomComplet(item))}</td>
          <td>${escapeHtml(celluleNom)}</td>
          <td>${escapeHtml(item.commune)}</td>
          <td>${escapeHtml(item.telephone)}</td>
          <td>${alertes}</td>
          <td class="row-actions">
            <button class="icon-btn" data-action="localiser" data-id="${item.id}" title="Recherche geographique — localiser sur la carte">&#127757;</button>
            <button class="icon-btn" data-action="edit" data-id="${item.id}" title="Modifier">&#9998;</button>
            ${canDelete ? `<button class="icon-btn icon-btn--danger" data-action="delete" data-id="${item.id}" title="Supprimer">&#128465;</button>` : ""}
          </td>
        </tr>`;
            }
            const col3 = escapeHtml(nomMembre(item[responsableKey]));
            const col4 = escapeHtml(item[contactKey] || "—");
            const { pourvus, total, complet } = bureauCompletude(item, bureauRoles);
            const bureauBadge = `<span class="badge ${complet ? "badge--success" : "badge--warn"}">${complet ? "Bureau complet" : `${pourvus}/${total} postes`}</span>`;
            const quartierCol = kind === "cellule"
                ? (() => { const q = quartiers.find(x => x.id === item.quartierId); return `<td>${q ? escapeHtml(libelleQuartier(q)) : `<span class="badge badge--warn">A definir</span>`}</td>`; })()
                : "";
            return `
        <tr class="data-row--clickable" data-view-row="${item.id}">
          <td>${item.numero}</td>
          <td><span class="ref-badge">${item.reference}</span></td>
          <td>${escapeHtml(item.nom)}</td>${quartierCol}<td>${col3}</td><td>${col4}</td><td>${bureauBadge}</td>
          <td class="row-actions">
            <button class="icon-btn" data-action="localiser" data-id="${item.id}" title="Recherche geographique — localiser sur la carte">&#127757;</button>
            ${kind === "cellule"
                ? `<button class="icon-btn" data-action="membres" data-id="${item.id}" title="Membres de cette cellule">&#128100;</button>`
                : `<button class="icon-btn" data-action="cellules" data-id="${item.id}" title="Cellules de cette section">&#127961;</button>`}
            <button class="icon-btn" data-action="edit" data-id="${item.id}" title="Modifier">&#9998;</button>
            ${canDelete ? `<button class="icon-btn icon-btn--danger" data-action="delete" data-id="${item.id}" title="Supprimer">&#128465;</button>` : ""}
          </td>
        </tr>`;
        }).join("");
        tbody.querySelectorAll("[data-view-row]").forEach(row => {
            row.addEventListener("click", (e) => {
                if (e.target.closest(".row-actions"))
                    return;
                openFiche(Number(row.dataset.viewRow));
            });
        });
        tbody.querySelectorAll("[data-action='edit']").forEach(b => b.addEventListener("click", () => openForm(Number(b.dataset.id))));
        tbody.querySelectorAll("[data-action='delete']").forEach(b => b.addEventListener("click", () => deleteItem(Number(b.dataset.id))));
        tbody.querySelectorAll("[data-action='localiser']").forEach(b => b.addEventListener("click", () => ouvrirRechercheGeographique(kind, Number(b.dataset.id))));
        tbody.querySelectorAll("[data-action='membres']").forEach(b => b.addEventListener("click", () => ouvrirListeMembresCellule(Number(b.dataset.id))));
        tbody.querySelectorAll("[data-action='cellules']").forEach(b => b.addEventListener("click", () => ouvrirListeCellulesSection(Number(b.dataset.id))));
    }
    draw(items);
    if (editingEntity && editingEntity.kind === kind) {
        const idAOuvrir = editingEntity.id;
        editingEntity = null;
        openForm(idAOuvrir);
    }
    if (kind === "membre" && fichePreouverte !== null) {
        const idAOuvrir = fichePreouverte;
        fichePreouverte = null;
        openFiche(idAOuvrir);
    }
    // Age revolu a la date du jour, calcule depuis la date de naissance.
    const ageDe = (m) => {
        if (!m.dateNaissance)
            return null;
        const n = new Date(m.dateNaissance);
        if (isNaN(n.getTime()))
            return null;
        const auj = new Date();
        let age = auj.getFullYear() - n.getFullYear();
        if (auj.getMonth() < n.getMonth() || (auj.getMonth() === n.getMonth() && auj.getDate() < n.getDate()))
            age--;
        return age;
    };
    // Recherche texte + (Membres) tranche d'age saisie. Une borne laissee
    // vide est ignoree ; un membre sans date de naissance valide est exclu
    // des que l'une des bornes est renseignee.
    function appliquerFiltres() {
        const q = $("#search-box").value.trim().toLowerCase();
        let liste = items;
        if (q)
            liste = liste.filter(it => JSON.stringify(it).toLowerCase().includes(q));
        if (kind === "membre") {
            const brutMin = $("#age-min").value.trim();
            const brutMax = $("#age-max").value.trim();
            let min = brutMin === "" ? null : Number(brutMin);
            let max = brutMax === "" ? null : Number(brutMax);
            if (min !== null && max !== null && min > max)
                [min, max] = [max, min];
            $("#age-reset").style.display = (min !== null || max !== null) ? "" : "none";
            if (min !== null || max !== null) {
                liste = liste.filter(m => {
                    const a = ageDe(m);
                    return a !== null && (min === null || a >= min) && (max === null || a <= max);
                });
            }
        }
        draw(liste);
    }
    $("#search-box").addEventListener("input", appliquerFiltres);
    if (kind === "membre") {
        $("#age-min").addEventListener("input", appliquerFiltres);
        $("#age-max").addEventListener("input", appliquerFiltres);
        $("#age-reset").addEventListener("click", () => {
            $("#age-min").value = "";
            $("#age-max").value = "";
            appliquerFiltres();
        });
    }
    // --- Exports de la liste affichee (tient compte de la recherche) ------
    // Membres : toutes les informations de la fiche en CSV (memes intitules
    // que le modele d'import, donc re-importable) ; PDF = colonnes cles.
    const dateCsv = (iso) => iso ? formatDateJJMMAAAA(iso) : "";
    const jourFichier = new Date().toISOString().slice(0, 10);
    function donneesExportListe() {
        const nomCellule = (id) => cellules.find(c => c.id === id)?.nom || "";
        const nomSection = (id) => sections.find(x => x.id === id)?.nom || "";
        if (kind === "membre") {
            const csvEntetes = ["N°", "Reference", "Nom", "Prenom", "Date de naissance", "Lieu de naissance", "Sexe",
                "Zone electorale", "Departement (ou Pays si Etranger)", "Commune (ou Localite si Etranger)",
                "Quartier / Village", "Numero de telephone", "Email", "Date de delivrance CNI", "Date d'expiration CNI",
                "Electeur", "Commune de vote", "Numero d'electeur", "Lieu de vote", "Bureau de vote",
                "Adhesion", "Annee d'adhesion", "Carte membre", "N° carte membre", "Fonction", "Mouvements affilies",
                "Cellule", "Section"];
            const csvLignes = listeAffichee.map(m => [m.numero, m.reference, m.nom, m.prenom, dateCsv(m.dateNaissance), m.lieuNaissance || "", m.sexe || "",
                m.zoneElectorale || "", m.departement || "", m.commune || "", m.quartierVillage || "", m.telephone || "", m.email || "",
                dateCsv(m.dateDelivranceCNI), dateCsv(m.dateExpirationCNI), m.electeur || "", m.communeVote || "", m.numeroElecteur || "",
                m.lieuVote || "", m.bureauVote || "", m.adhesion || "", m.dateAdhesion || "", m.carteMembre || "", m.numeroCarteMembre || "",
                m.fonction || "", (m.mouvements || []).join(" ; "), nomCellule(m.celluleId), nomSection(m.sectionId)]);
            const pdfEntetes = ["N°", "Reference", "Prenom & nom", "Sexe", "Cellule", "Section", "Commune", "Telephone", "Electeur", "Lieu de vote", "Bureau", "Carte membre"];
            const pdfLignes = listeAffichee.map(m => [m.numero, m.reference, nomComplet(m), m.sexe || "—", nomCellule(m.celluleId) || "—", nomSection(m.sectionId) || "—",
                m.commune || "—", m.telephone || "—", m.electeur || "—", m.lieuVote || "—", m.bureauVote || "—", m.carteMembre === "Oui" ? (m.numeroCarteMembre || "Oui") : "Non"]);
            const tuiles = [
                [listeAffichee.length, "Membres"],
                [`${listeAffichee.filter(m => m.sexe === "F").length}/${listeAffichee.filter(m => m.sexe === "M").length}`, "Femmes / hommes"],
                [listeAffichee.filter(m => m.electeur === "Oui").length, "Electeurs inscrits"],
                [listeAffichee.filter(m => m.electeur === "Non").length, "Non inscrits"],
            ];
            return { titre: "Liste des membres", fichier: `membres_${jourFichier}.csv`, csvEntetes, csvLignes, pdfEntetes, pdfLignes, tuiles };
        }
        const nbMembres = (it) => membresAll.filter(m => kind === "cellule" ? m.celluleId === it.id : m.sectionId === it.id).length;
        const bureauTxt = (it) => { const { pourvus, total } = bureauCompletude(it, bureauRoles); return `${pourvus}/${total}`; };
        const rolesEntetes = bureauRoles.map(r => r.label);
        const rolesValeurs = (it) => bureauRoles.map(r => it[r.key] ? nomMembre(it[r.key]) : "");
        if (kind === "cellule") {
            const quartierTxt = (it) => { const q = quartiers.find(x => x.id === it.quartierId); return q ? libelleQuartier(q) : ""; };
            return {
                titre: "Liste des cellules", fichier: `cellules_${jourFichier}.csv`,
                csvEntetes: ["N°", "Reference", "Nom", "Quartier", "Section", "Responsable (membre)", "Contact", "Membres", "Postes du bureau pourvus", ...rolesEntetes],
                csvLignes: listeAffichee.map(it => [it.numero, it.reference, it.nom, quartierTxt(it), nomSection(it.sectionId), it[responsableKey] ? nomMembre(it[responsableKey]) : "", it[contactKey] || "", nbMembres(it), bureauTxt(it), ...rolesValeurs(it)]),
                pdfEntetes: ["N°", "Reference", "Nom", "Quartier", "Section", "Responsable", "Contact", "Membres", "Bureau"],
                pdfLignes: listeAffichee.map(it => [it.numero, it.reference, it.nom, quartierTxt(it) || "—", nomSection(it.sectionId) || "—", it[responsableKey] ? nomMembre(it[responsableKey]) : "—", it[contactKey] || "—", nbMembres(it), bureauTxt(it)]),
                tuiles: [[listeAffichee.length, "Cellules"], [listeAffichee.reduce((t, it) => t + nbMembres(it), 0), "Membres rattaches"], [listeAffichee.filter(it => bureauCompletude(it, bureauRoles).complet).length, "Bureaux complets"]],
            };
        }
        const nbCellules = (it) => cellules.filter(c => c.sectionId === it.id).length;
        return {
            titre: "Liste des sections", fichier: `sections_${jourFichier}.csv`,
            csvEntetes: ["N°", "Reference", "Nom", "Responsable (membre)", "Contact", "Cellules", "Membres", "Postes du bureau pourvus", ...rolesEntetes],
            csvLignes: listeAffichee.map(it => [it.numero, it.reference, it.nom, it[responsableKey] ? nomMembre(it[responsableKey]) : "", it[contactKey] || "", nbCellules(it), nbMembres(it), bureauTxt(it), ...rolesValeurs(it)]),
            pdfEntetes: ["N°", "Reference", "Nom", "Responsable", "Contact", "Cellules", "Membres", "Bureau"],
            pdfLignes: listeAffichee.map(it => [it.numero, it.reference, it.nom, it[responsableKey] ? nomMembre(it[responsableKey]) : "—", it[contactKey] || "—", nbCellules(it), nbMembres(it), bureauTxt(it)]),
            tuiles: [[listeAffichee.length, "Sections"], [listeAffichee.reduce((t, it) => t + nbCellules(it), 0), "Cellules regroupees"], [listeAffichee.filter(it => bureauCompletude(it, bureauRoles).complet).length, "Bureaux complets"]],
        };
    }
    $("#export-csv-btn").addEventListener("click", () => {
        if (!listeAffichee.length) {
            toast("Aucune donnee a exporter.", "info");
            return;
        }
        const e = donneesExportListe();
        exporterCSV(e.fichier, e.csvEntetes, e.csvLignes);
    });
    $("#export-pdf-btn").addEventListener("click", () => {
        if (!listeAffichee.length) {
            toast("Aucune donnee a exporter.", "info");
            return;
        }
        const e = donneesExportListe();
        const recherche = $("#search-box").value.trim();
        const ageMin = kind === "membre" ? $("#age-min").value.trim() : "";
        const ageMax = kind === "membre" ? $("#age-max").value.trim() : "";
        const trancheAge = ageMin !== "" && ageMax !== "" ? `${Math.min(Number(ageMin), Number(ageMax))} a ${Math.max(Number(ageMin), Number(ageMax))} ans`
            : ageMin !== "" ? `${ageMin} ans et plus` : ageMax !== "" ? `${ageMax} ans et moins` : "";
        exporterPDF(e.titre, `
      <div class="pdf-resume">${e.tuiles.map(([v, l]) => `<div class="pdf-tuile"><b>${escapeHtml(String(v))}</b><span>${escapeHtml(l)}</span></div>`).join("")}</div>
      ${recherche ? `<div class="pdf-meta" style="text-align:left;margin-bottom:8px;">Recherche : ${escapeHtml(recherche)}</div>` : ""}
      ${trancheAge ? `<div class="pdf-meta" style="text-align:left;margin-bottom:8px;">Tranche d'age : ${escapeHtml(trancheAge)}</div>` : ""}
      ${tableauPDF(e.pdfEntetes, e.pdfLignes)}`, "landscape");
    });
    if (canEdit) {
        $("#add-btn").addEventListener("click", () => openForm());
    }
    document.getElementById("gerer-quartiers-btn")?.addEventListener("click", () => ouvrirGestionQuartiers(async () => { await renderView(); }));
    document.getElementById("aller-carte-electorale")?.addEventListener("click", () => {
        currentView = "electorale";
        navHasBeenClicked = true;
        sousOngletElectorale = "bureaux";
        renderShell();
    });
    if (importDisponible) {
        const importBtn = $("#import-btn");
        const importBackdrop = $("#import-backdrop");
        const importClose = $("#import-close");
        const importCancel = $("#import-cancel");
        const importFile = $("#import-file");
        const importPreview = $("#import-preview");
        const importConfirm = $("#import-confirm");
        const importTemplateBtn = $("#import-template-download");
        let lignesCellule = [];
        let lignesMembre = [];
        importTemplateBtn.addEventListener("click", () => {
            const nomFichier = kind === "membre" ? "modele_import_membres.csv" : "modele_import_cellules.csv";
            telechargerFichierTexte(nomFichier, csvModele(kind));
        });
        const fermerImport = () => {
            importBackdrop.classList.remove("modal-backdrop--show");
            importFile.value = "";
            importPreview.innerHTML = "";
            importConfirm.disabled = true;
            lignesCellule = [];
            lignesMembre = [];
        };
        importBtn.addEventListener("click", () => importBackdrop.classList.add("modal-backdrop--show"));
        importClose.addEventListener("click", fermerImport);
        importCancel.addEventListener("click", fermerImport);
        importFile.addEventListener("change", async () => {
            const file = importFile.files?.[0];
            importConfirm.disabled = true;
            lignesCellule = [];
            lignesMembre = [];
            if (!file) {
                importPreview.innerHTML = "";
                return;
            }
            const text = await file.text();
            const rows = parseCSV(text);
            if (rows.length < 2) {
                importPreview.innerHTML = `<p class="form-note form-note--warn">Fichier vide, ou aucune ligne de donnees apres l'en-tete.</p>`;
                return;
            }
            const header = rows[0].map(normalizeHeader);
            const idx = (aliases) => header.findIndex(h => aliases.includes(h));
            const get = (r, i) => (i > -1 ? (r[i] || "").trim() : "");
            if (kind === "cellule") {
                const idxNom = idx(["nom", "nom de la cellule", "nom cellule"]);
                const idxQuartierCellule = idx(["quartier"]);
                const idxContact = idx(["contact du responsable", "contact responsable", "contact"]);
                const idxSection = idx(["section de rattachement", "section", "commune"]);
                if (idxNom === -1) {
                    importPreview.innerHTML = `<p class="form-note form-note--warn">Colonne "Nom de la cellule" introuvable dans l'en-tete du fichier.</p>`;
                    return;
                }
                if (idxQuartierCellule === -1) {
                    importPreview.innerHTML = `<p class="form-note form-note--warn">Colonne "Quartier" introuvable dans l'en-tete du fichier.</p>`;
                    return;
                }
                const nomsExistants = new Set(items.map((c) => c.nom.trim().toLowerCase()));
                const nomsVus = new Set();
                lignesCellule = rows.slice(1).map(r => {
                    const nom = get(r, idxNom);
                    const quartierNom = get(r, idxQuartierCellule);
                    const contactResponsable = get(r, idxContact);
                    const sectionNom = get(r, idxSection);
                    let error = "";
                    let sectionId;
                    let quartierId;
                    if (!nom)
                        error = "Nom manquant";
                    else if (nomsExistants.has(nom.toLowerCase()))
                        error = "Cellule deja existante";
                    else if (nomsVus.has(nom.toLowerCase()))
                        error = "Doublon dans le fichier";
                    if (!error) {
                        // Correspondance par NOM uniquement : ambigu si le meme
                        // nom de quartier existe dans plusieurs communes.
                        const correspondances = quartiers.filter(q => cleNom(q.nom) === cleNom(quartierNom));
                        if (!quartierNom)
                            error = "Quartier manquant";
                        else if (correspondances.length === 0)
                            error = "Quartier introuvable (le creer d'abord via \"Gerer les quartiers\")";
                        else if (correspondances.length > 1)
                            error = "Quartier ambigu (meme nom dans plusieurs communes) — renommer le quartier ou saisir sa commune";
                        else
                            quartierId = correspondances[0].id;
                    }
                    if (!error && sectionNom) {
                        const s = sections.find(sec => sec.nom.trim().toLowerCase() === sectionNom.toLowerCase());
                        if (s)
                            sectionId = s.id;
                        else
                            error = "Section introuvable";
                    }
                    if (!error)
                        nomsVus.add(nom.toLowerCase());
                    return { nom, quartierNom, quartierId, contactResponsable, sectionNom, sectionId, error };
                });
                const valides = lignesCellule.filter(l => !l.error).length;
                importPreview.innerHTML = `
          <p class="form-note ${valides === 0 ? "form-note--warn" : ""}">${valides} ligne(s) valide(s) sur ${lignesCellule.length}.</p>
          <div class="table-wrap" style="max-height:280px; overflow:auto;">
            <table class="data-table">
              <thead><tr><th>Nom</th><th>Quartier</th><th>Contact responsable</th><th>Section</th><th>Statut</th></tr></thead>
              <tbody>
                ${lignesCellule.map(l => `<tr>
                  <td>${escapeHtml(l.nom || "—")}</td>
                  <td>${escapeHtml(l.quartierNom || "—")}</td>
                  <td>${escapeHtml(l.contactResponsable || "—")}</td>
                  <td>${escapeHtml(l.sectionNom || "—")}</td>
                  <td>${l.error ? `<span class="badge badge--warn">${escapeHtml(l.error)}</span>` : `<span class="badge badge--success">OK</span>`}</td>
                </tr>`).join("")}
              </tbody>
            </table>
          </div>`;
                importConfirm.disabled = valides === 0;
                return;
            }
            // kind === "membre" : colonnes calquees sur FIELD_DEFS.membre.
            const idxNom = idx(["nom"]);
            const idxPrenom = idx(["prenom"]);
            const idxDateNaissance = idx(["date de naissance", "date naissance"]);
            const idxLieuNaissance = idx(["lieu de naissance", "lieu naissance"]);
            const idxSexe = idx(["sexe", "sexe (m/f)"]);
            const idxZoneElectorale = idx(["zone electorale", "zone", "zone electorale (national/etranger)"]);
            const idxDepartement = idx(["departement (ou pays si etranger)", "departement", "pays"]);
            const idxCommune = idx(["commune (ou localite si etranger)", "commune", "localite"]);
            const idxQuartier = idx(["quartier / village", "quartier/village", "quartier village", "quartier ou village", "quartier"]);
            const idxTelephone = idx(["numero de telephone", "telephone", "tel"]);
            const idxEmail = idx(["email", "e-mail", "mail"]);
            const idxDateDelivrance = idx(["date de delivrance cni", "date de delivrance", "date delivrance"]);
            const idxDateExpiration = idx(["date d'expiration cni", "date d'expiration", "date expiration"]);
            const idxElecteur = idx(["electeur", "electeur (oui/non)"]);
            const idxCommuneVote = idx(["commune de vote"]);
            const idxNumElecteur = idx(["numero d'electeur", "numero electeur", "n° electeur", "n electeur"]);
            const idxLieuVote = idx(["lieu de vote"]);
            const idxBureauVote = idx(["bureau de vote"]);
            const idxAdhesion = idx(["adhesion", "adhesion (ancien/nouveau)"]);
            const idxAnneeAdhesion = idx(["annee d'adhesion", "annee adhesion", "date d'adhesion"]);
            const idxCarteMembre = idx(["carte membre", "carte membre (oui/non)"]);
            const idxNumCarteMembre = idx(["n° carte membre", "n carte membre", "numero carte membre"]);
            const idxFonction = idx(["fonction", "fonction / profession / activite", "fonction/profession/activite", "profession"]);
            const idxMouvements = idx(["mouvements affilies", "mouvements", "mouvement", "mouvement affilie"]);
            const idxCellule = idx(["cellule", "cellule de rattachement"]);
            const idxSectionM = idx(["section", "section de rattachement"]);
            const manquantes = [];
            if (idxNom === -1)
                manquantes.push("Nom");
            if (idxPrenom === -1)
                manquantes.push("Prenom");
            if (idxDateNaissance === -1)
                manquantes.push("Date de naissance");
            if (idxLieuNaissance === -1)
                manquantes.push("Lieu de naissance");
            if (manquantes.length) {
                importPreview.innerHTML = `<p class="form-note form-note--warn">Colonne(s) obligatoire(s) introuvable(s) dans l'en-tete : ${escapeHtml(manquantes.join(", "))}.</p>`;
                return;
            }
            const numsExistants = new Set(items.map((m) => m.numeroElecteur).filter(Boolean));
            const cartesExistantes = new Set(items.map((m) => m.numeroCarteMembre).filter(Boolean));
            const vus = new Set();
            // La reference (JJMM.PN_NNNN/ReferenceCellule) est simulee ligne
            // par ligne pour l'apercu : chaque membre valide consomme le rang
            // suivant DANS SA CELLULE, exactement comme a l'enregistrement.
            const membresExistants = await db.membres.toArray();
            const bureauxVoteImport = await db.bureauxVote.toArray();
            const rangs = new Map();
            const prochainRang = (celluleId) => {
                const cle = celluleId ? `c${celluleId}` : "sans-cellule";
                if (!rangs.has(cle))
                    rangs.set(cle, rangDansCellule(membresExistants, celluleId) - 1);
                const suivant = rangs.get(cle) + 1;
                rangs.set(cle, suivant);
                return suivant;
            };
            const nowIso = new Date().toISOString();
            lignesMembre = rows.slice(1).map(r => {
                const erreurs = [];
                const nom = get(r, idxNom);
                const prenom = get(r, idxPrenom);
                const dateNaissance = parseDateFlexible(get(r, idxDateNaissance));
                const lieuNaissance = get(r, idxLieuNaissance);
                const sexe = get(r, idxSexe).toUpperCase();
                const zoneBrut = get(r, idxZoneElectorale);
                const zoneElectorale = /^etranger$/i.test(zoneBrut) ? "Etranger" : "National";
                const departementSaisi = get(r, idxDepartement);
                const communeSaisie = get(r, idxCommune);
                // Departement/Commune (National) et Pays/Localite (Etranger) sont
                // verifies contre la carte electorale IMPORTEE par l'administrateur :
                // correspondance EXACTE requise (insensible a la casse/aux accents),
                // comme sur le formulaire de saisie — aucune valeur libre n'est acceptee.
                const departementsValides = departementsElectoraux(bureauxVoteImport, zoneElectorale);
                const departement = departementSaisi ? (departementsValides.find(d => cleNom(d) === cleNom(departementSaisi)) || "") : "";
                const communesValides = departement
                    ? communesElectorales(bureauxVoteImport, zoneElectorale, departement)
                    : toutesCommunesElectorales(bureauxVoteImport, zoneElectorale);
                const commune = communeSaisie ? (communesValides.find(c => cleNom(c) === cleNom(communeSaisie)) || "") : "";
                const quartierVillage = get(r, idxQuartier);
                const telephone = get(r, idxTelephone);
                const email = get(r, idxEmail);
                const dateDelivranceBrut = get(r, idxDateDelivrance);
                const dateExpirationBrut = get(r, idxDateExpiration);
                const dateDelivranceCNI = parseDateFlexible(dateDelivranceBrut);
                const dateExpirationCNI = parseDateFlexible(dateExpirationBrut);
                const electeurBrut = get(r, idxElecteur);
                const electeur = /^oui$/i.test(electeurBrut) ? "Oui" : /^non$/i.test(electeurBrut) ? "Non" : electeurBrut;
                // Commune de vote / lieu de vote / bureau de vote sont verifies
                // contre la carte electorale importee, avec la meme logique de
                // cascade que sur le formulaire de saisie.
                const communeVoteSaisie = get(r, idxCommuneVote);
                const communesVoteValides = toutesCommunesElectorales(bureauxVoteImport, zoneElectorale);
                const communeVote = communeVoteSaisie ? (communesVoteValides.find(c => cleNom(c) === cleNom(communeVoteSaisie)) || "") : "";
                const numeroElecteurBrut = get(r, idxNumElecteur);
                const numeroElecteur = numeroElecteurBrut.replace(/\D/g, "");
                const lieuVoteSaisi = get(r, idxLieuVote);
                // Si la commune de vote n'est pas renseignee, le lieu de vote
                // est cherche dans toute la zone electorale.
                const poolZone = bureauxDeLaZone(bureauxVoteImport, zoneElectorale);
                const lieuxVoteValides = communeVote
                    ? lieuxDeVoteElectoraux(bureauxVoteImport, zoneElectorale, communeVote)
                    : [...new Set(poolZone.map(b => b.lieuVote).filter(Boolean))];
                const lieuVote = lieuVoteSaisi ? (lieuxVoteValides.find(l => cleNom(l) === cleNom(lieuVoteSaisi)) || "") : "";
                const bureauVoteBrut = get(r, idxBureauVote);
                const bureauVoteSaisi = bureauVoteBrut.replace(/\D/g, "");
                const bureauxValides = !lieuVote ? [] : communeVote
                    ? bureauxDuLieuVote(bureauxVoteImport, zoneElectorale, communeVote, lieuVote)
                    : [...new Set(poolZone.filter(b => b.lieuVote === lieuVote).map(b => b.numeroBureau).filter(Boolean))];
                const bureauVote = bureauVoteSaisi ? (bureauxValides.find(b => b === bureauVoteSaisi || b === bureauVoteSaisi.padStart(2, "0")) || "") : "";
                const adhesionBrut = get(r, idxAdhesion);
                const adhesion = /^ancien$/i.test(adhesionBrut) ? "Ancien" : /^nouveau$/i.test(adhesionBrut) ? "Nouveau" : adhesionBrut;
                const anneeAdhesionBrut = get(r, idxAnneeAdhesion);
                const dateAdhesion = anneeAdhesionBrut.replace(/\D/g, "").slice(0, 4);
                const carteMembreBrut = get(r, idxCarteMembre);
                const carteMembre = /^oui$/i.test(carteMembreBrut) ? "Oui" : (carteMembreBrut ? "Non" : "Non");
                const numeroCarteMembre = get(r, idxNumCarteMembre);
                const fonction = get(r, idxFonction);
                // Plusieurs mouvements peuvent etre separes par ";", "/" ou ",".
                const mouvements = get(r, idxMouvements).split(/[;\/,]/).map(v => v.trim()).filter(Boolean);
                const celluleNom = get(r, idxCellule);
                const sectionNom = get(r, idxSectionM);
                // Obligatoires : prenom, nom, date de naissance, lieu de naissance.
                // Tous les autres champs sont facultatifs : vides, ils sont
                // ignores ; renseignes, ils sont controles puis charges.
                if (!nom)
                    erreurs.push("Nom manquant");
                if (!prenom)
                    erreurs.push("Prenom manquant");
                if (!dateNaissance)
                    erreurs.push("Date de naissance invalide");
                if (!lieuNaissance)
                    erreurs.push("Lieu de naissance manquant");
                if (sexe && sexe !== "M" && sexe !== "F")
                    erreurs.push("Sexe invalide (M/F)");
                if (departementSaisi && !departement)
                    erreurs.push(zoneElectorale === "Etranger" ? "Pays inconnu (voir carte electorale importee)" : "Departement inconnu (voir carte electorale importee)");
                if (communeSaisie && !commune)
                    erreurs.push(zoneElectorale === "Etranger" ? "Localite inconnue pour ce pays (voir carte electorale importee)" : "Commune inconnue pour ce departement (voir carte electorale importee)");
                if (dateDelivranceBrut && !dateDelivranceCNI)
                    erreurs.push("Date de delivrance CNI invalide");
                if (dateExpirationBrut && !dateExpirationCNI)
                    erreurs.push("Date d'expiration CNI invalide");
                if (electeur && electeur !== "Oui" && electeur !== "Non")
                    erreurs.push("Electeur invalide (Oui/Non)");
                if (communeVoteSaisie && !communeVote)
                    erreurs.push("Commune de vote inconnue (voir carte electorale importee)");
                if (numeroElecteurBrut && numeroElecteur.length !== 9)
                    erreurs.push("Numero d'electeur invalide (9 chiffres)");
                if (lieuVoteSaisi && !lieuVote)
                    erreurs.push("Lieu de vote inconnu pour cette commune (voir carte electorale importee)");
                if (bureauVoteBrut && !lieuVote)
                    erreurs.push("Lieu de vote requis pour renseigner le bureau de vote");
                else if (bureauVoteSaisi && !bureauVote)
                    erreurs.push("Bureau de vote inconnu pour ce lieu de vote (voir carte electorale importee)");
                else if (bureauVoteBrut && !bureauVoteSaisi)
                    erreurs.push("Bureau de vote invalide");
                if (adhesion && adhesion !== "Ancien" && adhesion !== "Nouveau")
                    erreurs.push("Adhesion invalide (Ancien/Nouveau)");
                if (anneeAdhesionBrut && dateAdhesion.length !== 4)
                    erreurs.push("Annee d'adhesion invalide (4 chiffres)");
                let celluleId;
                let celluleTrouvee;
                if (celluleNom) {
                    const c = cellules.find(x => x.nom.trim().toLowerCase() === celluleNom.toLowerCase());
                    if (c) {
                        celluleId = c.id;
                        celluleTrouvee = c;
                    }
                    else
                        erreurs.push("Cellule introuvable");
                }
                let sectionId;
                if (sectionNom) {
                    const s = sections.find(x => x.nom.trim().toLowerCase() === sectionNom.toLowerCase());
                    if (s)
                        sectionId = s.id;
                    else
                        erreurs.push("Section introuvable");
                }
                if (numeroElecteur) {
                    if (numsExistants.has(numeroElecteur))
                        erreurs.push("Numero d'electeur deja utilise");
                    else if (vus.has("e:" + numeroElecteur))
                        erreurs.push("Doublon dans le fichier (numero electeur)");
                }
                if (numeroCarteMembre) {
                    if (cartesExistantes.has(numeroCarteMembre))
                        erreurs.push("N° carte membre deja utilise");
                    else if (vus.has("c:" + numeroCarteMembre))
                        erreurs.push("Doublon dans le fichier (carte membre)");
                }
                if (erreurs.length === 0) {
                    if (numeroElecteur)
                        vus.add("e:" + numeroElecteur);
                    if (numeroCarteMembre)
                        vus.add("c:" + numeroCarteMembre);
                }
                // Seules les lignes valides consomment un rang, pour que
                // l'apercu corresponde exactement a ce qui sera enregistre.
                const referenceApercu = erreurs.length === 0
                    ? memberReference(prochainRang(celluleId), prenom, nom, dateNaissance, celluleTrouvee?.reference)
                    : "—";
                const data = {
                    nom, prenom, dateNaissance, lieuNaissance, sexe, zoneElectorale,
                    departement, commune, quartierVillage, celluleId, sectionId, telephone, email,
                    dateDelivranceCNI, dateExpirationCNI,
                    electeur, communeVote, numeroElecteur, lieuVote, bureauVote,
                    adhesion, dateAdhesion, carteMembre, numeroCarteMembre,
                    fonction, mouvements, photoDataUrl: "",
                };
                // numeroElecteur est indexe en UNIQUE : une valeur vide ("")
                // ferait echouer le 2e membre sans numero. On omet donc la cle.
                if (!numeroElecteur)
                    delete data.numeroElecteur;
                return { affichageNom: `${prenom} ${nom}`.trim(), celluleNom, referenceApercu, error: erreurs.join("; "), data };
            });
            const valides = lignesMembre.filter(l => !l.error).length;
            importPreview.innerHTML = `
        <p class="form-note ${valides === 0 ? "form-note--warn" : ""}">${valides} ligne(s) valide(s) sur ${lignesMembre.length}.</p>
        <div class="table-wrap" style="max-height:280px; overflow:auto;">
          <table class="data-table">
            <thead><tr><th>Prenom &amp; nom</th><th>Cellule</th><th>Reference (apercu)</th><th>Statut</th></tr></thead>
            <tbody>
              ${lignesMembre.map(l => `<tr>
                <td>${escapeHtml(l.affichageNom || "—")}</td>
                <td>${escapeHtml(l.celluleNom || "—")}</td>
                <td><span class="ref-badge">${escapeHtml(l.referenceApercu)}</span></td>
                <td>${l.error ? `<span class="badge badge--warn" title="${escapeHtml(l.error)}">${escapeHtml(l.error)}</span>` : `<span class="badge badge--success">OK</span>`}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>`;
            importConfirm.disabled = valides === 0;
        });
        importConfirm.addEventListener("click", async () => {
            if (kind === "cellule") {
                const aImporter = lignesCellule.filter(l => !l.error);
                let ok = 0, ko = 0;
                for (const l of aImporter) {
                    const res = await ajouterCellule({ nom: l.nom, quartierId: l.quartierId, contactResponsable: l.contactResponsable, sectionId: l.sectionId }, true);
                    if (res.ok)
                        ok++;
                    else
                        ko++;
                }
                // Une seule renumerotation globale a la fin de l'import.
                await synchroniserReferences();
                toast(`${ok} cellule(s) importee(s)${ko ? `, ${ko} echec(s)` : ""}.`, ko ? "info" : "success");
            }
            else {
                const aImporter = lignesMembre.filter(l => !l.error);
                let ok = 0, ko = 0;
                try {
                    ({ ok, ko } = await ajouterMembresEnMasse(aImporter.map(l => l.data)));
                }
                catch (e) {
                    // Envoi groupe refuse (ex. doublon non detecte a l'apercu) : repli ligne par ligne.
                    ok = 0;
                    ko = 0;
                    for (const l of aImporter) {
                        const res = await ajouterMembre(l.data, true);
                        if (res.ok)
                            ok++;
                        else
                            ko++;
                    }
                }
                // Une seule renumerotation globale a la fin de l'import.
                await resynchroniserReferencesMembres();
                toast(`${ok} membre(s) importe(s)${ko ? `, ${ko} echec(s)` : ""}.`, ko ? "info" : "success");
            }
            fermerImport();
            renderView();
        });
    }
    async function deleteItem(id) {
        if (!confirm("Confirmer la suppression de cet enregistrement ?"))
            return;
        await tableFor(kind).delete(id);
        // Une suppression libere un rang dans la numerotation des references :
        // celle-ci est recalculee pour rester continue.
        if (kind === "cellule" || kind === "section")
            await synchroniserReferences();
        else
            await resynchroniserReferencesMembres();
        toast("Enregistrement supprime.", "success");
        renderView();
    }
    function closeFiche() {
        $("#fiche-backdrop").classList.remove("modal-backdrop--show");
    }
    $("#fiche-close").onclick = closeFiche;
    function ficheRow(label, value) {
        return `<div class="fiche-row"><span class="fiche-row__label">${escapeHtml(label)}</span><span class="fiche-row__value">${value || "—"}</span></div>`;
    }
    // Fiche technique : affichage en lecture seule (aucune modification possible),
    // ouverte au clic sur une ligne ou sur l'icone "oeil".
    // Fiche individuelle d'un membre au format PDF (toutes les rubriques de la fiche).
    function exporterFicheMembrePDF(m) {
        const celluleNom = cellules.find(c => c.id === m.celluleId)?.nom || "";
        const sectionNom = sections.find(x => x.id === m.sectionId)?.nom || "";
        const etranger = m.zoneElectorale === "Etranger";
        const v = (x) => (x === undefined || x === null || x === "") ? "—" : String(x);
        const dj = (iso) => iso ? formatDateJJMMAAAA(iso) : "—";
        const bloc = (titre, lignes) => `
      <h2>${escapeHtml(titre)}</h2>
      <table><tbody>${lignes.map(([l, val]) => `<tr><td style="width:34%;font-weight:600;">${escapeHtml(l)}</td><td>${escapeHtml(v(val))}</td></tr>`).join("")}</tbody></table>`;
        const alertes = [estCniExpiree(m) ? "CNI expiree — a renouveler" : "", estHorsZone(m) ? "Hors zone — a transferer" : ""].filter(Boolean).join(" · ");
        exporterPDF(`Fiche membre — ${nomComplet(m)}`, `
      <div style="display:flex;gap:16px;align-items:center;margin-bottom:6px;">
        ${m.photoDataUrl ? `<img src="${escapeHtml(m.photoDataUrl)}" alt="" style="height:96px;width:96px;object-fit:cover;border-radius:8px;border:1px solid #CBD5E1;">` : ""}
        <div>
          <div style="font-size:19px;font-weight:700;color:#006725;">${escapeHtml(nomComplet(m))}</div>
          <div style="color:#64748B;">${escapeHtml(m.reference || "")}${m.fonction ? ` · ${escapeHtml(m.fonction)}` : ""}</div>
          ${alertes ? `<div style="color:#9F1A16;font-weight:600;margin-top:4px;">${escapeHtml(alertes)}</div>` : ""}
        </div>
      </div>
      ${bloc("Identite", [["N°", m.numero], ["Reference", m.reference], ["Date de naissance", dj(m.dateNaissance)], ["Lieu de naissance", m.lieuNaissance], ["Sexe", m.sexe]])}
      ${bloc("Coordonnees & localisation", [["Cellule", celluleNom], ["Section", sectionNom], ["Zone electorale", etranger ? "Etranger (diaspora)" : "National (Senegal)"],
            [etranger ? "Pays" : "Departement", m.departement], [etranger ? "Localite" : "Commune", m.commune], ["Quartier / Village", m.quartierVillage], ["Telephone", m.telephone], ["Email", m.email]])}
      ${bloc("Carte Nationale d'Identite", [["Date de delivrance", dj(m.dateDelivranceCNI)], ["Date d'expiration", dj(m.dateExpirationCNI)]])}
      ${bloc("Situation electorale", [["Electeur", m.electeur], ["Commune de vote", m.communeVote], ["N° electeur", m.numeroElecteur], ["Lieu de vote", m.lieuVote], ["Bureau de vote", m.bureauVote]])}
      ${bloc("Adhesion", [["Adhesion", m.adhesion], ["Annee d'adhesion", m.dateAdhesion], ["Carte membre", m.carteMembre], ...(m.carteMembre === "Oui" ? [["N° carte membre", m.numeroCarteMembre]] : [])])}
      ${bloc("Autres", [["Fonction / Profession", m.fonction], ["Mouvements affilies", (m.mouvements || []).join(" ; ")], ["Cree le", formatDate(m.createdAt)], ["Modifie le", formatDate(m.updatedAt)]])}`, "portrait");
    }
    function openFiche(id) {
        const item = items.find(i => i.id === id);
        if (!item)
            return;
        $("#fiche-title").textContent = `Fiche ${labels.singular} — ${item.reference}`;
        const body = $("#fiche-body");
        if (kind === "membre") {
            const celluleNom = cellules.find(c => c.id === item.celluleId)?.nom || "—";
            const sectionNom = sections.find(s => s.id === item.sectionId)?.nom || "—";
            const alertes = [
                estCniExpiree(item) ? `<span class="badge badge--warn">CNI expiree — a renouveler</span>` : "",
                estHorsZone(item) ? `<span class="badge badge--warn">Hors zone — a transferer</span>` : "",
            ].filter(Boolean).join(" ");
            body.innerHTML = `
        <div class="fiche-header">
          ${avatarHtml(item.photoDataUrl, nomComplet(item), "xl")}
          <div>
            <div class="fiche-header__name">${escapeHtml(nomComplet(item))}</div>
            <div class="fiche-header__sub">${escapeHtml(item.fonction || "")}</div>
            ${alertes ? `<div class="fiche-header__alerts">${alertes}</div>` : ""}
          </div>
        </div>
        <div class="liste-outils">
          <button type="button" class="btn btn--ghost" data-fiche-localiser="${item.id}">&#127757; Recherche geographique</button>
          <button type="button" class="btn btn--ghost" data-fiche-pdf="${item.id}">&#128438; Exporter PDF</button>
        </div>
        <div class="fiche-grid">
          ${ficheRow("N°", String(item.numero))}
          ${ficheRow("Reference", `<span class="ref-badge">${item.reference}</span>`)}
          ${ficheRow("Date de naissance", formatDateJJMMAAAA(item.dateNaissance))}
          ${ficheRow("Lieu de naissance", escapeHtml(item.lieuNaissance))}
          ${ficheRow("Sexe", escapeHtml(item.sexe))}
        </div>
        <h4 class="fiche-section-title">Coordonnées & localisation</h4>
        <div class="fiche-grid">
          ${ficheRow("Cellule", escapeHtml(celluleNom))}
          ${ficheRow("Section", escapeHtml(sectionNom))}
          ${ficheRow("Zone électorale", escapeHtml(item.zoneElectorale === "Etranger" ? "Étranger (diaspora)" : "National (Sénégal)"))}
          ${item.zoneElectorale === "Etranger" ? ficheRow("Pays", escapeHtml(item.departement)) : ficheRow("Departement", escapeHtml(item.departement))}
          ${item.zoneElectorale === "Etranger" ? ficheRow("Localité", escapeHtml(item.commune)) : ficheRow("Commune", escapeHtml(item.commune))}
          ${ficheRow("Quartier / Village", escapeHtml(item.quartierVillage))}
          ${ficheRow("Telephone", escapeHtml(item.telephone))}
          ${ficheRow("Email", escapeHtml(item.email))}
        </div>
        <h4 class="fiche-section-title">Carte Nationale d'Identité</h4>
        <div class="fiche-grid">
          ${ficheRow("Date de delivrance", formatDateJJMMAAAA(item.dateDelivranceCNI))}
          ${ficheRow("Date d'expiration", formatDateJJMMAAAA(item.dateExpirationCNI))}
        </div>
        <h4 class="fiche-section-title">Situation électorale</h4>
        <div class="fiche-grid">
          ${ficheRow("Electeur", escapeHtml(item.electeur))}
          ${ficheRow("Commune de vote", escapeHtml(item.communeVote))}
          ${ficheRow("N° electeur", escapeHtml(item.numeroElecteur))}
          ${ficheRow("Lieu de vote", escapeHtml(item.lieuVote))}
          ${ficheRow("Bureau de vote", escapeHtml(item.bureauVote))}
        </div>
        <h4 class="fiche-section-title">Adhésion</h4>
        <div class="fiche-grid">
          ${ficheRow("Adhesion", escapeHtml(item.adhesion))}
          ${ficheRow("Annee d'adhesion", escapeHtml(item.dateAdhesion))}
          ${ficheRow("Carte membre", escapeHtml(item.carteMembre))}
          ${item.carteMembre === "Oui" ? ficheRow("N° carte membre", escapeHtml(item.numeroCarteMembre)) : ""}
        </div>
        <h4 class="fiche-section-title">Autres</h4>
        <div class="fiche-grid">
          ${ficheRow("Fonction / Profession", escapeHtml(item.fonction))}
          ${ficheRow("Mouvements affilies", (item.mouvements || []).length
                ? (item.mouvements || []).map(v => `<span class="chip chip--lecture">${escapeHtml(v)}</span>`).join(" ")
                : "")}
          ${ficheRow("Cree le", formatDate(item.createdAt))}
          ${ficheRow("Modifie le", formatDate(item.updatedAt))}
        </div>`;
        }
        else {
            const sectionNom = kind === "cellule" ? (sections.find(s => s.id === item.sectionId)?.nom || "—") : "";
            const contact = item[contactKey] || "—";
            const membresDeLaStructure = membresAll.filter(m => kind === "cellule" ? m.celluleId === item.id : m.sectionId === item.id);
            const idsAvecPoste = new Set(bureauRoles.map(r => item[r.key]).filter(Boolean));
            const { pourvus, total, complet } = bureauCompletude(item, bureauRoles);
            const bureauHtml = bureauRoles.map(r => `
        <div class="fiche-bureau-row">
          ${avatarHtml(membresAll.find(m => m.id === item[r.key])?.photoDataUrl, nomMembre(item[r.key]), "sm")}
          <div>
            <div class="fiche-bureau-row__role">${r.label}</div>
            <div class="fiche-bureau-row__name">${escapeHtml(nomMembre(item[r.key]))}</div>
          </div>
        </div>`).join("");
            const geometrieFiche = kind === "cellule"
                ? (aUneGeometrie(item) ? item.geometry : null)
                : geometrieSection(item, cellules);
            body.innerHTML = `
        <div class="liste-outils">
          <button type="button" class="btn btn--ghost" data-fiche-localiser="${item.id}">&#127757; Recherche geographique</button>
          ${kind === "cellule"
                ? `<button type="button" class="btn btn--primary" data-fiche-membres="${item.id}">&#128100; Membres (${membresDeLaStructure.length})</button>`
                : `<button type="button" class="btn btn--primary" data-fiche-cellules="${item.id}">&#127961; Cellules (${cellules.filter(c => c.sectionId === item.id).length})</button>`}
          ${kind === "cellule" && can(session.role, "manageStructure")
                ? `<button type="button" class="btn btn--ghost" data-fiche-geometrie="${item.id}">&#9998; Geometrie</button>` : ""}
        </div>
        <div class="fiche-grid">
          ${ficheRow("N°", String(item.numero))}
          ${ficheRow("Reference", `<span class="ref-badge">${item.reference}</span>`)}
          ${ficheRow("Nom", escapeHtml(item.nom))}
          ${kind === "cellule" ? (() => {
                const q = quartiers.find(x => x.id === item.quartierId);
                return ficheRow("Quartier", q ? `${escapeHtml(q.nom)} <span class="badge badge--muted">${escapeHtml(q.commune)}</span>` : `<span class="badge badge--warn">A definir</span>`);
            })() : ""}
          ${kind === "cellule" ? ficheRow("Section de rattachement", escapeHtml(sectionNom)) : ""}
          ${ficheRow("Contact responsable", escapeHtml(contact))}
          ${ficheRow("Membres rattaches", String(membresDeLaStructure.length))}
          ${kind === "section" ? ficheRow("Cellules regroupees", String(cellules.filter(c => c.sectionId === item.id).length)) : ""}
          ${ficheRow("Geometrie", geometrieFiche
                ? `${escapeHtml(formatSuperficie(aireGeometrie(geometrieFiche)))}${kind === "section" ? " (regroupement automatique des cellules)" : ""}`
                : "Non definie")}
          ${ficheRow("Cree le", formatDate(item.createdAt))}
          ${ficheRow("Modifie le", formatDate(item.updatedAt))}
        </div>
        <h4 class="fiche-section-title">Bureau
          <span class="badge ${complet ? "badge--success" : "badge--warn"}">${complet ? "Complet" : `Incomplet — ${pourvus}/${total} postes pourvus`}</span>
        </h4>
        <div class="fiche-bureau-grid">${bureauHtml}</div>
        ${membresDeLaStructure.length ? `
        <h4 class="fiche-section-title">Membres rattaches (${membresDeLaStructure.length})</h4>
        <div class="fiche-membres-list">${membresDeLaStructure.map(m => `
          <div class="fiche-membre-chip">
            ${avatarHtml(m.photoDataUrl, nomComplet(m), "sm")}<span>${escapeHtml(nomComplet(m))}</span>
            ${idsAvecPoste.has(m.id) ? "" : `<button type="button" class="badge badge--warn badge--clickable" data-affecter-poste="${m.id}" title="Cliquer pour affecter un poste">Sans Poste</button>`}
          </div>
        `).join("")}</div>` : ""}
      `;
            body.querySelectorAll("[data-affecter-poste]").forEach(btn => {
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    $("#fiche-backdrop").classList.remove("modal-backdrop--show");
                    affecterPosteRapide(item.id, Number(btn.dataset.affecterPoste));
                });
            });
        }
        // Boutons communs a toutes les fiches : recherche geographique, liste
        // des membres (cellule) / des cellules (section), edition de geometrie.
        body.querySelector("[data-fiche-localiser]")?.addEventListener("click", () => ouvrirRechercheGeographique(kind, item.id));
        body.querySelector("[data-fiche-pdf]")?.addEventListener("click", () => exporterFicheMembrePDF(item));
        body.querySelector("[data-fiche-membres]")?.addEventListener("click", () => ouvrirListeMembresCellule(item.id));
        body.querySelector("[data-fiche-cellules]")?.addEventListener("click", () => ouvrirListeCellulesSection(item.id));
        body.querySelector("[data-fiche-geometrie]")?.addEventListener("click", () => {
            closeFiche();
            ouvrirEditeurGeometrieCellule(item.id, async () => { await renderView(); });
        });
        $("#fiche-backdrop").classList.add("modal-backdrop--show");
    }
    // Ouvre le formulaire de modification de la cellule/section et pre-selectionne
    // le membre indique sur le premier poste de bureau encore vacant (affectation
    // rapide depuis l'etiquette "Sans Poste" de la fiche).
    function affecterPosteRapide(structureId, membreId) {
        openForm(structureId);
        requestAnimationFrame(() => {
            const form = $("#entity-form");
            const posteVacant = bureauRoles.find(r => {
                const sel = form.querySelector(`[name="${r.key}"]`);
                return sel && !sel.value;
            });
            if (!posteVacant) {
                toast("Tous les postes du bureau sont deja pourvus. Modifiez une affectation existante si besoin.", "info");
                return;
            }
            const sel = form.querySelector(`[name="${posteVacant.key}"]`);
            if (sel) {
                sel.value = String(membreId);
                sel.dispatchEvent(new Event("change"));
                sel.classList.add("field-highlight");
                sel.scrollIntoView({ behavior: "smooth", block: "center" });
            }
        });
    }
    function relationSelect(name, label, options, current, fullWidth) {
        const opts = options.map(o => `<option value="${o.id}" ${o.id === current ? "selected" : ""}>${escapeHtml(o.nom || "")}</option>`).join("");
        const cls = fullWidth ? "field field--full" : "field";
        return `<label class="${cls}"><span>${label}</span><select name="${name}"><option value="">-- Aucune --</option>${opts}</select></label>`;
    }
    // Selects de composition du bureau : uniquement les membres deja rattaches
    // (via leur fiche Membre) a CETTE cellule/section. Regle imperative :
    // un bureau ne peut etre compose que de membres de la meme cellule/section.
    function bureauSelectsHtml(editing) {
        if (!editing) {
            return `<p class="form-note">Le bureau se compose apres coup : enregistrez d'abord cette ${labels.singular}, rattachez-y des membres (fiche Membre &rarr; ${labels.singular} de rattachement), puis revenez modifier cette fiche pour designer le bureau.</p>`;
        }
        const eligibles = membresAll.filter(m => kind === "cellule" ? m.celluleId === editing.id : m.sectionId === editing.id);
        const notice = eligibles.length
            ? `<p class="form-note">Seuls les membres deja rattaches a cette ${labels.singular} apparaissent ci-dessous.</p>`
            : `<p class="form-note form-note--warn">Aucun membre n'est encore rattache a cette ${labels.singular}. Rattachez des membres avant de composer le bureau.</p>`;
        const selects = bureauRoles.map(r => relationSelect(r.key, r.label, eligibles.map(m => ({ id: m.id, nom: nomComplet(m) })), editing[r.key])).join("");
        return notice + selects;
    }
    // Valeurs deja saisies dans la base, proposees en autocompletion sur les
    // champs marques `liste: true` et sur les mouvements affilies.
    function suggestionsChamps() {
        const source = kind === "membre" ? items : [];
        const distinctes = (extraire) => {
            const set = new Set();
            for (const m of source)
                for (const v of extraire(m))
                    if (v && String(v).trim())
                        set.add(String(v).trim());
            return [...set].sort((a, b) => a.localeCompare(b, "fr"));
        };
        return {
            // Departement/Commune (National) et Pays/Localite (Etranger) sont
            // desormais des comboboxes a selection stricte sur la carte
            // electorale officielle : plus besoin de suggestions issues de la
            // base.
            fonction: distinctes(m => [m.fonction]),
            mouvements: distinctes(m => (Array.isArray(m.mouvements) ? m.mouvements : [])),
        };
    }
    function openForm(id) {
        const editing = id ? items.find(i => i.id === id) : null;
        $("#modal-title").textContent = editing ? `Modifier ${labels.singular}` : `Ajouter ${labels.singular}`;
        const form = $("#entity-form");
        const suggestions = suggestionsChamps();
        let extraSelects = "";
        let photoField = "";
        // Les rattachements sont designes par leur REFERENCE (et non par leur
        // nom), plusieurs structures pouvant porter le meme nom.
        const optionsRef = (liste) => liste
            .slice().sort((a, b) => String(a.reference || "").localeCompare(String(b.reference || ""), "fr"))
            .map(x => ({ id: x.id, nom: x.reference }));
        if (kind === "membre") {
            extraSelects = relationSelect("celluleId", "Cellule de rattachement", optionsRef(cellules), editing?.celluleId, true) +
                relationSelect("sectionId", "Section de rattachement", optionsRef(sections), editing?.sectionId, true);
            photoField = `
        <div class="field field--photo field--full">
          <span>Photo du membre</span>
          <div class="photo-picker">
            <div id="photo-apercu">${avatarHtml(editing?.photoDataUrl, editing ? nomComplet(editing) : "?", "lg")}</div>
            <div class="photo-actions">
              <button type="button" class="btn btn--ghost btn--xs" id="photo-choisir">&#128247; Choisir une photo</button>
              <button type="button" class="btn btn--ghost btn--xs" id="photo-recadrer">&#9986; Recadrer</button>
              <button type="button" class="btn btn--ghost btn--xs" id="photo-retirer">&#128465; Retirer</button>
            </div>
            <input type="file" accept="image/*" id="photo-input" hidden>
          </div>
        </div>`;
        }
        if (kind === "cellule") {
            extraSelects = relationSelect("sectionId", "Section de rattachement", optionsRef(sections), editing?.sectionId, true);
        }
        // --- Quartier (cellule uniquement) : combobox a selection stricte sur
        // les quartiers crees par l'administrateur (voir ouvrirGestionQuartiers).
        // Un quartier deja rattache a une commune officielle, choisir un
        // quartier fixe donc implicitement la commune de la cellule.
        let quartierHtml = "";
        if (kind === "cellule") {
            const quartierActuel = editing ? quartiers.find(q => q.id === editing.quartierId) : null;
            quartierHtml = quartiers.length
                ? comboboxIdHtml("quartierTexte", "quartierId", "Quartier", true, quartierActuel ? libelleQuartier(quartierActuel) : "", editing?.quartierId)
                : `<div class="field field--full"><span>Quartier</span><p class="form-note form-note--warn">Aucun quartier n'a encore ete cree. ${can(session.role, "manageStructure") ? `Utilisez le bouton "Gerer les quartiers" ci-dessus avant d'ajouter une cellule.` : "Contactez l'administrateur principal."}</p></div>`;
        }
        // --- Contact responsable (cellule + section) : recherche parmi les
        // membres existants (par nom ou telephone) — la selectionner remplit
        // automatiquement Prenom/Nom (lecture seule). Reste une saisie libre :
        // le contact n'est pas force d'etre deja un membre du systeme.
        function contactResponsableHtml() {
            const cle = kind === "cellule" ? "contactResponsable" : "contactResponsableSection";
            const label = kind === "cellule" ? "Contact responsable" : "Contact responsable section";
            const valeur = editing?.[cle] || "";
            const membreActuel = valeur ? membresAll.find(m => m.telephone === valeur) : null;
            return `
        <label class="field" data-field="${cle}">
          <span>${escapeHtml(label)} *</span>
          <div class="combobox">
            <input type="text" name="${cle}" value="${escapeHtml(valeur)}" autocomplete="off" spellcheck="false" required>
            <div class="combobox__liste" hidden></div>
          </div>
          <small class="field-hint">Recherchez un membre existant (nom ou telephone) pour remplir automatiquement son identite, ou saisissez un numero libre.</small>
        </label>
        <label class="field"><span>Prénom</span><input type="text" id="resp-prenom" value="${escapeHtml(membreActuel ? membreActuel.prenom : "")}" readonly></label>
        <label class="field"><span>Nom</span><input type="text" id="resp-nom" value="${escapeHtml(membreActuel ? membreActuel.nom : "")}" readonly></label>`;
        }
        // --- Localisation (Departement/Commune en National, Pays/Localite en
        // Etranger) : comboboxes a selection stricte sur la carte electorale
        // officielle, en cascade. Inseree entre "Identite" et "Quartier /
        // Village" pour rester dans le flux naturel de la section
        // "Coordonnees & localisation" (voir FIELD_DEFS.membre).
        function localisationHtml() {
            const estEtranger = editing?.zoneElectorale === "Etranger";
            return `
        <label class="field field--full" data-field="zoneElectorale">
          <span>Zone électorale *</span>
          <select name="zoneElectorale" required>
            <option value="National" ${!estEtranger ? "selected" : ""}>National (Sénégal)</option>
            <option value="Etranger" ${estEtranger ? "selected" : ""}>Étranger (diaspora)</option>
          </select>
        </label>
        ${comboboxHtml("departement", estEtranger ? "Pays" : "Département", true, editing?.departement)}
        ${comboboxHtml("commune", estEtranger ? "Localité" : "Commune", true, editing?.commune)}`;
        }
        // --- Situation electorale : Commune de vote / Lieu de vote / Bureau de
        // vote, en cascade, sourcees de la carte electorale importee (voir
        // situationVoteHtml plus bas pour la note explicative).
        function situationVoteHtml() {
            return `
        ${comboboxHtml("communeVote", "Commune de vote", true, editing?.communeVote)}
        ${comboboxHtml("lieuVote", "Lieu de vote", true, editing?.lieuVote)}
        ${comboboxHtml("bureauVote", "Bureau de vote", true, editing?.bureauVote)}
        <p class="form-note field--full">Si la commune de vote differe de la commune de residence, le membre est automatiquement signale dans Transferts, Renouvellement &amp; Non inscrits &gt; Transferts.</p>`;
        }
        // --- Geometrie de la cellule (creation / import d'un polygone) -------
        // Disponible uniquement en modification : la cellule doit exister pour
        // porter une geometrie. La geometrie de sa section en decoule.
        let geometrieHtml = "";
        if (kind === "cellule") {
            if (!editing) {
                geometrieHtml = `<div class="geom-zone"><p class="form-note">La geometrie (polygone) s'associe apres coup : enregistrez d'abord cette cellule, puis revenez la modifier pour dessiner ou importer son polygone.</p></div>`;
            }
            else {
                const geom = aUneGeometrie(editing) ? editing.geometry : null;
                const peutGeom = can(session.role, "manageStructure");
                geometrieHtml = `
        <div class="geom-zone">
          <h4 class="form-section-title" style="margin-top:0;">Geometrie de la cellule</h4>
          <div class="geom-statut">
            <span class="badge ${geom ? "badge--success" : "badge--warn"}">${geom ? "Polygone defini" : "Aucune geometrie"}</span>
            ${geom ? `<span class="geom-statut__valeur">${escapeHtml(formatSuperficie(aireGeometrie(geom)))}</span>
                      <span class="geom-statut__valeur">${polygonesDeGeometrie(geom).length} partie(s)</span>` : ""}
          </div>
          <div class="carte-actions">
            ${peutGeom ? `<button type="button" class="btn btn--primary btn--xs" id="geom-editer">&#9998; ${geom ? "Modifier" : "Dessiner"} / importer un polygone</button>` : ""}
            ${geom ? `<button type="button" class="btn btn--ghost btn--xs" id="geom-voir">&#127757; Voir sur la carte</button>` : ""}
          </div>
          <p class="form-note">Dessinez le polygone directement sur la carte, ou importez-le au format JSON / GeoJSON. La geometrie de la section de rattachement est automatiquement recalculee en regroupant les cellules qui la composent.${peutGeom ? "" : " (Modification reservee a l'administrateur principal.)"}</p>
        </div>`;
            }
        }
        const bureauHtml = (kind === "cellule" || kind === "section") ? `<fieldset class="bureau-fieldset"><legend>Bureau (membres de cette ${labels.singular})</legend>${bureauSelectsHtml(editing)}</fieldset>` : "";
        const modalEl = document.querySelector("#modal-backdrop .modal");
        if (modalEl)
            modalEl.classList.toggle("modal--xwide", kind === "membre");
        // Sur le formulaire membre, le bloc localisation s'insere entre les
        // champs "Identite" et "Quartier / Village" (premier champ de la
        // section "Coordonnees & localisation" restant dans FIELD_DEFS).
        let corpsChamps;
        if (kind === "membre") {
            const iLocalisation = fields.findIndex(f => f.key === "quartierVillage");
            const iVote = fields.findIndex(f => f.key === "numeroElecteur") + 1;
            corpsChamps = fields.slice(0, iLocalisation).map(f => renderField(f, editing, suggestions)).join("")
                + localisationHtml()
                + fields.slice(iLocalisation, iVote).map(f => renderField(f, editing, suggestions)).join("")
                + situationVoteHtml()
                + fields.slice(iVote).map(f => renderField(f, editing, suggestions)).join("");
        }
        else {
            corpsChamps = fields.map(f => renderField(f, editing, suggestions)).join("");
        }
        const contactHtml = (kind === "cellule" || kind === "section") ? contactResponsableHtml() : "";
        form.innerHTML = photoField + corpsChamps + quartierHtml + contactHtml + extraSelects + geometrieHtml + bureauHtml + `
      <div class="modal__actions">
        <button type="button" class="btn btn--ghost" id="cancel-btn">Annuler</button>
        <button type="submit" class="btn btn--primary">${editing ? "Enregistrer les modifications" : "Ajouter"}</button>
      </div>
    `;
        $("#modal-backdrop").classList.add("modal-backdrop--show");
        $("#modal-close").onclick = closeForm;
        $("#cancel-btn").onclick = closeForm;
        // Boutons de geometrie du formulaire cellule. La geometrie est
        // enregistree independamment des autres champs (elle se modifie
        // depuis la carte, pas depuis ce formulaire).
        form.querySelector("#geom-editer")?.addEventListener("click", () => {
            closeForm();
            ouvrirEditeurGeometrieCellule(editing.id, async () => { await renderView(); });
        });
        form.querySelector("#geom-voir")?.addEventListener("click", () => ouvrirRechercheGeographique("cellule", editing.id));
        // Quartier (cellule) : combobox a selection stricte sur les quartiers
        // deja crees par l'administrateur.
        if (kind === "cellule" && quartiers.length) {
            attacherComboboxId(form, "quartierTexte", "quartierId", () => quartiers.map(q => ({ id: q.id, texte: libelleQuartier(q) })));
        }
        // Contact responsable (cellule + section) : recherche parmi les membres
        // existants (nom ou telephone). Une selection remplit Prenom/Nom en
        // lecture seule ; un numero libre reste accepte (le contact n'est pas
        // necessairement deja un membre du systeme).
        if (kind === "cellule" || kind === "section") {
            const cleContact = kind === "cellule" ? "contactResponsable" : "contactResponsableSection";
            const contactInput = form.querySelector(`[name="${cleContact}"]`);
            const respPrenom = form.querySelector("#resp-prenom");
            const respNom = form.querySelector("#resp-nom");
            const liste = contactInput.parentElement.querySelector(".combobox__liste");
            const fermer = () => { liste.hidden = true; };
            const appliquerMembre = (membre) => {
                respPrenom.value = membre ? membre.prenom : "";
                respNom.value = membre ? membre.nom : "";
            };
            const matchExact = () => membresAll.find(m => m.telephone === contactInput.value.trim());
            const dessiner = () => {
                const q = cleNom(contactInput.value || "");
                const correspondances = q
                    ? membresAll.filter(m => cleNom(nomComplet(m)).includes(q) || (m.telephone || "").includes(contactInput.value.trim())).slice(0, 30)
                    : [];
                liste.innerHTML = correspondances.length
                    ? correspondances.map(m => `<button type="button" class="combobox__item" data-id="${m.id}">${escapeHtml(nomComplet(m))} — ${escapeHtml(m.telephone || "—")}</button>`).join("")
                    : (q ? `<p class="combobox__vide">Aucun membre correspondant — le contact sera enregistre tel quel.</p>` : "");
                liste.hidden = !correspondances.length;
                liste.querySelectorAll(".combobox__item").forEach(btn => btn.addEventListener("mousedown", (e) => {
                    e.preventDefault();
                    const membre = membresAll.find(m => m.id === Number(btn.dataset.id));
                    contactInput.value = membre.telephone || "";
                    appliquerMembre(membre);
                    fermer();
                }));
            };
            contactInput.addEventListener("input", () => { dessiner(); appliquerMembre(matchExact()); });
            contactInput.addEventListener("focus", dessiner);
            contactInput.addEventListener("blur", () => { setTimeout(fermer, 120); appliquerMembre(matchExact()); });
            contactInput.addEventListener("keydown", (e) => {
                if (e.key === "Escape")
                    fermer();
                else if (e.key === "Enter" && !liste.hidden) {
                    const premier = liste.querySelector(".combobox__item");
                    if (premier) {
                        e.preventDefault();
                        premier.dispatchEvent(new MouseEvent("mousedown"));
                    }
                }
            });
        }
        // Localisation : bascule National/Etranger + comboboxes en cascade
        // Departement->Commune (ou Pays->Localite). Le departement/pays choisi
        // determine la liste d'options du champ commune/localite ; changer de
        // zone ou de departement/pays vide le champ suivant (une commune de
        // l'ancienne liste n'a pas de raison d'etre valide dans la nouvelle).
        if (kind === "membre") {
            const zoneSelect = form.querySelector('[name="zoneElectorale"]');
            const depInput = form.querySelector('[name="departement"]');
            const comInput = form.querySelector('[name="commune"]');
            const depLabel = form.querySelector('[data-field="departement"] span');
            const comLabel = form.querySelector('[data-field="commune"] span');
            let comCombobox;
            const depCombobox = attacherCombobox(form, "departement", () => departementsElectoraux(bureauxElectoraux, zoneSelect.value));
            comCombobox = attacherCombobox(form, "commune", () => communesElectorales(bureauxElectoraux, zoneSelect.value, depInput.value));
            depInput.addEventListener("change", () => {
                comInput.value = "";
                comCombobox.rafraichir();
            });
            // Commune de vote / Lieu de vote / Bureau de vote : en cascade,
            // sourcees de la MEME carte electorale importee (zone identique a
            // la residence). Independantes du Departement/Commune de residence
            // choisis ci-dessus : un membre peut resider dans une commune et
            // voter dans une autre (c'est justement le cas "Hors zone").
            const communeVoteInput = form.querySelector('[name="communeVote"]');
            const lieuVoteInput = form.querySelector('[name="lieuVote"]');
            const bureauVoteInput = form.querySelector('[name="bureauVote"]');
            let lieuVoteCombobox, bureauVoteCombobox;
            const communeVoteCombobox = attacherCombobox(form, "communeVote", () => toutesCommunesElectorales(bureauxElectoraux, zoneSelect.value));
            lieuVoteCombobox = attacherCombobox(form, "lieuVote", () => lieuxDeVoteElectoraux(bureauxElectoraux, zoneSelect.value, communeVoteInput.value));
            bureauVoteCombobox = attacherCombobox(form, "bureauVote", () => bureauxDuLieuVote(bureauxElectoraux, zoneSelect.value, communeVoteInput.value, lieuVoteInput.value));
            communeVoteInput.addEventListener("change", () => {
                lieuVoteInput.value = "";
                bureauVoteInput.value = "";
                lieuVoteCombobox.rafraichir();
                bureauVoteCombobox.rafraichir();
            });
            lieuVoteInput.addEventListener("change", () => {
                bureauVoteInput.value = "";
                bureauVoteCombobox.rafraichir();
            });
            const syncZone = (interactif) => {
                const estEtranger = zoneSelect.value === "Etranger";
                depLabel.textContent = (estEtranger ? "Pays" : "Département") + " *";
                comLabel.textContent = (estEtranger ? "Localité" : "Commune") + " *";
                if (interactif) {
                    depInput.value = "";
                    comInput.value = "";
                    communeVoteInput.value = "";
                    lieuVoteInput.value = "";
                    bureauVoteInput.value = "";
                }
                depCombobox.rafraichir();
                comCombobox.rafraichir();
                communeVoteCombobox.rafraichir();
                lieuVoteCombobox.rafraichir();
                bureauVoteCombobox.rafraichir();
            };
            zoneSelect.addEventListener("change", () => syncZone(true));
            syncZone(false);
        }
        let pendingPhoto = editing?.photoDataUrl;
        // Etiquettes des mouvements affilies : ajout par la liste ou par saisie
        // libre, retrait au clic sur la croix.
        let mouvementsChoisis = Array.isArray(editing?.mouvements) ? editing.mouvements.slice() : [];
        const zoneChips = form.querySelector("#chips-mouvements");
        if (zoneChips) {
            const saisie = form.querySelector("#chips-saisie-mouvements");
            const redessinerChips = () => {
                zoneChips.innerHTML = mouvementsChoisis.length
                    ? mouvementsChoisis.map(chipHtml).join("")
                    : `<span class="chips-vide">Aucun mouvement affilie.</span>`;
                zoneChips.querySelectorAll(".chip__x").forEach(b => b.addEventListener("click", () => {
                    mouvementsChoisis = mouvementsChoisis.filter(v => v !== b.parentElement.dataset.valeur);
                    redessinerChips();
                }));
            };
            const ajouter = () => {
                const valeur = saisie.value.trim();
                if (!valeur)
                    return;
                if (mouvementsChoisis.some(v => cleNom(v) === cleNom(valeur))) {
                    toast("Ce mouvement est deja associe a ce membre.", "info");
                    return;
                }
                mouvementsChoisis.push(valeur);
                saisie.value = "";
                redessinerChips();
            };
            form.querySelector("#chips-ajouter-mouvements").addEventListener("click", ajouter);
            saisie.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    ajouter();
                }
            });
            redessinerChips();
        }
        if (kind === "membre") {
            const photoInput = $("#photo-input");
            const majApercuPhoto = () => {
                $("#photo-apercu").innerHTML = avatarHtml(pendingPhoto, editing ? nomComplet(editing) : "?", "lg");
            };
            // Le champ fichier est masque : il n'est declenche que par le
            // bouton, pour qu'un clic ailleurs dans le formulaire n'ouvre
            // jamais la fenetre de selection de fichier.
            $("#photo-choisir").addEventListener("click", () => photoInput.click());
            photoInput.addEventListener("change", async () => {
                const file = photoInput.files?.[0];
                photoInput.value = "";
                if (!file)
                    return;
                try {
                    const recadree = await ouvrirRecadragePhoto(await fichierEnDataUrl(file));
                    if (recadree) {
                        pendingPhoto = recadree;
                        majApercuPhoto();
                    }
                }
                catch {
                    toast("Impossible de lire cette image.", "error");
                }
            });
            $("#photo-recadrer").addEventListener("click", async () => {
                if (!pendingPhoto) {
                    toast("Choisissez d'abord une photo.", "info");
                    return;
                }
                const recadree = await ouvrirRecadragePhoto(pendingPhoto);
                if (recadree) {
                    pendingPhoto = recadree;
                    majApercuPhoto();
                }
            });
            $("#photo-retirer").addEventListener("click", () => {
                pendingPhoto = "";
                majApercuPhoto();
            });
            // Mise en forme automatique des champs "digits" (numero d'electeur,
            // bureau de vote, annee d'adhesion) : chiffres uniquement.
            form.querySelectorAll("input[data-mask]").forEach(inp => {
                inp.addEventListener("input", () => {
                    const digits = inp.value.replace(/\D/g, "");
                    const max = inp.maxLength > 0 ? inp.maxLength : digits.length;
                    inp.value = digits.slice(0, max);
                });
            });
            // N° carte membre : visible/obligatoire uniquement si Carte membre = Oui.
            const carteMembreSelect = form.querySelector('[name="carteMembre"]');
            const numeroCarteMembreField = form.querySelector('[data-field="numeroCarteMembre"]');
            if (carteMembreSelect && numeroCarteMembreField) {
                const numeroCarteMembreInput = numeroCarteMembreField.querySelector("input");
                const syncCarteMembre = () => {
                    const visible = carteMembreSelect.value === "Oui";
                    numeroCarteMembreField.style.display = visible ? "" : "none";
                    numeroCarteMembreInput.required = visible;
                    if (!visible)
                        numeroCarteMembreInput.value = "";
                };
                carteMembreSelect.addEventListener("change", syncCarteMembre);
                syncCarteMembre();
            }
            // Commune de vote, N° electeur, Lieu de vote, Bureau de vote : visibles
            // et obligatoires uniquement si Electeur = Oui.
            const electeurSelect = form.querySelector('[name="electeur"]');
            const champsElectoraux = ["communeVote", "numeroElecteur", "lieuVote", "bureauVote"]
                .map(key => form.querySelector(`[data-field="${key}"]`))
                .filter((el) => !!el);
            if (electeurSelect && champsElectoraux.length) {
                const syncElecteur = () => {
                    const visible = electeurSelect.value === "Oui";
                    champsElectoraux.forEach(field => {
                        field.style.display = visible ? "" : "none";
                        const control = field.querySelector("input, select");
                        control.required = visible;
                        if (!visible)
                            control.value = "";
                    });
                };
                electeurSelect.addEventListener("change", syncElecteur);
                syncElecteur();
            }
            // Annee d'adhesion : renseignee automatiquement (annee en cours,
            // champ verrouille) si Adhesion = Nouveau ; saisie libre si
            // Adhesion = Ancien. Au passage de "Nouveau" a "Ancien", la valeur
            // automatique est effacee pour que l'annee reelle soit saisie.
            // A la simple ouverture d'une fiche existante, aucune valeur n'est
            // ecrasee : seule une action de l'utilisateur la modifie.
            const adhesionSelect = form.querySelector('[name="adhesion"]');
            const dateAdhesionInput = form.querySelector('[name="dateAdhesion"]');
            if (adhesionSelect && dateAdhesionInput) {
                const appliquerAdhesion = (interactif) => {
                    if (adhesionSelect.value === "Nouveau") {
                        if (interactif || !dateAdhesionInput.value)
                            dateAdhesionInput.value = String(new Date().getFullYear());
                        dateAdhesionInput.readOnly = true;
                    }
                    else {
                        if (interactif)
                            dateAdhesionInput.value = "";
                        dateAdhesionInput.readOnly = false;
                    }
                };
                adhesionSelect.addEventListener("change", () => {
                    appliquerAdhesion(true);
                    if (adhesionSelect.value !== "Nouveau")
                        dateAdhesionInput.focus();
                });
                appliquerAdhesion(false);
            }
        }
        // Un membre ne peut pas occuper deux postes du bureau a la fois : des
        // qu'il est choisi sur un poste, il devient indisponible dans les autres
        // selects tant qu'il n'est pas retire de ce poste.
        if (kind === "cellule" || kind === "section") {
            const bureauSelects = bureauRoles
                .map(r => form.querySelector(`[name="${r.key}"]`))
                .filter((s) => !!s);
            if (bureauSelects.length) {
                const syncBureauExclusivite = () => {
                    const valeursChoisies = bureauSelects.map(s => s.value).filter(Boolean);
                    bureauSelects.forEach(s => {
                        Array.from(s.options).forEach(opt => {
                            if (!opt.value)
                                return;
                            opt.disabled = valeursChoisies.includes(opt.value) && opt.value !== s.value;
                        });
                    });
                };
                bureauSelects.forEach(s => s.addEventListener("change", syncBureauExclusivite));
                syncBureauExclusivite();
            }
        }
        // La validation est prise en charge ici plutot que par le navigateur :
        // un champ obligatoire temporairement masque (N° de carte, champs
        // electoraux) bloquerait sinon l'enregistrement SANS aucun message,
        // le navigateur ne pouvant pas donner le focus a un champ invisible.
        form.noValidate = true;
        function premierChampInvalide() {
            for (const control of Array.from(form.elements)) {
                if (!control.name || !control.willValidate || control.disabled)
                    continue;
                if (!control.checkValidity())
                    return control;
            }
            return null;
        }
        form.onsubmit = async (e) => {
            e.preventDefault();
            const invalide = premierChampInvalide();
            if (invalide) {
                const conteneur = invalide.closest("[data-field]") || invalide.closest(".field");
                if (conteneur) {
                    conteneur.style.display = "";
                    conteneur.scrollIntoView({ behavior: "smooth", block: "center" });
                }
                invalide.classList.add("field-highlight");
                setTimeout(() => invalide.classList.remove("field-highlight"), 3000);
                const libelle = conteneur?.querySelector("span")?.textContent?.replace(/\s*\*$/, "") || invalide.name;
                toast(invalide.validationMessage
                    ? `${libelle} : ${invalide.validationMessage}`
                    : `Champ a corriger : ${libelle}`, "error");
                invalide.focus({ preventScroll: true });
                return;
            }
            const fd = new FormData(form);
            const payload = {};
            for (const f of fields) {
                if (f.type === "mouvements")
                    continue; // valeur multiple, geree hors FormData
                payload[f.key] = String(fd.get(f.key) || "").trim();
            }
            if (kind === "membre") {
                payload.celluleId = fd.get("celluleId") ? Number(fd.get("celluleId")) : undefined;
                payload.sectionId = fd.get("sectionId") ? Number(fd.get("sectionId")) : undefined;
                payload.photoDataUrl = pendingPhoto;
                payload.mouvements = mouvementsChoisis;
                // Localisation et situation electorale : hors FIELD_DEFS
                // (comboboxes bespoke), mais bien presentes dans le formulaire
                // (FormData les recupere normalement).
                payload.zoneElectorale = String(fd.get("zoneElectorale") || "National");
                payload.departement = String(fd.get("departement") || "").trim();
                payload.commune = String(fd.get("commune") || "").trim();
                payload.communeVote = String(fd.get("communeVote") || "").trim();
                payload.lieuVote = String(fd.get("lieuVote") || "").trim();
                payload.bureauVote = String(fd.get("bureauVote") || "").trim();
            }
            if (kind === "cellule") {
                payload.sectionId = fd.get("sectionId") ? Number(fd.get("sectionId")) : undefined;
                payload.quartierId = fd.get("quartierId") ? Number(fd.get("quartierId")) : undefined;
            }
            // Contact responsable : hors FIELD_DEFS (bloc bespoke avec recherche
            // de membre), mais bien present dans le formulaire.
            if (kind === "cellule")
                payload.contactResponsable = String(fd.get("contactResponsable") || "").trim();
            if (kind === "section")
                payload.contactResponsableSection = String(fd.get("contactResponsableSection") || "").trim();
            if (kind === "cellule" || kind === "section") {
                for (const r of bureauRoles)
                    payload[r.key] = fd.get(r.key) ? Number(fd.get(r.key)) : undefined;
            }
            if (editing) {
                // Verification de doublon en excluant l'enregistrement courant
                let dup = false;
                if (kind === "membre")
                    dup = await membreEstDoublon(payload.numeroElecteur, payload.numeroCarteMembre, editing.id);
                if (kind === "cellule")
                    dup = await celluleEstDoublon(payload.responsableCelluleId, payload.tresorierGeneralId, payload.secretaireGeneralId, editing.id);
                if (kind === "section")
                    dup = await sectionEstDoublon(payload.responsableSectionId, payload.tresorierGeneralId, payload.secretaireGeneralId, editing.id);
                if (dup) {
                    toast("Doublon detecte avec un autre enregistrement existant.", "error");
                    return;
                }
                // La reference du membre est recalculee globalement apres
                // l'enregistrement (son rang depend de sa cellule).
                if (kind === "cellule" || kind === "section") {
                    const check = await bureauEstValide(kind, editing.id, bureauRoles, payload);
                    if (!check.ok) {
                        toast(check.message, "error");
                        return;
                    }
                }
                await tableFor(kind).update(editing.id, { ...payload, updatedAt: new Date().toISOString() });
                // Les references sont renumerotees globalement : celle d'une
                // structure depend de son nom, celle d'un membre de sa cellule.
                if (kind === "cellule" || kind === "section")
                    await synchroniserReferences();
                else
                    await resynchroniserReferencesMembres();
                toast("Modifications enregistrees.", "success");
            }
            else {
                let result;
                if (kind === "membre")
                    result = await ajouterMembre(payload);
                else if (kind === "cellule")
                    result = await ajouterCellule(payload);
                else
                    result = await ajouterSection(payload);
                toast(result.message, result.ok ? "success" : "error");
                if (!result.ok)
                    return;
            }
            closeForm();
            renderView();
        };
    }
    function closeForm() {
        $("#modal-backdrop").classList.remove("modal-backdrop--show");
    }
}
// ------------------------------------------------------------------------
// 11. GESTION DES UTILISATEURS (admin principal uniquement)
// ------------------------------------------------------------------------
function moduleCheckboxesHtml(selected) {
  return MODULE_TREE.map(m => {
    const children = m.children ? `
      <div class="module-children">
        ${m.children.map(c => `
          <label class="module-check module-check--child">
            <input type="checkbox" name="module" value="${c.id}" data-parent="${m.id}" ${selected.includes(c.id) ? "checked" : ""}>
            <span>${escapeHtml(c.label)}</span>
          </label>`).join("")}
      </div>` : "";
    return `
      <label class="module-check">
        <input type="checkbox" name="module" value="${m.id}" data-module-parent ${selected.includes(m.id) ? "checked" : ""}>
        <span>${escapeHtml(m.label)}</span>
      </label>
      ${children}`;
  }).join("");
}

async function renderUsersView(container) {
  const session = getSession();
  if (!can(session.role, "manageUsers")) {
    container.innerHTML = emptyState("Acces reserve a l'administrateur principal.");
    return;
  }
  const users = await db.users.toArray();

  // Protection du compte : un utilisateur ne peut pas agir sur son propre
  // compte (evite un auto-blocage), et le(s) compte(s) "Administrateur
  // principal" ne sont jamais modifiables/desactivables/supprimables depuis
  // cette liste, quel que soit l'utilisateur connecte.
  const estSoiMeme = (u) => u.id === session.userId;
  const estProtege = (u) => u.role === "admin_principal" && !estSoiMeme(u);

  container.innerHTML = `
    <div class="view-banner view-banner--red">
      <div class="view-banner__eyebrow">Acces et securite</div>
      <h2 class="view-banner__title">Gestion des utilisateurs</h2>
      <p class="view-banner__subtitle">Comptes, roles et permissions de l'application.</p>
    </div>
    <div class="toolbar">
      ${can(session.role, "manageStructure") ? `<div class="btn-group">
        <button class="btn btn--ghost" id="verifier-localisations-utilisateurs">&#128506; Fiches a verifier (localisation)</button>
        <button class="btn btn--ghost" id="verifier-quartiers-utilisateurs">&#127961; Cellules a verifier (quartier)</button>
      </div>` : `<div></div>`}
      <button class="btn btn--primary" id="add-user-btn">+ Nouveau compte</button>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th></th><th>Identifiant</th><th>Role</th><th>Statut</th><th>Modules</th><th>Derniere connexion</th><th></th></tr></thead>
        <tbody id="users-tbody"></tbody>
      </table>
    </div>
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal modal--wide">
        <div class="modal__header"><h3 id="user-modal-title">Nouveau compte utilisateur</h3><button class="modal__close" id="modal-close">&times;</button></div>
        <form id="user-form" class="entity-form">
          <div class="field field--photo">
            <span>Photo de connexion</span>
            <div class="photo-picker">
              <div id="user-photo-apercu">${avatarHtml(undefined, "?", "lg")}</div>
              <div class="photo-actions">
                <button type="button" class="btn btn--ghost btn--xs" id="user-photo-choisir">&#128247; Choisir une photo</button>
                <button type="button" class="btn btn--ghost btn--xs" id="user-photo-recadrer">&#9986; Recadrer</button>
                <button type="button" class="btn btn--ghost btn--xs" id="user-photo-retirer">&#128465; Retirer</button>
              </div>
              <input type="file" accept="image/*" id="user-photo-input" hidden>
            </div>
          </div>
          <label class="field"><span>Identifiant</span><input type="text" name="identifiant" required></label>
          <label class="field"><span>Mot de passe</span><input type="password" name="motDePasse" minlength="4"></label>
          <label class="field"><span>Role</span>
            <select name="role">
              <option value="utilisateur">Utilisateur</option>
              <option value="admin_secondaire">Administrateur</option>
              <option value="admin_principal">Administrateur principal</option>
            </select>
          </label>
          <p class="form-note field--full" id="user-password-hint" style="display:none;">Laisser le mot de passe vide pour ne pas le modifier.</p>
          <div class="field field--full">
            <span>Modules autorises</span>
            <p class="form-note">Coche les modules (et sous-modules) que ce compte peut voir et utiliser.</p>
            <div class="module-tree" id="module-tree">${moduleCheckboxesHtml(modulesParDefaut("utilisateur"))}</div>
          </div>
          <div class="modal__actions">
            <button type="button" class="btn btn--ghost" id="cancel-user-btn">Annuler</button>
            <button type="submit" class="btn btn--primary" id="user-submit-btn">Creer le compte</button>
          </div>
        </form>
      </div>
    </div>
  `;

  const backdrop = $("#modal-backdrop");
  const form = $("#user-form");
  const modalTitle = $("#user-modal-title");
  const submitBtn = $("#user-submit-btn");
  const passwordInput = form.querySelector('[name="motDePasse"]');
  const passwordHint = $("#user-password-hint");
  const roleSelect = form.querySelector('[name="role"]');
  const moduleTreeEl = $("#module-tree");
  let editingUserId = null;
  let pendingUserPhoto;

  function fermerFormulaire() {
    backdrop.classList.remove("modal-backdrop--show");
    form.reset();
    editingUserId = null;
    pendingUserPhoto = undefined;
    $("#user-photo-apercu").innerHTML = avatarHtml(undefined, "?", "lg");
  }

  // Coche/decoche les cases enfants d'un module quand on (de)coche le
  // module parent, et coche automatiquement le parent des qu'un de ses
  // sous-modules est coche.
  moduleTreeEl.addEventListener("change", (e) => {
    const input = e.target;
    if (!input || input.name !== "module") return;
    if (input.hasAttribute("data-module-parent")) {
      if (!input.checked) {
        moduleTreeEl.querySelectorAll(`[data-parent="${input.value}"]`).forEach(c => { c.checked = false; });
      }
    } else if (input.checked) {
      const parentId = input.dataset.parent;
      const parentInput = moduleTreeEl.querySelector(`[value="${parentId}"][data-module-parent]`);
      if (parentInput) parentInput.checked = true;
    }
  });

  roleSelect.addEventListener("change", () => {
    // A la creation d'un compte, les modules par defaut suivent le role
    // choisi tant que l'administrateur n'a pas ouvert la fiche d'un compte
    // existant (en modification, on ne touche jamais aux modules deja
    // affectes sans action explicite).
    if (editingUserId === null) {
      moduleTreeEl.innerHTML = moduleCheckboxesHtml(modulesParDefaut(roleSelect.value));
    }
  });

  function ouvrirFormulaireUtilisateur(id) {
    const u = id ? users.find(x => x.id === id) : undefined;
    editingUserId = u ? u.id : null;
    pendingUserPhoto = undefined;
    modalTitle.textContent = u ? `Modifier le compte — ${u.identifiant}` : "Nouveau compte utilisateur";
    submitBtn.textContent = u ? "Enregistrer" : "Creer le compte";
    (form.elements.namedItem("identifiant")).value = u?.identifiant || "";
    (form.elements.namedItem("role")).value = u?.role || "utilisateur";
    passwordInput.value = "";
    passwordInput.required = !u;
    passwordHint.style.display = u ? "block" : "none";
    moduleTreeEl.innerHTML = moduleCheckboxesHtml(u ? modulesEffectifs(u) : modulesParDefaut("utilisateur"));
    // La photo existante devient la valeur de travail : elle peut etre
    // recadree telle quelle, sans avoir a la choisir de nouveau.
    pendingUserPhoto = u?.photoDataUrl;
    $("#user-photo-apercu").innerHTML = avatarHtml(u?.photoDataUrl, u?.identifiant || "?", "lg");
    backdrop.classList.add("modal-backdrop--show");
  }


  function draw() {
    $("#users-tbody").innerHTML = users.map(u => {
      const protege = estProtege(u);
      const soiMeme = estSoiMeme(u);
      const actions = protege
        ? `<span class="badge badge--muted" title="Compte administrateur principal protege">Protege</span>`
        : `
          ${!soiMeme ? `<button class="icon-btn" data-toggle="${u.id}" title="${u.actif ? "Desactiver" : "Activer"}">${u.actif ? "&#9881;" : "&#9889;"}</button>` : ""}
          <button class="icon-btn" data-edit-user="${u.id}" title="Modifier${soiMeme ? " mon compte" : ""}">&#9998;</button>
          <button class="icon-btn" data-reset-user="${u.id}" title="Reinitialiser les acces (modules) selon le role">&#8635;</button>
          ${!soiMeme ? `<button class="icon-btn icon-btn--danger" data-delete-user="${u.id}" title="Supprimer">&#128465;</button>` : ""}
        `;
      const nbModules = modulesEffectifs(u).filter(id => !id.includes(".")).length;
      const nbModulesTotal = MODULE_TREE.length;
      const modulesTitle = MODULE_TREE.filter(m => modulesEffectifs(u).includes(m.id)).map(m => m.label).join(", ") || "Aucun";
      return `
    <tr>
      <td>${avatarHtml(u.photoDataUrl, u.identifiant, "sm")}</td>
      <td>${escapeHtml(u.identifiant)}</td>
      <td>${ROLE_LABELS[u.role]}</td>
      <td>${u.actif ? '<span class="badge badge--success">Actif</span>' : '<span class="badge badge--muted">Desactive</span>'}</td>
      <td><span class="badge" title="${escapeHtml(modulesTitle)}">${nbModules}/${nbModulesTotal} modules</span></td>
      <td>${u.derniereConnexion ? formatDate(u.derniereConnexion) : "—"}</td>
      <td class="row-actions">${actions}</td>
    </tr>`;
    }).join("");

    $("#users-tbody").querySelectorAll("[data-toggle]").forEach(b => {
      b.addEventListener("click", async () => {
        const id = Number(b.dataset.toggle);
        const u = users.find(x => x.id === id);
        await db.users.update(id, { actif: !u.actif });
        toast(`Compte ${u.actif ? "desactive" : "active"}.`, "success");
        renderView();
      });
    });
    $("#users-tbody").querySelectorAll("[data-edit-user]").forEach(b => {
      b.addEventListener("click", () => ouvrirFormulaireUtilisateur(Number(b.dataset.editUser)));
    });
    $("#users-tbody").querySelectorAll("[data-reset-user]").forEach(b => {
      b.addEventListener("click", async () => {
        const id = Number(b.dataset.resetUser);
        const u = users.find(x => x.id === id);
        if (!confirm(`Reinitialiser les acces (modules) de "${u.identifiant}" a la configuration par defaut de son role ?`)) return;
        await db.users.update(id, { modules: modulesParDefaut(u.role) });
        toast("Acces reinitialises.", "success");
        if (id === session.userId) renderShell(); else renderView();
      });
    });
    $("#users-tbody").querySelectorAll("[data-delete-user]").forEach(b => {
      b.addEventListener("click", async () => {
        const id = Number(b.dataset.deleteUser);
        const u = users.find(x => x.id === id);
        if (!confirm(`Confirmer la suppression du compte "${u.identifiant}" ?`)) return;
        await db.users.delete(id);
        toast("Compte supprime.", "success");
        renderView();
      });
    });
  }
  draw();

  $("#add-user-btn").addEventListener("click", () => ouvrirFormulaireUtilisateur());
  document.getElementById("verifier-localisations-utilisateurs")?.addEventListener("click", () => ouvrirVerificationLocalisations());
  document.getElementById("verifier-quartiers-utilisateurs")?.addEventListener("click", () => ouvrirVerificationQuartiers());
  $("#modal-close").addEventListener("click", fermerFormulaire);
  $("#cancel-user-btn").addEventListener("click", fermerFormulaire);

  // Photo de connexion : selection par bouton (le champ fichier est masque)
  // puis recadrage carre, comme pour la photo d'un membre.
  const userPhotoInput = $("#user-photo-input");
  const majApercuUserPhoto = () => {
    $("#user-photo-apercu").innerHTML = avatarHtml(pendingUserPhoto, "?", "lg");
  };
  $("#user-photo-choisir").addEventListener("click", () => userPhotoInput.click());
  userPhotoInput.addEventListener("change", async () => {
    const file = userPhotoInput.files?.[0];
    userPhotoInput.value = "";
    if (!file) return;
    try {
      const recadree = await ouvrirRecadragePhoto(await fichierEnDataUrl(file));
      if (recadree) { pendingUserPhoto = recadree; majApercuUserPhoto(); }
    } catch { toast("Impossible de lire cette image.", "error"); }
  });
  $("#user-photo-recadrer").addEventListener("click", async () => {
    if (!pendingUserPhoto) { toast("Choisissez d'abord une photo.", "info"); return; }
    const recadree = await ouvrirRecadragePhoto(pendingUserPhoto);
    if (recadree) { pendingUserPhoto = recadree; majApercuUserPhoto(); }
  });
  $("#user-photo-retirer").addEventListener("click", () => { pendingUserPhoto = ""; majApercuUserPhoto(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const identifiant = String(fd.get("identifiant")).trim();
    const motDePasse = String(fd.get("motDePasse") || "");
    const role = fd.get("role");
    const modules = Array.from(moduleTreeEl.querySelectorAll('input[name="module"]:checked')).map(c => c.value);

    const existing = await db.users.where("identifiant").equals(identifiant).first();
    if (existing && existing.id !== editingUserId) { toast("Cet identifiant existe deja.", "error"); return; }

    if (editingUserId) {
      const patch = { identifiant, role, modules };
      if (pendingUserPhoto !== undefined) patch.photoDataUrl = pendingUserPhoto;
      if (motDePasse) patch.motDePasse = motDePasse;
      await db.users.update(editingUserId, patch);
      toast("Compte modifie avec succes.", "success");
    } else {
      if (!motDePasse) { toast("Le mot de passe est obligatoire pour un nouveau compte.", "error"); return; }
      await db.users.add({
        identifiant, motDePasse, role, actif: true,
        photoDataUrl: pendingUserPhoto, createdAt: new Date().toISOString(), modules,
      });
      toast("Compte cree avec succes.", "success");
    }
    const idEnCoursEdition = editingUserId;
    fermerFormulaire();
    if (idEnCoursEdition === session.userId) renderShell(); else renderView();
  });
}
// ------------------------------------------------------------------------
// 12. MODALE GENERIQUE ET EXPORTS (CSV / PDF)
// ------------------------------------------------------------------------
// Modale creee a la volee (et detruite a la fermeture), utilisee par la
// cartographie, la recherche geographique et les listes exportables. Elle
// s'ouvre par-dessus l'ecran courant sans le perturber : l'ecran d'origine
// reste intact et se retrouve tel quel a la fermeture.
function ouvrirModale({ titre, contenuHtml, taille = "wide", flush = false, onMonte, onFerme }) {
    const backdrop = el("div", { className: `modal-backdrop modal-backdrop--show${taille === "plein" ? " modal-backdrop--plein" : ""}` });
    backdrop.innerHTML = `
    <div class="modal modal--${taille}">
      <div class="modal__header">
        <h3>${escapeHtml(titre)}</h3>
        <button type="button" class="modal__close" title="Fermer">&times;</button>
      </div>
      <div class="modal__content${flush ? " modal__content--flush" : ""}">${contenuHtml}</div>
    </div>`;
    document.body.appendChild(backdrop);
    let ferme = false;
    const fermer = () => {
        if (ferme)
            return;
        ferme = true;
        document.removeEventListener("keydown", surEchap);
        try {
            onFerme?.();
        }
        finally {
            backdrop.remove();
        }
    };
    const surEchap = (e) => { if (e.key === "Escape") fermer(); };
    document.addEventListener("keydown", surEchap);
    backdrop.querySelector(".modal__close").addEventListener("click", fermer);
    backdrop.addEventListener("mousedown", (e) => { if (e.target === backdrop) fermer(); });
    onMonte?.(backdrop.querySelector(".modal__content"), fermer);
    return fermer;
}
// Exporte un tableau (en-tete + lignes) au format CSV telechargeable.
function exporterCSV(nomFichier, entetes, lignes) {
    telechargerFichierTexte(nomFichier, toCSV([entetes, ...lignes]));
    toast("Export CSV genere.", "success");
}
// Ouvre une fenetre d'impression prete a etre enregistree en PDF
// ("Destination : Enregistrer au format PDF" / "Microsoft Print to PDF").
// Cette approche fonctionne hors ligne et sans bibliotheque supplementaire.
function exporterPDF(titre, corpsHtml, orientation = "portrait") {
    const fenetre = window.open("", "_blank");
    if (!fenetre) {
        toast("Le navigateur a bloque la fenetre d'export. Autorisez les fenetres surgissantes pour ce site.", "error");
        return;
    }
    const doc = `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><title>${escapeHtml(titre)}</title>
<style>
  @page { size: A4 ${orientation}; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", Arial, Helvetica, sans-serif; color: #1E293B; margin: 0; font-size: 12px; }
  .pdf-entete { display: flex; align-items: center; gap: 14px; border-bottom: 3px solid #006725; padding-bottom: 10px; margin-bottom: 14px; }
  .pdf-entete img { height: 54px; width: auto; }
  .pdf-entete h1 { margin: 0; font-size: 17px; color: #006725; }
  .pdf-entete p { margin: 3px 0 0; font-size: 11px; color: #64748B; }
  .pdf-meta { margin-left: auto; text-align: right; font-size: 10px; color: #64748B; }
  h2 { font-size: 13px; color: #9F1A16; margin: 16px 0 6px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  th, td { border: 1px solid #CBD5E1; padding: 5px 7px; text-align: left; vertical-align: top; }
  th { background: #006725; color: #fff; font-size: 10.5px; text-transform: uppercase; letter-spacing: .02em; }
  tbody tr:nth-child(even) { background: #F1F5F9; }
  .pdf-resume { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
  .pdf-tuile { border: 1px solid #CBD5E1; border-radius: 6px; padding: 7px 12px; min-width: 110px; }
  .pdf-tuile b { display: block; font-size: 16px; color: #006725; }
  .pdf-tuile span { font-size: 10px; color: #64748B; text-transform: uppercase; }
  .pdf-carte { border: 1px solid #CBD5E1; border-radius: 6px; padding: 8px; margin-bottom: 14px; page-break-inside: avoid; }
  .pdf-carte svg { width: 100%; height: auto; display: block; }
  .pdf-pied { margin-top: 14px; border-top: 1px solid #CBD5E1; padding-top: 6px; font-size: 9.5px; color: #64748B; }
  tr, .pdf-carte { page-break-inside: avoid; }
  thead { display: table-header-group; }
</style></head>
<body>
  <div class="pdf-entete">
    <img src="data:image/png;base64,${PASTEF_LOGO_B64}" alt="Logo">
    <div>
      <h1>${escapeHtml(titre)}</h1>
      <p>SGBD Mory &middot; Systeme de gestion des membres, cellules et sections</p>
    </div>
    <div class="pdf-meta">Edite le ${formatDate(new Date().toISOString())}</div>
  </div>
  ${corpsHtml}
  <div class="pdf-pied">Document genere automatiquement par SGBD Mory.</div>
  <script>window.onload = function () { window.focus(); window.print(); };<\/script>
</body></html>`;
    fenetre.document.open();
    fenetre.document.write(doc);
    fenetre.document.close();
}
// Construit un tableau HTML simple pour les documents PDF.
function tableauPDF(entetes, lignes) {
    if (!lignes.length)
        return `<p>Aucune donnee a afficher.</p>`;
    return `<table>
    <thead><tr>${entetes.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
    <tbody>${lignes.map(l => `<tr>${l.map(c => `<td>${escapeHtml(String(c ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody>
  </table>`;
}
// ------------------------------------------------------------------------
// 13. CARTE STATIQUE (SVG) POUR LES EXPORTS PDF
//
// Les tuiles des fonds de carte ne peuvent pas etre reprises telles quelles
// dans un document imprime (chargement asynchrone, restrictions d'origine).
// Les exports PDF embarquent donc un plan vectoriel des geometries — trace
// fidele, net a l'impression et disponible hors ligne.
// ------------------------------------------------------------------------
function carteSvgStatique(entrees, options = {}) {
    const largeur = options.largeur || 960;
    const hauteur = options.hauteur || 540;
    const marge = 18;
    const utiles = entrees.filter(e => polygonesDeGeometrie(e.geometry).length);
    if (!utiles.length)
        return "";
    let latMin = 90, latMax = -90, lngMin = 180, lngMax = -180;
    for (const e of utiles) {
        const emprise = empriseGeometrie(e.geometry);
        latMin = Math.min(latMin, emprise[0][0]);
        lngMin = Math.min(lngMin, emprise[0][1]);
        latMax = Math.max(latMax, emprise[1][0]);
        lngMax = Math.max(lngMax, emprise[1][1]);
    }
    // Projection equirectangulaire corrigee : les longitudes sont ecrasees
    // par le cosinus de la latitude moyenne pour conserver les proportions.
    const latMoy = (latMin + latMax) / 2;
    const kx = Math.cos(latMoy * Math.PI / 180) || 1;
    const largeurGeo = Math.max((lngMax - lngMin) * kx, 1e-9);
    const hauteurGeo = Math.max(latMax - latMin, 1e-9);
    const echelle = Math.min((largeur - 2 * marge) / largeurGeo, (hauteur - 2 * marge) / hauteurGeo);
    const decalageX = (largeur - largeurGeo * echelle) / 2;
    const decalageY = (hauteur - hauteurGeo * echelle) / 2;
    const projeter = ([lng, lat]) => [
        decalageX + (lng - lngMin) * kx * echelle,
        decalageY + (latMax - lat) * echelle,
    ];
    const chemins = [];
    const etiquettes = [];
    for (const e of utiles) {
        for (const polygone of polygonesDeGeometrie(e.geometry)) {
            const d = polygone.map(anneau => "M " + anneau.map(p => projeter(p).map(v => v.toFixed(1)).join(" ")).join(" L ") + " Z").join(" ");
            chemins.push(`<path d="${d}" fill="${e.remplissage || "none"}" fill-opacity="${e.opacite ?? 0.25}" stroke="${e.couleur || "#1E293B"}" stroke-width="${e.epaisseur || 1.6}" stroke-linejoin="round" fill-rule="evenodd"/>`);
        }
        if (e.label) {
            const centre = centreGeometrie(e.geometry);
            if (centre) {
                const [x, y] = projeter([centre[1], centre[0]]);
                etiquettes.push(`<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="#0F172A" stroke="#fff" stroke-width="3" paint-order="stroke">${escapeHtml(e.label)}</text>`);
            }
        }
    }
    // Echelle graphique : longueur d'un segment "rond" en metres.
    const metresParPixel = distanceMetres([latMoy, lngMin], [latMoy, lngMax]) / (largeurGeo * echelle);
    const cibleM = metresParPixel * 140;
    const paliers = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
    const palier = paliers.find(p => p >= cibleM) || paliers[paliers.length - 1];
    const longueurPx = palier / metresParPixel;
    const barre = `
    <g transform="translate(${marge}, ${hauteur - marge})">
      <rect x="0" y="-10" width="${longueurPx.toFixed(1)}" height="5" fill="#0F172A"/>
      <text x="0" y="-14" font-size="10" fill="#0F172A">${palier >= 1000 ? (palier / 1000) + " km" : palier + " m"}</text>
      <text x="${(longueurPx + 10).toFixed(1)}" y="-10" font-size="9" fill="#64748B">Nord &#8593;</text>
    </g>`;
    return `<svg viewBox="0 0 ${largeur} ${hauteur}" xmlns="http://www.w3.org/2000/svg" role="img">
    <rect width="${largeur}" height="${hauteur}" fill="#F8FAFC" stroke="#CBD5E1"/>
    ${chemins.join("")}${etiquettes.join("")}${barre}
  </svg>`;
}
// Bloc "carte + legende" insere dans les documents PDF.
function blocCartePDF(titre, entrees, legende = []) {
    const svg = carteSvgStatique(entrees);
    if (!svg)
        return `<p><i>Aucune geometrie disponible : la carte ne peut pas etre representee.</i></p>`;
    const legendeHtml = legende.length ? `<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:10px;">
      ${legende.map(l => `<span><span style="display:inline-block;width:14px;height:9px;background:${l.remplissage};border:2px solid ${l.couleur};margin-right:5px;"></span>${escapeHtml(l.label)}</span>`).join("")}
    </div>` : "";
    return `<div class="pdf-carte"><div style="font-size:11px;font-weight:700;color:#006725;margin-bottom:6px;">${escapeHtml(titre)}</div>${svg}${legendeHtml}</div>`;
}
// ------------------------------------------------------------------------
// 14. MOTEUR CARTOGRAPHIQUE (Leaflet)
//
// Une seule et meme carte alimente : le module Cartographie, la recherche
// geographique (bouton present sur chaque membre / cellule / section) et
// l'editeur de geometrie des cellules.
// ------------------------------------------------------------------------
// Centre par defaut : commune de Tivaouane Peulh / Niaga (departement de
// Rufisque), zone couverte par l'organisation.
const CARTO_CENTRE_DEFAUT = [14.8262, -17.1908];
const CARTO_ZOOM_DEFAUT = 13;
const CARTO_COULEURS = {
    cellule: "#9F1A16",
    cible: "#F59E0B",
    section: "#006725",
    mesure: "#0EA5E9",
    dessin: "#7C3AED",
};
// Niveaux affichables sur la carte. Les trois derniers proviennent de
// geometries importees par l'administrateur ("Charger une couche").
const NIVEAUX_CARTO = [
    { id: "departement", label: "Departements", couleur: "#6D28D9", administratif: true },
    { id: "commune", label: "Communes", couleur: "#B45309", administratif: true },
    { id: "section", label: "Sections", couleur: "#006725" },
    { id: "cellule", label: "Cellules", couleur: "#9F1A16" },
];
function cartoDisponible() {
    return typeof L !== "undefined" && !!L.map;
}
// Symbologie par defaut d'une couche administrative. Chaque niveau peut la
// redefinir (table stylesCouches) : trait, fond, transparence, etiquettes.
const STYLE_COUCHE_DEFAUT = {
    epaisseur: 2.5,
    tirets: true,
    remplissage: false,
    opacite: 0.18,
    etiquettes: true,
    tailleEtiquette: 11,
};
function styleCouche(donnees, niveau) {
    const couleur = NIVEAUX_CARTO.find(n => n.id === niveau)?.couleur || "#6D28D9";
    const enregistre = (donnees.styles || []).find(s => s.niveau === niveau) || {};
    return { ...STYLE_COUCHE_DEFAUT, couleur, couleurFond: couleur, ...enregistre };
}
// Niveau de detail affiche selon le zoom, lorsque l'agregation automatique
// est active : plus on zoome, plus le decoupage affiche est fin, et les
// totaux suivent le niveau affiche.
const SEUILS_ZOOM_NIVEAU = {
    departement: 12,
    commune: 13,
    section: 14,
    cellule: Infinity,
};
// Niveaux reellement exploitables : les niveaux administratifs sans donnee
// importee sont ignores.
function niveauxDisponibles(donnees) {
    const dispo = ["departement", "commune"]
        .filter(n => (donnees.couches || []).some(c => c.niveau === n));
    return [...dispo, "section", "cellule"];
}
function niveauPourZoom(donnees, zoom) {
    const dispo = niveauxDisponibles(donnees);
    return dispo.find(n => zoom <= SEUILS_ZOOM_NIVEAU[n]) || dispo[dispo.length - 1];
}
async function chargerDonneesCarto() {
    const [membres, cellules, sections, couches, styles] = await Promise.all([
        db.membres.toArray(), db.cellules.toArray(), db.sections.toArray(),
        db.couches.toArray(), db.stylesCouches.toArray(),
    ]);
    return { membres, cellules, sections, couches, styles };
}
// Correlation automatique des couches importees avec les donnees de terrain :
// chaque cellule (via le centre de son polygone) est rattachee a l'entite
// administrative qui la contient, puis les effectifs sont cumules. C'est ce
// qui permet d'afficher des totaux par departement ou commune sans aucune
// saisie supplementaire.
function correlerCouches(donnees) {
    const agregats = new Map();
    const centres = new Map();
    for (const c of donnees.cellules) {
        if (aUneGeometrie(c)) {
            const centre = centreGeometrie(c.geometry);
            if (centre)
                centres.set(c.id, [centre[1], centre[0]]); // [lng, lat]
        }
    }
    for (const couche of donnees.couches || []) {
        const cellulesDedans = donnees.cellules.filter(c => {
            const p = centres.get(c.id);
            return p && pointDansGeometrie(p, couche.geometry);
        });
        const ids = new Set(cellulesDedans.map(c => c.id));
        const membres = donnees.membres.filter(m => ids.has(m.celluleId));
        agregats.set(couche.id, {
            cellules: cellulesDedans.length,
            sections: new Set(cellulesDedans.map(c => c.sectionId).filter(Boolean)).size,
            membres: membres.length,
            cartes: membres.filter(aCarteMembre).length,
            superficie: aireGeometrie(couche.geometry),
        });
    }
    return agregats;
}
// Fonds de carte proposes dans le selecteur de calques.
function fondsDeCarte() {
    const esri = (service, attribution) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 19, attribution });
    return {
        "Satellite (Esri)": esri("World_Imagery", "Imagerie &copy; Esri, Maxar, Earthstar Geographics"),
        "Plan OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }),
        "Routier (Esri)": esri("World_Street_Map", "&copy; Esri"),
        "Relief (Esri)": esri("World_Topo_Map", "&copy; Esri"),
        "Fond clair (Carto)": L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png", { maxZoom: 19, subdomains: "abcd", attribution: "&copy; OpenStreetMap, &copy; CARTO" }),
        "Fond sombre (Carto)": L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", { maxZoom: 19, subdomains: "abcd", attribution: "&copy; OpenStreetMap, &copy; CARTO" }),
        "Sans fond (geometrie seule)": L.layerGroup(),
    };
}
// Etiquette flottante (nom d'une cellule / section) posee au centre d'un
// polygone. La boite de l'icone est de taille nulle : c'est le span interne
// qui se recentre lui-meme sur le point d'ancrage.
function etiquetteCarto(centre, texte, variante = "", styleInline = "") {
    return L.marker(centre, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
            className: "carto-etiquette",
            iconSize: [0, 0],
            html: `<span class="carto-etiquette__texte ${variante}" ${styleInline ? `style="${styleInline}"` : ""}>${escapeHtml(texte)}</span>`,
        }),
    });
}
// Cree la carte, ses fonds, ses controles et ses couches thematiques.
function creerCarteSGBD(host, donnees, options = {}) {
    const map = L.map(host, {
        center: options.centre || CARTO_CENTRE_DEFAUT,
        zoom: options.zoom || CARTO_ZOOM_DEFAUT,
        zoomControl: true,
        attributionControl: true,
    });
    const fonds = fondsDeCarte();
    const premier = Object.keys(fonds)[options.fondParDefaut ?? 1];
    fonds[premier].addTo(map);
    const calquesSupplementaires = {
        "Etiquettes &amp; lieux (Esri)": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "&copy; Esri" }),
    };
    L.control.layers(fonds, calquesSupplementaires, { position: "topright", collapsed: true }).addTo(map);
    L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);
    // Un groupe par niveau : chaque groupe porte a la fois les geometries et
    // les etiquettes du niveau, pour pouvoir l'afficher ou le masquer d'un
    // seul geste (cellules, sections, departements, communes).
    const groupes = {};
    for (const n of NIVEAUX_CARTO)
        groupes[n.id] = L.layerGroup();
    const ctx = {
        map,
        host,
        donnees,
        options,
        mode: "navigation", // navigation | mesure | dessin
        selection: null, // { kind, id }
        index: { cellule: new Map(), section: new Map() },
        groupes,
        afficherEtiquettes: true,
        afficherAgregats: true,
        // Agregation automatique au zoom : un seul niveau de decoupage est
        // affiche a la fois, du departement jusqu'a la cellule. Desactivee par
        // defaut (les modules qui la veulent l'activent explicitement).
        agregationAuto: !!options.agregationAuto,
        niveauAffiche: null,
        agregats: new Map(),
        etiquettesPosees: [],
        // Alias conserves pour les modules qui manipulent directement ces deux
        // couches (recherche geographique, analyse spatiale, editeur).
        coucheSections: groupes.section,
        coucheCellules: groupes.cellule,
        coucheFlash: L.layerGroup().addTo(map),
        coucheMesure: L.layerGroup().addTo(map),
        mesure: { type: null, points: [] },
        ecouteurs: {},
    };
    // Les cellules et les sections sont affichees d'emblee ; les couches
    // administratives importees le sont si elles contiennent des donnees.
    groupes.section.addTo(map);
    groupes.cellule.addTo(map);
    for (const niveau of ["departement", "commune"]) {
        if ((donnees.couches || []).some(c => c.niveau === niveau))
            groupes[niveau].addTo(map);
    }
    map.on("zoomend", () => appliquerNiveauZoom(ctx));
    map.on("zoomend moveend", () => desencombrerEtiquettes(ctx));
    // Barre d'etat : coordonnees du curseur et niveau de zoom.
    const statut = el("div", { className: "carte-statusbar" });
    host.appendChild(statut);
    const majStatut = (latlng) => {
        statut.textContent = latlng
            ? `Lat ${latlng.lat.toFixed(5)} · Lon ${latlng.lng.toFixed(5)} · zoom ${map.getZoom()}`
            : `zoom ${map.getZoom()}`;
    };
    majStatut(null);
    map.on("mousemove", (e) => majStatut(e.latlng));
    map.on("zoomend", () => majStatut(null));
    // Bandeau d'aide contextuelle (mesure / dessin).
    ctx.aide = el("div", { className: "carte-aide" });
    ctx.aide.style.display = "none";
    host.appendChild(ctx.aide);
    ctx.afficherAide = (texte) => {
        ctx.aide.textContent = texte || "";
        ctx.aide.style.display = texte ? "" : "none";
    };
    map.on("click", (e) => {
        if (ctx.mode === "mesure")
            ajouterPointMesure(ctx, e.latlng);
        else if (ctx.mode === "dessin")
            ctx.onClicDessin?.(e.latlng);
    });
    dessinerCouchesCarto(ctx);
    appliquerNiveauZoom(ctx);
    // La carte est souvent montee dans une fenetre qui vient de s'ouvrir :
    // on force le recalcul de sa taille une fois la mise en page stabilisee.
    setTimeout(() => map.invalidateSize(), 60);
    setTimeout(() => map.invalidateSize(), 320);
    return ctx;
}
// Style applique a une cellule (couleur d'accentuation si elle est
// selectionnee par une recherche geographique).
// ctx.styleThematique permet a un module (analyse spatiale) d'imposer son
// propre remplissage : la surbrillance de selection reste prioritaire sur
// le contour, afin qu'une recherche reste lisible sur une carte thematique.
function styleCellule(ctx, cellule) {
    const active = ctx.selection && ctx.selection.kind === "cellule" && ctx.selection.id === cellule.id;
    const theme = ctx.styleThematique?.("cellule", cellule);
    if (theme) {
        return Object.assign({ color: "#FFFFFF", weight: 1.2, opacity: 1, fillOpacity: 0.85 }, theme, active ? { color: CARTO_COULEURS.cible, weight: 4 } : {});
    }
    return {
        color: active ? CARTO_COULEURS.cible : CARTO_COULEURS.cellule,
        weight: active ? 5 : 2,
        opacity: 1,
        fillColor: active ? CARTO_COULEURS.cible : CARTO_COULEURS.cellule,
        fillOpacity: active ? 0.42 : 0.18,
    };
}
function styleSection(ctx, section) {
    const active = ctx.selection && ctx.selection.kind === "section" && ctx.selection.id === section.id;
    const theme = ctx.styleThematique?.("section", section);
    if (theme) {
        return Object.assign({ color: "#FFFFFF", weight: 1.6, opacity: 1, fillOpacity: 0.85, dashArray: null }, theme, active ? { color: CARTO_COULEURS.cible, weight: 4 } : {});
    }
    return {
        color: active ? CARTO_COULEURS.cible : CARTO_COULEURS.section,
        weight: active ? 6 : 4,
        opacity: 1,
        dashArray: active ? null : "7 5",
        fillColor: CARTO_COULEURS.section,
        fillOpacity: active ? 0.2 : 0.05,
    };
}
// (Re)construit toutes les couches thematiques a partir de ctx.donnees.
// Les etiquettes portent la REFERENCE des cellules et des sections (le nom
// n'est pas unique) et le nom des entites administratives importees.
function dessinerCouchesCarto(ctx) {
    const { cellules, sections, membres, couches } = ctx.donnees;
    NIVEAUX_CARTO.forEach(n => ctx.groupes[n.id].clearLayers());
    ctx.index = { cellule: new Map(), section: new Map() };
    ctx.etiquettesPosees = [];
    ctx.agregats = correlerCouches(ctx.donnees);
    // Pastille de totaux posee sous l'etiquette d'une entite, quel que soit
    // son niveau : c'est elle qui rend la lecture "sommee" a chaque echelle.
    const poserTotaux = (centre, texte, niveau, titre) => {
        if (!ctx.afficherAgregats || !texte)
            return;
        L.marker(centre, {
            interactive: false, keyboard: false,
            icon: L.divIcon({
                className: "carto-etiquette", iconSize: [0, 0],
                html: `<span class="carto-compteur${niveau === "cellule" ? "" : " carto-compteur--agrege"}" title="${escapeHtml(titre)}">${escapeHtml(texte)}</span>`,
            }),
        }).addTo(ctx.groupes[niveau]);
    };
    // L'ordre de declaration fixe la priorite d'affichage des etiquettes en
    // cas de chevauchement : les entites les plus larges d'abord.
    const poserEtiquette = (centre, texte, variante, niveau, styleInline = "") => {
        if (!ctx.afficherEtiquettes)
            return;
        const marqueur = etiquetteCarto(centre, texte, variante, styleInline);
        marqueur.addTo(ctx.groupes[niveau]);
        ctx.etiquettesPosees.push({ marqueur, texte });
    };
    // --- Couches administratives importees (departement, commune) :
    // symbologie personnalisable, et totaux correles issus des cellules
    // qu'elles contiennent.
    for (const niveau of ["departement", "commune"]) {
        const style = styleCouche(ctx.donnees, niveau);
        for (const entree of (couches || []).filter(c => c.niveau === niveau)) {
            if (!polygonesDeGeometrie(entree.geometry).length)
                continue;
            const couche = L.geoJSON(entree.geometry, {
                bubblingMouseEvents: false,
                style: {
                    color: style.couleur,
                    weight: style.epaisseur,
                    opacity: 0.95,
                    dashArray: style.tirets ? "5 4" : null,
                    fill: !!style.remplissage,
                    fillColor: style.couleurFond,
                    fillOpacity: style.remplissage ? style.opacite : 0,
                },
            });
            couche.on("click", (e) => gererClicCouche(ctx, e, entree, niveau));
            const centre = centreGeometrie(entree.geometry);
            attacherInfobulleCentree(couche, centre, () => texteSurvolCouche(ctx, entree, niveau));
            couche.addTo(ctx.groupes[niveau]);
            if (!centre)
                continue;
            if (style.etiquettes)
                poserEtiquette(centre, entree.nom, `carto-etiquette__texte--${niveau}`, niveau, `font-size:${style.tailleEtiquette}px;background:${style.couleur};border-color:${style.couleur};`);
            // Totaux correles, affiches sous l'etiquette.
            const stats = ctx.agregats.get(entree.id);
            if (stats && (stats.membres || stats.cellules))
                poserTotaux(centre, `${stats.membres} membre${stats.membres > 1 ? "s" : ""} · ${stats.cellules} cellule${stats.cellules > 1 ? "s" : ""}`, niveau, entree.nom);
        }
    }
    // --- Sections : geometrie recalculee par regroupement des cellules -----
    for (const section of sections) {
        const geometry = geometrieSection(section, cellules);
        if (!geometry)
            continue;
        // bubblingMouseEvents:false — le clic ne doit pas etre rejoue par la
        // carte : gererClicEntite() le transmet lui-meme a l'outil actif.
        const couche = L.geoJSON(geometry, { style: () => styleSection(ctx, section), bubblingMouseEvents: false });
        couche.on("click", (e) => gererClicEntite(ctx, e, "section", section));
        const centre = centreGeometrie(geometry);
        attacherInfobulleCentree(couche, centre, () => texteSurvolCarto(ctx, "section", section));
        couche.addTo(ctx.groupes.section);
        ctx.index.section.set(section.id, { geometry, couche, entite: section });
        if (centre) {
            poserEtiquette(centre, section.reference, "carto-etiquette__texte--section", "section");
            const nb = membres.filter(m => m.sectionId === section.id).length;
            const nbCellules = cellules.filter(c => c.sectionId === section.id).length;
            poserTotaux(centre, `${nb} membre${nb > 1 ? "s" : ""} · ${nbCellules} cellule${nbCellules > 1 ? "s" : ""}`, "section", section.nom);
        }
    }
    // --- Cellules ----------------------------------------------------------
    for (const cellule of cellules) {
        if (!aUneGeometrie(cellule))
            continue;
        const couche = L.geoJSON(cellule.geometry, { style: () => styleCellule(ctx, cellule), bubblingMouseEvents: false });
        couche.on("click", (e) => gererClicEntite(ctx, e, "cellule", cellule));
        const centre = centreGeometrie(cellule.geometry);
        attacherInfobulleCentree(couche, centre, () => texteSurvolCarto(ctx, "cellule", cellule));
        couche.addTo(ctx.groupes.cellule);
        ctx.index.cellule.set(cellule.id, { geometry: cellule.geometry, couche, entite: cellule });
        if (centre) {
            poserEtiquette(centre, cellule.reference, "", "cellule");
            const nbMembres = membres.filter(m => m.celluleId === cellule.id).length;
            const nbCartes = membres.filter(m => m.celluleId === cellule.id && aCarteMembre(m)).length;
            poserTotaux(centre, `${nbMembres} membre${nbMembres > 1 ? "s" : ""} · ${nbCartes} carte${nbCartes > 1 ? "s" : ""}`, "cellule", cellule.nom);
        }
    }
    desencombrerEtiquettes(ctx);
}
// Infobulle de survol d'une entite administrative : ses totaux correles.
function texteSurvolCouche(ctx, entree, niveau) {
    const s = ctx.agregats?.get(entree.id);
    const libelle = NIVEAUX_CARTO.find(n => n.id === niveau)?.label.replace(/s$/, "") || niveau;
    if (!s)
        return `<b>${escapeHtml(entree.nom)}</b><br>${escapeHtml(libelle)}`;
    return `<b>${escapeHtml(entree.nom)}</b> <i>(${escapeHtml(libelle.toLowerCase())})</i><br>
          ${s.membres} membre(s) · ${s.cartes} carte(s)<br>
          ${s.cellules} cellule(s) · ${s.sections} section(s)`;
}
// Clic sur une entite administrative : recapitulatif des donnees de terrain
// qu'elle contient. En mode mesure ou dessin, le clic est transmis a l'outil.
function gererClicCouche(ctx, e, entree, niveau) {
    if (ctx.mode === "mesure") {
        ajouterPointMesure(ctx, e.latlng);
        return;
    }
    if (ctx.mode === "dessin") {
        ctx.onClicDessin?.(e.latlng);
        return;
    }
    const s = ctx.agregats?.get(entree.id) || { membres: 0, cartes: 0, cellules: 0, sections: 0, superficie: 0 };
    const libelle = NIVEAUX_CARTO.find(n => n.id === niveau)?.label.replace(/s$/, "") || niveau;
    const ligne = (l, v) => `<div class="popup-ligne"><span>${escapeHtml(l)}</span><span>${escapeHtml(String(v))}</span></div>`;
    L.popup({ maxWidth: 320 }).setLatLng(e.latlng).setContent(`
    <div class="popup-titre">${escapeHtml(entree.nom)}</div>
    ${ligne("Niveau", libelle)}
    ${ligne("Membres", s.membres)}
    ${ligne("Cartes de membre", s.cartes)}
    ${ligne("Cellules", s.cellules)}
    ${ligne("Sections representees", s.sections)}
    ${ligne("Superficie", formatSuperficie(s.superficie))}
    ${ligne("Densite", s.superficie ? `${(s.membres / (s.superficie / 1e6)).toFixed(1)} membre(s)/km²` : "—")}
    <p class="carte-note">Totaux calcules automatiquement a partir des cellules situees dans cette emprise.</p>`).openOn(ctx.map);
}
// Applique le niveau de detail correspondant au zoom courant : un seul niveau
// est affiche a la fois, et ses totaux sont ceux de son propre decoupage.
function appliquerNiveauZoom(ctx) {
    if (!ctx.agregationAuto)
        return;
    const niveau = niveauPourZoom(ctx.donnees, ctx.map.getZoom());
    if (niveau === ctx.niveauAffiche)
        return;
    ctx.niveauAffiche = niveau;
    for (const n of NIVEAUX_CARTO) {
        const groupe = ctx.groupes[n.id];
        if (n.id === niveau)
            groupe.addTo(ctx.map);
        else
            ctx.map.removeLayer(groupe);
    }
    desencombrerEtiquettes(ctx);
    ctx.onNiveauChange?.(niveau);
}
// Branche les cases a cocher de calques d'un panneau lateral : une par niveau
// (via l'attribut data-niveau), plus les etiquettes et les effectifs.
function brancherCalquesCarto(ctx, racine, selecteurEtiquettes, selecteurMembres) {
    racine.querySelectorAll("[data-niveau]").forEach(input => {
        input.addEventListener("change", () => {
            const groupe = ctx.groupes[input.dataset.niveau];
            if (input.checked)
                groupe.addTo(ctx.map);
            else
                ctx.map.removeLayer(groupe);
            desencombrerEtiquettes(ctx);
        });
    });
    const etiquettes = racine.querySelector(selecteurEtiquettes);
    etiquettes?.addEventListener("change", () => {
        ctx.afficherEtiquettes = etiquettes.checked;
        dessinerCouchesCarto(ctx);
    });
    // Totaux : une pastille chiffree sous chaque entite, a tous les niveaux.
    const totaux = racine.querySelector(selecteurMembres);
    totaux?.addEventListener("change", () => {
        ctx.afficherAgregats = totaux.checked;
        dessinerCouchesCarto(ctx);
    });
}
// Masque les etiquettes qui se chevauchent ou sortent du cadre : seules les
// premieres posees (entites les plus larges) restent visibles. Recalcule a
// chaque deplacement et a chaque zoom, de sorte que le detail apparait au fur
// et a mesure qu'on zoome.
function desencombrerEtiquettes(ctx) {
    if (!ctx.etiquettesPosees?.length)
        return;
    const taille = ctx.map.getSize();
    const boites = [];
    const chevauche = (a, b) => !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);
    for (const { marqueur, texte } of ctx.etiquettesPosees) {
        const noeud = marqueur.getElement();
        if (!noeud)
            continue;
        const p = ctx.map.latLngToContainerPoint(marqueur.getLatLng());
        const largeur = 14 + texte.length * 6.4;
        const boite = { x1: p.x - largeur / 2, y1: p.y - 10, x2: p.x + largeur / 2, y2: p.y + 10 };
        const dehors = boite.x2 < 0 || boite.y2 < 0 || boite.x1 > taille.x || boite.y1 > taille.y;
        if (dehors || boites.some(b => chevauche(boite, b))) {
            noeud.style.visibility = "hidden";
        }
        else {
            noeud.style.visibility = "";
            boites.push(boite);
        }
    }
}
// Attache une infobulle de survol ancree au CENTRE de la geometrie (calcule
// par centreGeometrie, le meme point que celui des etiquettes et du
// scintillement) plutot que suivie au curseur ("sticky"). Une infobulle
// sticky se positionne exactement sous le pointeur : en survolant pres du
// bord d'un polygone — ce qui arrive des qu'on l'approche depuis
// l'exterieur — elle apparait sur la limite au lieu de rester a l'interieur.
// L'ancrage fixe evite ce defaut, quelle que soit la forme du polygone.
function attacherInfobulleCentree(couche, centre, contenuFn) {
    if (!centre)
        return;
    couche.bindTooltip(contenuFn, { sticky: false, direction: "center", opacity: 0.96, className: "carte-tooltip" });
    couche.on("tooltipopen", (e) => e.tooltip.setLatLng(centre));
}
// Texte de l'infobulle de survol. Un module peut le remplacer
// (ctx.texteSurvol) pour y afficher son indicateur courant ; la valeur reste
// toujours lisible autrement (infobulle de clic et tableau).
function texteSurvolCarto(ctx, kind, entite) {
    const personnalise = ctx.texteSurvol?.(kind, entite);
    if (personnalise)
        return personnalise;
    const nb = kind === "cellule"
        ? ctx.donnees.membres.filter(m => m.celluleId === entite.id).length
        : ctx.donnees.membres.filter(m => m.sectionId === entite.id).length;
    return `<b>${escapeHtml(entite.nom)}</b><br>${nb} membre${nb > 1 ? "s" : ""}`;
}
// Rafraichit uniquement les styles (apres un changement de selection).
function rafraichirStylesCarto(ctx) {
    ctx.index.cellule.forEach((entree) => entree.couche.setStyle(styleCellule(ctx, entree.entite)));
    ctx.index.section.forEach((entree) => entree.couche.setStyle(styleSection(ctx, entree.entite)));
}
// Recharge les donnees depuis la base et redessine tout.
async function rechargerCarto(ctx) {
    ctx.donnees = await chargerDonneesCarto();
    dessinerCouchesCarto(ctx);
    ctx.onDonneesRechargees?.();
}
// Clic sur une geometrie : en navigation, la fiche resumee de l'entite
// s'ouvre dans une infobulle ; en mesure ou en dessin, le point est capte
// par l'outil actif (le clic ne doit pas etre absorbe par le polygone).
function gererClicEntite(ctx, e, kind, entite) {
    if (ctx.mode === "mesure") {
        ajouterPointMesure(ctx, e.latlng);
        return;
    }
    if (ctx.mode === "dessin") {
        ctx.onClicDessin?.(e.latlng);
        return;
    }
    ctx.selection = { kind, id: entite.id };
    rafraichirStylesCarto(ctx);
    const geometry = kind === "cellule" ? entite.geometry : geometrieSection(entite, ctx.donnees.cellules);
    L.popup({ maxWidth: 320 })
        .setLatLng(e.latlng)
        .setContent(contenuInfobulle(ctx, kind, entite, geometry))
        .openOn(ctx.map);
    ctx.onSelection?.(kind, entite);
}
// Contenu de l'infobulle : informations de la cellule (ou de la section) en
// lecture seule. Seule la GEOMETRIE est modifiable depuis la carte ; les
// informations rattachees restent gerees dans leur module d'origine.
function contenuInfobulle(ctx, kind, entite, geometry) {
    const { membres, cellules, sections } = ctx.donnees;
    const noeud = el("div");
    const ligne = (label, valeur) => `<div class="popup-ligne"><span>${escapeHtml(label)}</span><span>${escapeHtml(String(valeur ?? "—"))}</span></div>`;
    // Lignes ajoutees par le module appelant (ex. indicateur de l'analyse
    // spatiale), inserees avant les mesures de la geometrie.
    const supplement = ctx.lignesInfobulle?.(kind, entite) || "";
    const peutEditer = can(getSession().role, "manageStructure");
    if (kind === "cellule") {
        const section = sections.find(s => s.id === entite.sectionId);
        const nbMembres = membres.filter(m => m.celluleId === entite.id).length;
        noeud.innerHTML = `
      <div class="popup-titre">${escapeHtml(entite.nom)}</div>
      ${ligne("Reference", entite.reference)}
      ${ligne("N°", entite.numero)}
      ${ligne("Section", section?.nom || "—")}
      ${ligne("Contact responsable", entite.contactResponsable || "—")}
      ${ligne("Membres rattaches", nbMembres)}
      ${supplement}
      ${ligne("Superficie", formatSuperficie(aireGeometrie(geometry)))}
      ${ligne("Perimetre", formatDistance(perimetreGeometrie(geometry)))}
      <div class="popup-actions">
        <button type="button" class="btn btn--ghost btn--xs" data-membres>&#128100; Membres</button>
        ${peutEditer ? `<button type="button" class="btn btn--primary btn--xs" data-geometrie>&#9998; Geometrie</button>` : ""}
      </div>
      <p class="carte-note">Les informations de la cellule ne sont pas modifiables depuis la carte : seule sa geometrie l'est.</p>`;
        noeud.querySelector("[data-membres]").addEventListener("click", () => ouvrirListeMembresCellule(entite.id));
        noeud.querySelector("[data-geometrie]")?.addEventListener("click", () => {
            ctx.map.closePopup();
            ouvrirEditeurGeometrieCellule(entite.id, async () => { await rechargerCarto(ctx); });
        });
    }
    else {
        const cellulesSection = cellules.filter(c => c.sectionId === entite.id);
        const nbMembres = membres.filter(m => m.sectionId === entite.id).length;
        noeud.innerHTML = `
      <div class="popup-titre">${escapeHtml(entite.nom)}</div>
      ${ligne("Reference", entite.reference)}
      ${ligne("N°", entite.numero)}
      ${ligne("Cellules regroupees", cellulesSection.length)}
      ${ligne("dont avec geometrie", cellulesSection.filter(aUneGeometrie).length)}
      ${ligne("Membres rattaches", nbMembres)}
      ${supplement}
      ${ligne("Superficie", formatSuperficie(aireGeometrie(geometry)))}
      <div class="popup-actions">
        <button type="button" class="btn btn--ghost btn--xs" data-cellules>&#127961; Cellules</button>
      </div>
      <p class="carte-note">Geometrie calculee automatiquement en regroupant les cellules de cette section.</p>`;
        noeud.querySelector("[data-cellules]").addEventListener("click", () => ouvrirListeCellulesSection(entite.id));
    }
    return noeud;
}
// Recentre la carte sur une entite, la met en surbrillance et declenche le
// scintillement au centre de son polygone.
function localiserSurCarte(ctx, kind, id) {
    const entree = ctx.index[kind]?.get(id);
    if (!entree)
        return false;
    ctx.selection = { kind, id };
    rafraichirStylesCarto(ctx);
    const emprise = empriseGeometrie(entree.geometry);
    if (emprise)
        ctx.map.fitBounds(L.latLngBounds(emprise), { padding: [50, 50], maxZoom: 17 });
    entree.couche.bringToFront();
    const centre = centreGeometrie(entree.geometry);
    if (centre)
        clignoterSurCarte(ctx, centre);
    return true;
}
// Scintillement (onde + coeur clignotant) pose au centre du polygone
// recherche, afin de reperer immediatement l'entite sur la carte.
function clignoterSurCarte(ctx, centre) {
    ctx.coucheFlash.clearLayers();
    L.marker(centre, {
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000,
        icon: L.divIcon({
            className: "carto-flash",
            iconSize: [0, 0],
            html: `<span class="carto-flash__onde"></span><span class="carto-flash__coeur"></span>`,
        }),
    }).addTo(ctx.coucheFlash);
}
// ---------------------- Outil de mesure ---------------------------------
function activerMesure(ctx, type) {
    reinitialiserMesure(ctx);
    ctx.mesure = { type, points: [] };
    ctx.mode = type ? "mesure" : "navigation";
    ctx.afficherAide(type === "distance"
        ? "Mesure de distance : cliquez les points successifs sur la carte."
        : type === "surface"
            ? "Mesure de superficie : cliquez au moins 3 points pour fermer la surface."
            : "");
    ctx.host.style.cursor = type ? "crosshair" : "";
    ctx.onMesureMaj?.();
}
function reinitialiserMesure(ctx) {
    ctx.coucheMesure.clearLayers();
    ctx.mesure = { type: ctx.mesure?.type ?? null, points: [] };
    ctx.onMesureMaj?.();
}
function ajouterPointMesure(ctx, latlng) {
    const m = ctx.mesure;
    m.points.push([latlng.lat, latlng.lng]);
    ctx.coucheMesure.clearLayers();
    const points = m.points.map(p => L.latLng(p[0], p[1]));
    if (m.type === "surface" && points.length >= 3) {
        L.polygon(points, { color: CARTO_COULEURS.mesure, weight: 2, fillOpacity: 0.2, dashArray: "5 4" }).addTo(ctx.coucheMesure);
    }
    else if (points.length >= 2) {
        L.polyline(points, { color: CARTO_COULEURS.mesure, weight: 3, dashArray: "6 4" }).addTo(ctx.coucheMesure);
    }
    points.forEach((p, i) => L.circleMarker(p, {
        radius: 4, color: "#fff", weight: 2, fillColor: CARTO_COULEURS.mesure, fillOpacity: 1,
    }).bindTooltip(String(i + 1), { permanent: false }).addTo(ctx.coucheMesure));
    ctx.onMesureMaj?.();
}
// Resultat courant de la mesure, mis en forme pour le panneau lateral.
function resultatMesure(ctx) {
    const m = ctx.mesure;
    if (!m.type)
        return `<span class="carte-note">Choisissez un outil de mesure ci-dessus.</span>`;
    if (m.points.length < 2)
        return `<span class="carte-note">Cliquez sur la carte pour ajouter des points (${m.points.length} point${m.points.length > 1 ? "s" : ""}).</span>`;
    let longueur = 0;
    for (let i = 0; i < m.points.length - 1; i++)
        longueur += distanceMetres(m.points[i], m.points[i + 1]);
    if (m.type === "distance") {
        const direct = distanceMetres(m.points[0], m.points[m.points.length - 1]);
        return `Distance cumulee : <b>${formatDistance(longueur)}</b><br>
            Points : <b>${m.points.length}</b><br>
            Depart &rarr; arrivee (a vol d'oiseau) : <b>${formatDistance(direct)}</b>`;
    }
    if (m.points.length < 3)
        return `<span class="carte-note">Ajoutez au moins 3 points pour obtenir une superficie.</span>`;
    const anneau = [...m.points.map(p => [p[1], p[0]]), [m.points[0][1], m.points[0][0]]];
    const geom = { type: "Polygon", coordinates: [anneau] };
    return `Superficie : <b>${formatSuperficie(aireGeometrie(geom))}</b><br>
          Perimetre : <b>${formatDistance(perimetreGeometrie(geom))}</b><br>
          Sommets : <b>${m.points.length}</b>`;
}
// ------------------------------------------------------------------------
// 15. RECHERCHE GEOGRAPHIQUE (bouton present sur chaque membre / cellule /
// section). La carte s'ouvre en grande fenetre par-dessus l'ecran courant,
// zoome sur le polygone concerne, le met en surbrillance et fait scintiller
// son centre.
// ------------------------------------------------------------------------
// Determine ce qu'il faut montrer sur la carte pour une entite donnee :
// un membre est localise par sa cellule (a defaut par sa section).
function cibleGeographique(kind, id, donnees) {
    if (kind === "cellule") {
        const cellule = donnees.cellules.find(c => c.id === id);
        if (!cellule)
            return { erreur: "Cellule introuvable." };
        if (!aUneGeometrie(cellule))
            return { erreur: `Aucune geometrie n'est encore associee a la cellule "${cellule.nom}". Modifiez la cellule pour dessiner ou importer son polygone.` };
        return { kind: "cellule", id: cellule.id, titre: `Cellule ${cellule.reference}`, sousTitre: cellule.nom };
    }
    if (kind === "section") {
        const section = donnees.sections.find(s => s.id === id);
        if (!section)
            return { erreur: "Section introuvable." };
        if (!geometrieSection(section, donnees.cellules))
            return { erreur: `Aucune des cellules de la section "${section.nom}" ne possede de geometrie : la section ne peut pas encore etre localisee.` };
        return { kind: "section", id: section.id, titre: `Section ${section.reference}`, sousTitre: section.nom };
    }
    const membre = donnees.membres.find(m => m.id === id);
    if (!membre)
        return { erreur: "Membre introuvable." };
    const cellule = membre.celluleId ? donnees.cellules.find(c => c.id === membre.celluleId) : undefined;
    if (cellule && aUneGeometrie(cellule)) {
        return {
            kind: "cellule", id: cellule.id, membre,
            titre: nomComplet(membre),
            sousTitre: `Localise par sa cellule : ${cellule.nom}`,
        };
    }
    const section = membre.sectionId ? donnees.sections.find(s => s.id === membre.sectionId) : undefined;
    if (section && geometrieSection(section, donnees.cellules)) {
        return {
            kind: "section", id: section.id, membre,
            titre: nomComplet(membre),
            sousTitre: `Localise par sa section : ${section.nom} (sa cellule n'a pas encore de geometrie)`,
        };
    }
    return { erreur: `"${nomComplet(membre)}" ne peut pas etre localise : ni sa cellule ni sa section ne possedent de geometrie.` };
}
async function ouvrirRechercheGeographique(kind, id) {
    if (!cartoDisponible()) {
        toast("Moteur cartographique indisponible : une connexion Internet est necessaire au chargement de la page.", "error");
        return;
    }
    const donnees = await chargerDonneesCarto();
    const cible = cibleGeographique(kind, id, donnees);
    if (cible.erreur) {
        toast(cible.erreur, "error");
        return;
    }
    let ctx = null;
    ouvrirModale({
        titre: `Recherche geographique — ${cible.titre}`,
        taille: "plein",
        flush: true,
        contenuHtml: `
      <div class="carte-layout">
        <aside class="carte-aside">
          <div class="carte-bloc">
            <h4 class="carte-bloc__titre">Element recherche</h4>
            <div style="font-weight:800;color:var(--navy);">${escapeHtml(cible.titre)}</div>
            <p class="carte-note">${escapeHtml(cible.sousTitre)}</p>
            <div id="rg-infos" style="margin-top:8px;font-size:.82rem;"></div>
          </div>
          <div class="carte-bloc">
            <h4 class="carte-bloc__titre">Calques</h4>
            ${NIVEAUX_CARTO.map(n => `<label class="carte-check"><input type="checkbox" data-niveau="${n.id}" ${n.administratif && !(donnees.couches || []).some(c => c.niveau === n.id) ? "" : "checked"}> ${escapeHtml(n.label)}</label>`).join("")}
            <label class="carte-check"><input type="checkbox" id="rg-etiquettes" checked> Etiquettes</label>
            <label class="carte-check"><input type="checkbox" id="rg-membres" checked> Totaux (membres, cellules)</label>
            <p class="carte-note">Les fonds (satellite, plan, relief...) se choisissent depuis l'icone de calques, en haut a droite de la carte.</p>
          </div>
          <div class="carte-bloc">
            <h4 class="carte-bloc__titre">Legende</h4>
            <div class="carte-legende__item"><span class="carte-pastille" style="background:rgba(159,26,22,.18);border-color:${CARTO_COULEURS.cellule};"></span> Cellule</div>
            <div class="carte-legende__item"><span class="carte-pastille" style="background:rgba(0,103,37,.08);border-color:${CARTO_COULEURS.section};"></span> Section (regroupement)</div>
            <div class="carte-legende__item"><span class="carte-pastille" style="background:rgba(245,158,11,.42);border-color:${CARTO_COULEURS.cible};"></span> Element recherche (scintillant)</div>
          </div>
          <div class="carte-bloc">
            <h4 class="carte-bloc__titre">Actions</h4>
            <div class="carte-actions">
              <button type="button" class="btn btn--ghost btn--xs" id="rg-recentrer">&#127919; Recentrer</button>
              ${cible.kind === "cellule"
            ? `<button type="button" class="btn btn--ghost btn--xs" id="rg-membres-liste">&#128100; Membres</button>`
            : `<button type="button" class="btn btn--ghost btn--xs" id="rg-cellules-liste">&#127961; Cellules</button>`}
            </div>
          </div>
        </aside>
        <div class="carte-host" id="rg-host"></div>
      </div>`,
        onMonte: (contenu) => {
            const host = contenu.querySelector("#rg-host");
            ctx = creerCarteSGBD(host, donnees);
            brancherCalquesCarto(ctx, contenu, "#rg-etiquettes", "#rg-membres");
            const recentrer = () => {
                if (!localiserSurCarte(ctx, cible.kind, cible.id))
                    toast("Geometrie introuvable sur la carte.", "error");
            };
            contenu.querySelector("#rg-recentrer").addEventListener("click", recentrer);
            contenu.querySelector("#rg-membres-liste")?.addEventListener("click", () => ouvrirListeMembresCellule(cible.id));
            contenu.querySelector("#rg-cellules-liste")?.addEventListener("click", () => ouvrirListeCellulesSection(cible.id));
            // Recapitulatif chiffre de l'element localise.
            const entree = ctx.index[cible.kind].get(cible.id);
            const infos = contenu.querySelector("#rg-infos");
            if (entree) {
                const nb = cible.kind === "cellule"
                    ? donnees.membres.filter(m => m.celluleId === cible.id).length
                    : donnees.membres.filter(m => m.sectionId === cible.id).length;
                infos.innerHTML = `
          <div class="popup-ligne"><span>Superficie</span><span>${escapeHtml(formatSuperficie(aireGeometrie(entree.geometry)))}</span></div>
          <div class="popup-ligne"><span>Perimetre</span><span>${escapeHtml(formatDistance(perimetreGeometrie(entree.geometry)))}</span></div>
          <div class="popup-ligne"><span>Membres</span><span>${nb}</span></div>`;
            }
            setTimeout(recentrer, 220);
        },
        onFerme: () => { ctx?.map.remove(); },
    });
}
// ------------------------------------------------------------------------
// 16. EDITEUR DE GEOMETRIE D'UNE CELLULE
//
// Permet de dessiner un polygone sur la carte ou d'importer une geometrie au
// format JSON / GeoJSON. Seule la geometrie est modifiable ici : les
// informations de la cellule restent gerees depuis le module Cellules.
// La geometrie des sections en decoule automatiquement.
// ------------------------------------------------------------------------
async function ouvrirEditeurGeometrieCellule(celluleId, onEnregistre) {
    if (!cartoDisponible()) {
        toast("Moteur cartographique indisponible : une connexion Internet est necessaire au chargement de la page.", "error");
        return;
    }
    if (!can(getSession().role, "manageStructure")) {
        toast("Seul l'administrateur principal peut modifier la geometrie d'une cellule.", "error");
        return;
    }
    const donnees = await chargerDonneesCarto();
    const cellule = donnees.cellules.find(c => c.id === celluleId);
    if (!cellule) {
        toast("Cellule introuvable.", "error");
        return;
    }
    const section = donnees.sections.find(s => s.id === cellule.sectionId);
    // Anneaux exterieurs, conserves "ouverts" (sans repetition du dernier
    // point) pendant l'edition, et refermes a l'enregistrement.
    const polygonesInitiaux = polygonesDeGeometrie(cellule.geometry);
    const avaitDesTrous = polygonesInitiaux.some(p => p.length > 1);
    let anneaux = polygonesInitiaux.map(p => ouvrirAnneau(p[0]));
    let brouillon = [];
    let partieSelectionnee = null;
    let ctx = null;
    function ouvrirAnneau(anneau) {
        const pts = (anneau || []).map(p => [p[0], p[1]]);
        if (pts.length > 1) {
            const a = pts[0], b = pts[pts.length - 1];
            if (a[0] === b[0] && a[1] === b[1])
                pts.pop();
        }
        return pts;
    }
    function geometrieCourante() {
        return geometrieDepuisPolygones(anneaux
            .filter(r => r.length >= 3)
            .map(r => [[...r, r[0]]]));
    }
    ouvrirModale({
        titre: `Geometrie de la cellule — ${cellule.reference}`,
        taille: "plein",
        flush: true,
        contenuHtml: `
      <div class="carte-layout">
        <aside class="carte-aside">
          <div class="carte-bloc">
            <h4 class="carte-bloc__titre">Cellule (informations non modifiables ici)</h4>
            <div class="popup-ligne"><span>Nom</span><span>${escapeHtml(cellule.nom)}</span></div>
            <div class="popup-ligne"><span>Reference</span><span>${escapeHtml(cellule.reference)}</span></div>
            <div class="popup-ligne"><span>Section</span><span>${escapeHtml(section?.nom || "—")}</span></div>
            <div class="popup-ligne"><span>Membres</span><span>${donnees.membres.filter(m => m.celluleId === cellule.id).length}</span></div>
          </div>
          <div class="carte-bloc">
            <h4 class="carte-bloc__titre">Tracer / modifier</h4>
            <div class="carte-actions">
              <button type="button" class="btn btn--primary btn--xs" id="ge-dessiner">&#9998; Dessiner un polygone</button>
              <button type="button" class="btn btn--ghost btn--xs" id="ge-terminer" disabled>&#10003; Terminer la partie</button>
              <button type="button" class="btn btn--ghost btn--xs" id="ge-annuler-point" disabled>&#8630; Dernier point</button>
              <button type="button" class="btn btn--ghost btn--xs" id="ge-sommets">&#9673; Modifier les sommets</button>
              <button type="button" class="btn btn--ghost btn--xs" id="ge-supprimer-partie" disabled>&#128465; Partie selectionnee</button>
              <button type="button" class="btn btn--ghost btn--xs" id="ge-vider">&#10005; Tout effacer</button>
            </div>
            <p class="carte-note" id="ge-aide">Cliquez sur "Dessiner un polygone" puis sur la carte pour poser les sommets (3 minimum), et terminez la partie. Un second polygone peut etre ajoute pour une cellule en plusieurs morceaux.</p>
          </div>
          <div class="carte-bloc">
            <h4 class="carte-bloc__titre">Importer / exporter (JSON)</h4>
            <input type="file" id="ge-fichier" accept=".json,.geojson,application/json,application/geo+json" style="font-size:.8rem;width:100%;">
            <p class="carte-note">Formats acceptes : GeoJSON (FeatureCollection, Feature ou geometrie Polygon / MultiPolygon) et tableau de coordonnees [longitude, latitude].</p>
            <div class="carte-actions" style="margin-top:6px;">
              <button type="button" class="btn btn--ghost btn--xs" id="ge-exporter">&#8681; Exporter en GeoJSON</button>
            </div>
          </div>
          <div class="carte-bloc">
            <h4 class="carte-bloc__titre">Mesures de la geometrie</h4>
            <div class="carte-mesure" id="ge-stats"></div>
          </div>
          <div class="carte-bloc">
            <div class="carte-actions">
              <button type="button" class="btn btn--primary btn--block" id="ge-enregistrer">Enregistrer la geometrie</button>
              <button type="button" class="btn btn--ghost btn--block" id="ge-supprimer-geom">Supprimer la geometrie de la cellule</button>
            </div>
            <p class="carte-note">La geometrie de la section ${escapeHtml(section?.nom || "de rattachement")} sera automatiquement mise a jour.</p>
          </div>
        </aside>
        <div class="carte-host" id="ge-host"></div>
      </div>`,
        onMonte: (contenu, fermer) => {
            const host = contenu.querySelector("#ge-host");
            ctx = creerCarteSGBD(host, donnees);
            // La cellule en cours d'edition est retiree du fond commun : elle
            // est redessinee par l'editeur, en couleur d'edition.
            const entreeExistante = ctx.index.cellule.get(cellule.id);
            if (entreeExistante)
                ctx.coucheCellules.removeLayer(entreeExistante.couche);
            const coucheEdition = L.layerGroup().addTo(ctx.map);
            const coucheSommets = L.layerGroup().addTo(ctx.map);
            const btnTerminer = contenu.querySelector("#ge-terminer");
            const btnAnnulerPoint = contenu.querySelector("#ge-annuler-point");
            const btnSupprimerPartie = contenu.querySelector("#ge-supprimer-partie");
            const stats = contenu.querySelector("#ge-stats");
            const aide = contenu.querySelector("#ge-aide");
            let modeEdition = false;
            function majStats() {
                const geom = geometrieCourante();
                const sommets = anneaux.reduce((n, r) => n + r.length, 0) + brouillon.length;
                stats.innerHTML = geom
                    ? `Parties : <b>${anneaux.filter(r => r.length >= 3).length}</b><br>
             Sommets : <b>${sommets}</b><br>
             Superficie : <b>${formatSuperficie(aireGeometrie(geom))}</b><br>
             Perimetre : <b>${formatDistance(perimetreGeometrie(geom))}</b>`
                    : `<span class="carte-note">Aucune geometrie definie pour l'instant (${sommets} point${sommets > 1 ? "s" : ""} pose${sommets > 1 ? "s" : ""}).</span>`;
                btnTerminer.disabled = brouillon.length < 3;
                btnAnnulerPoint.disabled = brouillon.length === 0;
                btnSupprimerPartie.disabled = partieSelectionnee === null;
            }
            function redessiner() {
                coucheEdition.clearLayers();
                coucheSommets.clearLayers();
                anneaux.forEach((anneau, index) => {
                    if (anneau.length < 3)
                        return;
                    const polygone = L.polygon(anneau.map(p => [p[1], p[0]]), {
                        color: partieSelectionnee === index ? CARTO_COULEURS.cible : CARTO_COULEURS.dessin,
                        weight: partieSelectionnee === index ? 5 : 3,
                        fillOpacity: 0.22,
                    }).addTo(coucheEdition);
                    polygone.on("click", (e) => {
                        if (ctx.mode === "dessin")
                            return;
                        L.DomEvent.stop(e);
                        partieSelectionnee = partieSelectionnee === index ? null : index;
                        redessiner();
                        majStats();
                    });
                    if (modeEdition)
                        dessinerPoignees(anneau, index);
                });
                if (brouillon.length) {
                    const pts = brouillon.map(p => [p[1], p[0]]);
                    if (brouillon.length >= 3)
                        L.polygon(pts, { color: CARTO_COULEURS.dessin, weight: 3, dashArray: "6 4", fillOpacity: 0.12 }).addTo(coucheEdition);
                    else if (brouillon.length === 2)
                        L.polyline(pts, { color: CARTO_COULEURS.dessin, weight: 3, dashArray: "6 4" }).addTo(coucheEdition);
                    brouillon.forEach((p, i) => L.circleMarker([p[1], p[0]], {
                        radius: 5, color: "#fff", weight: 2, fillColor: CARTO_COULEURS.dessin, fillOpacity: 1,
                    }).bindTooltip(String(i + 1)).addTo(coucheEdition));
                }
            }
            // Poignees d'edition : un sommet deplacable par point, plus un
            // point intermediaire (semi-transparent) au milieu de chaque
            // segment pour inserer un nouveau sommet. Clic droit : suppression.
            function dessinerPoignees(anneau, indexAnneau) {
                anneau.forEach((point, i) => {
                    const marqueur = L.marker([point[1], point[0]], {
                        draggable: true,
                        icon: L.divIcon({ className: "carto-sommet", iconSize: [12, 12], iconAnchor: [6, 6] }),
                    }).addTo(coucheSommets);
                    marqueur.on("drag", (e) => {
                        const ll = e.target.getLatLng();
                        anneau[i] = [ll.lng, ll.lat];
                        coucheEdition.clearLayers();
                        anneaux.forEach((a, idx) => {
                            if (a.length >= 3)
                                L.polygon(a.map(p => [p[1], p[0]]), {
                                    color: idx === indexAnneau ? CARTO_COULEURS.cible : CARTO_COULEURS.dessin,
                                    weight: 3, fillOpacity: 0.22,
                                }).addTo(coucheEdition);
                        });
                    });
                    marqueur.on("dragend", () => { redessiner(); majStats(); });
                    marqueur.on("contextmenu", (e) => {
                        L.DomEvent.stopPropagation(e);
                        e.originalEvent?.preventDefault();
                        if (anneau.length <= 3) {
                            toast("Un polygone doit conserver au moins 3 sommets.", "info");
                            return;
                        }
                        anneau.splice(i, 1);
                        redessiner();
                        majStats();
                    });
                    // Point d'insertion au milieu du segment suivant.
                    const suivant = anneau[(i + 1) % anneau.length];
                    const milieu = [(point[0] + suivant[0]) / 2, (point[1] + suivant[1]) / 2];
                    L.marker([milieu[1], milieu[0]], {
                        icon: L.divIcon({ className: "carto-sommet carto-sommet--milieu", iconSize: [10, 10], iconAnchor: [5, 5] }),
                        title: "Cliquer pour inserer un sommet",
                    }).addTo(coucheSommets).on("click", (e) => {
                        L.DomEvent.stop(e);
                        anneau.splice(i + 1, 0, milieu);
                        redessiner();
                        majStats();
                    });
                });
            }
            function quitterModes() {
                ctx.mode = "navigation";
                modeEdition = false;
                ctx.afficherAide("");
                host.style.cursor = "";
                ctx.map.doubleClickZoom.enable();
            }
            ctx.onClicDessin = (latlng) => {
                brouillon.push([latlng.lng, latlng.lat]);
                redessiner();
                majStats();
            };
            contenu.querySelector("#ge-dessiner").addEventListener("click", () => {
                quitterModes();
                ctx.mode = "dessin";
                brouillon = [];
                partieSelectionnee = null;
                host.style.cursor = "crosshair";
                ctx.map.doubleClickZoom.disable();
                ctx.afficherAide("Cliquez sur la carte pour poser les sommets, puis \"Terminer la partie\".");
                aide.textContent = "Posez au moins 3 sommets puis cliquez sur \"Terminer la partie\". Le bouton \"Dernier point\" annule le dernier sommet pose.";
                redessiner();
                majStats();
            });
            btnTerminer.addEventListener("click", () => {
                if (brouillon.length < 3)
                    return;
                anneaux.push(brouillon);
                brouillon = [];
                quitterModes();
                redessiner();
                majStats();
                toast("Partie ajoutee. Enregistrez pour l'appliquer a la cellule.", "success");
            });
            btnAnnulerPoint.addEventListener("click", () => {
                brouillon.pop();
                redessiner();
                majStats();
            });
            contenu.querySelector("#ge-sommets").addEventListener("click", (e) => {
                const actif = !modeEdition;
                quitterModes();
                modeEdition = actif;
                e.currentTarget.classList.toggle("btn--active", actif);
                aide.textContent = actif
                    ? "Faites glisser les sommets pour les deplacer, cliquez un point clair pour inserer un sommet, clic droit sur un sommet pour le supprimer."
                    : "Mode navigation.";
                redessiner();
            });
            btnSupprimerPartie.addEventListener("click", () => {
                if (partieSelectionnee === null)
                    return;
                anneaux.splice(partieSelectionnee, 1);
                partieSelectionnee = null;
                redessiner();
                majStats();
            });
            contenu.querySelector("#ge-vider").addEventListener("click", () => {
                if (!confirm("Effacer tout le trace en cours ?"))
                    return;
                anneaux = [];
                brouillon = [];
                partieSelectionnee = null;
                redessiner();
                majStats();
            });
            contenu.querySelector("#ge-fichier").addEventListener("change", async (e) => {
                const fichier = e.target.files?.[0];
                if (!fichier)
                    return;
                try {
                    const geom = normaliserGeometrieImportee(JSON.parse(await fichier.text()));
                    if (!geom) {
                        toast("Aucun polygone exploitable n'a ete trouve dans ce fichier.", "error");
                        return;
                    }
                    const polygones = polygonesDeGeometrie(geom);
                    anneaux = polygones.map(p => ouvrirAnneau(p[0]));
                    brouillon = [];
                    partieSelectionnee = null;
                    quitterModes();
                    redessiner();
                    majStats();
                    const emprise = empriseGeometrie(geom);
                    if (emprise)
                        ctx.map.fitBounds(L.latLngBounds(emprise), { padding: [40, 40] });
                    if (polygones.some(p => p.length > 1))
                        toast("Geometrie importee. Les anneaux interieurs (trous) ne sont pas conserves.", "info");
                    else
                        toast(`Geometrie importee (${anneaux.length} partie(s)). Enregistrez pour l'appliquer.`, "success");
                }
                catch {
                    toast("Fichier JSON illisible.", "error");
                }
                finally {
                    e.target.value = "";
                }
            });
            contenu.querySelector("#ge-exporter").addEventListener("click", () => {
                const geom = geometrieCourante();
                if (!geom) {
                    toast("Aucune geometrie a exporter.", "info");
                    return;
                }
                const feature = {
                    type: "Feature",
                    properties: { reference: cellule.reference, nom: cellule.nom, section: section?.nom || "" },
                    geometry: geom,
                };
                telechargerFichierTexte(`geometrie_${cellule.reference.replace(/[^\w-]+/g, "_")}.geojson`, JSON.stringify(feature, null, 2));
            });
            contenu.querySelector("#ge-enregistrer").addEventListener("click", async () => {
                const geom = geometrieCourante();
                if (!geom) {
                    toast("Dessinez ou importez au moins un polygone valide (3 sommets minimum).", "error");
                    return;
                }
                await db.cellules.update(cellule.id, { geometry: geom, updatedAt: new Date().toISOString() });
                toast("Geometrie enregistree. La section rattachee est mise a jour automatiquement.", "success");
                await onEnregistre?.();
                fermer();
            });
            contenu.querySelector("#ge-supprimer-geom").addEventListener("click", async () => {
                if (!confirm("Supprimer definitivement la geometrie de cette cellule ?"))
                    return;
                await db.cellules.update(cellule.id, { geometry: null, updatedAt: new Date().toISOString() });
                toast("Geometrie supprimee.", "success");
                await onEnregistre?.();
                fermer();
            });
            redessiner();
            majStats();
            const geomDepart = geometrieCourante();
            const empriseDepart = geomDepart ? empriseGeometrie(geomDepart) : null;
            setTimeout(() => {
                if (empriseDepart)
                    ctx.map.fitBounds(L.latLngBounds(empriseDepart), { padding: [50, 50], maxZoom: 17 });
            }, 220);
            if (avaitDesTrous)
                toast("Cette geometrie comportait des anneaux interieurs : seuls les contours exterieurs sont editables.", "info");
        },
        onFerme: () => { ctx?.map.remove(); },
    });
}
// ------------------------------------------------------------------------
// 17. MODULE CARTOGRAPHIE (administrateur principal et comptes autorises)
// ------------------------------------------------------------------------
let carteModuleCtx = null;
async function renderCartographieView(container) {
    if (!cartoDisponible()) {
        container.innerHTML = emptyState("Le moteur cartographique (Leaflet) n'a pas pu etre charge. Une connexion Internet est necessaire au chargement de la page.");
        return;
    }
    if (carteModuleCtx) {
        try {
            carteModuleCtx.map.remove();
        }
        catch { /* carte deja detruite */ }
        carteModuleCtx = null;
    }
    const donnees = await chargerDonneesCarto();
    const peutEditer = can(getSession().role, "manageStructure");
    const cellulesAvecGeom = donnees.cellules.filter(aUneGeometrie);
    const sectionsAvecGeom = donnees.sections.filter(s => !!geometrieSection(s, donnees.cellules));
    const optionsCellules = donnees.cellules
        .slice().sort((a, b) => a.nom.localeCompare(b.nom, "fr"))
        .map(c => `<option value="${c.id}">${escapeHtml(c.reference)}${aUneGeometrie(c) ? "" : " (sans geometrie)"}</option>`).join("");
    container.innerHTML = `
    <div class="view-banner view-banner--green">
      <div class="view-banner__eyebrow">Territoire</div>
      <h2 class="view-banner__title">Cartographie</h2>
      <p class="view-banner__subtitle">Fonds de carte, geometries des cellules, regroupement automatique en sections, mesures et exports.</p>
    </div>
    <div class="stat-grid stat-grid--compact">
      <div class="stat-card stat-card--green"><div class="stat-card__value">${cellulesAvecGeom.length}/${donnees.cellules.length}</div><div class="stat-card__label">Cellules cartographiees</div></div>
      <div class="stat-card stat-card--amber"><div class="stat-card__value">${sectionsAvecGeom.length}/${donnees.sections.length}</div><div class="stat-card__label">Sections couvertes</div></div>
      <div class="stat-card stat-card--slate"><div class="stat-card__value">${donnees.membres.filter(m => cellulesAvecGeom.some(c => c.id === m.celluleId)).length}</div><div class="stat-card__label">Membres localises</div></div>
    </div>
    <div class="carte-inline">
      <aside class="carte-aside">
        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Recherche</h4>
          <input type="search" class="search-input carte-champ" id="carto-q"
                 placeholder="Membre, cellule ou section...">
          <div class="carto-resultats" id="carto-resultats"></div>
          <div class="carte-actions" style="margin-top:8px;">
            <button type="button" class="btn btn--ghost btn--xs" id="carto-liste-membres" disabled>&#128100; Membres</button>
            <button type="button" class="btn btn--ghost btn--xs" id="carto-liste-cellules" disabled>&#127961; Cellules</button>
          </div>
          <p class="carte-note" id="carto-selection-note">Recherchez une cellule ou une section, ou cliquez directement sur la carte.</p>
        </div>

        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Calques</h4>
          ${NIVEAUX_CARTO.map(n => {
        const dispo = !n.administratif || (donnees.couches || []).some(c => c.niveau === n.id);
        return `<label class="carte-check"><input type="checkbox" data-niveau="${n.id}" ${dispo ? "checked" : ""} ${dispo ? "" : "disabled"}> ${escapeHtml(n.label)}${n.administratif && !dispo ? " <span class=\"carte-note\">(aucune couche)</span>" : ""}</label>`;
    }).join("")}
          <label class="carte-check"><input type="checkbox" id="carto-c-etiquettes" checked> Etiquettes (references)</label>
          <p class="carte-note">Fonds disponibles depuis l'icone en haut a droite : satellite, plan OpenStreetMap, routier, relief, fonds clair / sombre, et sans fond.</p>
        </div>

        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Agregation au zoom</h4>
          <label class="carte-check"><input type="checkbox" id="carto-auto"> Suivre le zoom automatiquement</label>
          <label class="carte-check"><input type="checkbox" id="carto-agregats" checked> Afficher les totaux correles</label>
          <div class="stat-liste" style="margin-top:6px;">
            <div class="stat-liste__ligne"><span>Niveau affiche</span><b id="carto-niveau-actif">—</b></div>
          </div>
          <p class="carte-note">Active, cette option n'affiche qu'un seul decoupage a la fois : departement, puis commune, section et cellule au fur et a mesure que l'on zoome. Les totaux (membres, cartes, cellules) sont recalcules pour le decoupage affiche.</p>
        </div>

        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Couches administratives</h4>
          ${peutEditer
        ? `<div class="carte-actions">
                 <button type="button" class="btn btn--primary btn--xs" id="carto-charger-couche">&#8679; Charger une couche</button>
                 <button type="button" class="btn btn--ghost btn--xs" id="carto-symbologie">&#127912; Symbologie</button>
                 <button type="button" class="btn btn--ghost btn--xs" id="carto-gerer-couches">&#9881; Gerer</button>
               </div>`
        : `<p class="carte-note">Import et symbologie reserves a l'administrateur principal.</p>`}
          <div class="stat-liste" style="margin-top:8px;">
            ${["departement", "commune"].map(niveau => {
        const n = (donnees.couches || []).filter(c => c.niveau === niveau).length;
        const def = NIVEAUX_CARTO.find(x => x.id === niveau);
        return `<div class="stat-liste__ligne"><span>${escapeHtml(def.label)}</span><b>${n}</b></div>`;
    }).join("")}
          </div>
        </div>

        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Legende</h4>
          <div class="carte-legende__item"><span class="carte-pastille" style="background:rgba(159,26,22,.18);border-color:${CARTO_COULEURS.cellule};"></span> Cellule (${cellulesAvecGeom.length})</div>
          <div class="carte-legende__item"><span class="carte-pastille" style="background:rgba(0,103,37,.06);border-color:${CARTO_COULEURS.section};border-style:dashed;"></span> Section (${sectionsAvecGeom.length})</div>
          ${NIVEAUX_CARTO.filter(n => n.administratif).map(n => {
        const total = (donnees.couches || []).filter(c => c.niveau === n.id).length;
        return total ? `<div class="carte-legende__item"><span class="carte-pastille" style="background:transparent;border-color:${n.couleur};border-style:dashed;"></span> ${escapeHtml(n.label)} (${total})</div>` : "";
    }).join("")}
          <div class="carte-legende__item"><span class="carte-pastille" style="background:rgba(245,158,11,.42);border-color:${CARTO_COULEURS.cible};"></span> Selection / recherche</div>
          <div class="carte-legende__item"><span class="carte-pastille" style="background:rgba(14,165,233,.25);border-color:${CARTO_COULEURS.mesure};"></span> Mesure en cours</div>
        </div>

        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Mesure</h4>
          <div class="carte-actions">
            <button type="button" class="btn btn--ghost btn--xs" id="carto-m-distance">&#128207; Distance</button>
            <button type="button" class="btn btn--ghost btn--xs" id="carto-m-surface">&#9639; Superficie</button>
            <button type="button" class="btn btn--ghost btn--xs" id="carto-m-stop">&#10005; Arreter</button>
          </div>
          <div class="carte-mesure" id="carto-m-resultat" style="margin-top:8px;"></div>
        </div>

        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Geometrie</h4>
          ${peutEditer ? `
          <div class="carte-recherche" style="margin-bottom:6px;">
            <select id="carto-geom-cellule">${optionsCellules || `<option value="">Aucune cellule</option>`}</select>
          </div>
          <div class="carte-actions">
            <button type="button" class="btn btn--primary btn--xs" id="carto-geom-editer">&#9998; Dessiner / importer</button>
          </div>` : `<p class="carte-note">Modification reservee a l'administrateur principal.</p>`}
          <p class="carte-note">La geometrie d'une section n'est jamais saisie : elle regroupe automatiquement les cellules qui lui sont rattachees et se met a jour a chaque modification.</p>
        </div>

        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Exports</h4>
          <div class="carte-actions">
            <button type="button" class="btn btn--ghost btn--xs" id="carto-export-geojson">&#8681; GeoJSON</button>
            <button type="button" class="btn btn--ghost btn--xs" id="carto-export-pdf">&#128438; PDF</button>
          </div>
        </div>
      </aside>
      <div class="carte-host" id="carto-host"></div>
    </div>`;
    const ctx = creerCarteSGBD($("#carto-host"), donnees);
    carteModuleCtx = ctx;
    // --- Recherche libre sur les membres, cellules et sections -------------
    const champRecherche = $("#carto-q");
    const zoneResultats = $("#carto-resultats");
    const noteSelection = $("#carto-selection-note");
    const btnListeMembres = $("#carto-liste-membres");
    const btnListeCellules = $("#carto-liste-cellules");
    let selectionPanneau = null; // { kind, id }
    // Selectionne une entite : mise en valeur sur la carte, scintillement au
    // centre du polygone, et activation des boutons de liste correspondants.
    function selectionner(kind, id, options = {}) {
        const cible = cibleGeographique(kind, id, ctx.donnees);
        if (cible.erreur) {
            // L'entite reste selectionnee dans le panneau meme sans geometrie :
            // ses listes doivent rester accessibles.
            selectionPanneau = { kind, id };
            majSelection();
            if (!options.silencieux)
                toast(cible.erreur, "info");
            return;
        }
        selectionPanneau = { kind: kind === "membre" ? cible.kind : kind, id: kind === "membre" ? cible.id : id };
        localiserSurCarte(ctx, cible.kind, cible.id);
        majSelection();
        if (kind === "membre")
            toast(`${cible.titre} — ${cible.sousTitre}`, "info");
    }
    // Annule la selection courante : plus de surbrillance ni de scintillement.
    function effacerSelection() {
        selectionPanneau = null;
        ctx.selection = null;
        ctx.coucheFlash.clearLayers();
        rafraichirStylesCarto(ctx);
        majSelection();
    }
    function majSelection() {
        const estCellule = selectionPanneau?.kind === "cellule";
        const estSection = selectionPanneau?.kind === "section";
        btnListeMembres.disabled = !estCellule;
        btnListeCellules.disabled = !estSection;
        if (!selectionPanneau) {
            noteSelection.textContent = "Recherchez une cellule ou une section, ou cliquez directement sur la carte.";
            return;
        }
        const liste = estCellule ? ctx.donnees.cellules : ctx.donnees.sections;
        const item = liste.find(x => x.id === selectionPanneau.id);
        noteSelection.innerHTML = item
            ? `Selection : <b>${escapeHtml(item.reference)}</b> <button type="button" class="chip__x" id="carto-effacer-selection" title="Annuler la selection">&times;</button>`
            : "Selection introuvable.";
        noteSelection.querySelector("#carto-effacer-selection")?.addEventListener("click", effacerSelection);
    }
    majSelection();
    // Recherche libre sur les trois entites a la fois.
    champRecherche.addEventListener("input", () => {
        const q = cleNom(champRecherche.value);
        if (q.length < 1) {
            zoneResultats.innerHTML = "";
            return;
        }
        const { membres, cellules, sections } = ctx.donnees;
        const correspond = (...champs) => champs.some(v => cleNom(String(v ?? "")).includes(q));
        const trouves = [
            ...sections.filter(s => correspond(s.nom, s.reference)).map(s => ({ kind: "section", entite: s, meta: "Section" })),
            ...cellules.filter(c => correspond(c.nom, c.reference)).map(c => ({ kind: "cellule", entite: c, meta: "Cellule" })),
            // Sur la reference d'un membre, seule sa partie propre est comparee :
            // la fin reprend la reference de sa cellule et ferait remonter tous
            // les membres d'une cellule des qu'on cherche son nom.
            ...membres.filter(m => correspond(nomComplet(m), String(m.reference || "").split("/")[0], m.telephone, m.numeroCarteMembre))
                .map(m => ({ kind: "membre", entite: m, meta: `Membre · ${cellules.find(c => c.id === m.celluleId)?.nom || "sans cellule"}` })),
        ].slice(0, 30);
        zoneResultats.innerHTML = trouves.length ? trouves.map(t => `
      <button type="button" class="carto-item carto-item--resultat" data-resultat="${t.kind}:${t.entite.id}">
        <span class="carto-item__nom">${escapeHtml(t.kind === "membre" ? nomComplet(t.entite) : t.entite.nom)}</span>
        <span class="carto-item__meta">${escapeHtml(t.meta)}</span>
      </button>`).join("") : `<p class="carte-note">Aucun resultat.</p>`;
        zoneResultats.querySelectorAll("[data-resultat]").forEach(b => b.addEventListener("click", () => {
            const [k, id] = b.dataset.resultat.split(":");
            selectionner(k, Number(id));
        }));
    });
    btnListeMembres.addEventListener("click", () => {
        if (selectionPanneau?.kind === "cellule")
            ouvrirListeMembresCellule(selectionPanneau.id);
    });
    btnListeCellules.addEventListener("click", () => {
        if (selectionPanneau?.kind === "section")
            ouvrirListeCellulesSection(selectionPanneau.id);
    });
    // --- Calques ----------------------------------------------------------
    brancherCalquesCarto(ctx, container, "#carto-c-etiquettes", "#carto-agregats");
    // --- Agregation automatique au zoom -----------------------------------
    const casesNiveaux = [...container.querySelectorAll("[data-niveau]")];
    const libelleNiveau = (id) => NIVEAUX_CARTO.find(n => n.id === id)?.label || "—";
    const majNiveauAffiche = (niveau) => {
        $("#carto-niveau-actif").textContent = niveau
            ? `${libelleNiveau(niveau)} (zoom ${ctx.map.getZoom()})`
            : "manuel";
        // Les cases de calques refletent le niveau pilote par le zoom.
        casesNiveaux.forEach(c => {
            c.disabled = ctx.agregationAuto || c.disabled && !ctx.agregationAuto && c.dataset.forceDisabled === "1";
            if (ctx.agregationAuto)
                c.checked = c.dataset.niveau === niveau;
        });
    };
    casesNiveaux.forEach(c => { if (c.disabled) c.dataset.forceDisabled = "1"; });
    ctx.onNiveauChange = majNiveauAffiche;
    const caseAuto = $("#carto-auto");
    caseAuto.addEventListener("change", () => {
        ctx.agregationAuto = caseAuto.checked;
        if (ctx.agregationAuto) {
            ctx.niveauAffiche = null;
            appliquerNiveauZoom(ctx);
        }
        else {
            // Retour au controle manuel : on restitue l'affichage par defaut.
            ctx.niveauAffiche = null;
            casesNiveaux.forEach(c => {
                c.disabled = c.dataset.forceDisabled === "1";
                c.checked = !c.disabled;
                const groupe = ctx.groupes[c.dataset.niveau];
                if (c.checked)
                    groupe.addTo(ctx.map);
                else
                    ctx.map.removeLayer(groupe);
            });
            majNiveauAffiche(null);
            desencombrerEtiquettes(ctx);
        }
    });
    // L'indicateur de niveau affiche aussi le zoom courant : il doit donc se
    // rafraichir a chaque zoom, et pas seulement au changement de niveau.
    ctx.map.on("zoomend", () => majNiveauAffiche(ctx.agregationAuto ? ctx.niveauAffiche : null));
    majNiveauAffiche(null);
    // --- Couches administratives (import reserve a l'administrateur) -------
    document.getElementById("carto-charger-couche")?.addEventListener("click", () => ouvrirImportCoucheAdministrative(async () => {
        await rechargerCarto(ctx);
        renderView();
    }));
    document.getElementById("carto-symbologie")?.addEventListener("click", () => ouvrirSymbologieCouches(ctx));
    document.getElementById("carto-gerer-couches")?.addEventListener("click", () => ouvrirGestionCouches(ctx.donnees, async () => {
        await rechargerCarto(ctx);
        renderView();
    }));
    // --- Mesure -----------------------------------------------------------
    const resultat = $("#carto-m-resultat");
    ctx.onMesureMaj = () => { resultat.innerHTML = resultatMesure(ctx); };
    ctx.onMesureMaj();
    const boutonsMesure = [$("#carto-m-distance"), $("#carto-m-surface")];
    const activer = (type, bouton) => {
        activerMesure(ctx, type);
        boutonsMesure.forEach(b => b.classList.toggle("btn--active", b === bouton && !!type));
    };
    $("#carto-m-distance").addEventListener("click", (e) => activer("distance", e.currentTarget));
    $("#carto-m-surface").addEventListener("click", (e) => activer("surface", e.currentTarget));
    $("#carto-m-stop").addEventListener("click", () => {
        activer(null, null);
        ctx.coucheMesure.clearLayers();
        ctx.onMesureMaj();
    });
    // --- Geometrie --------------------------------------------------------
    if (peutEditer) {
        $("#carto-geom-editer").addEventListener("click", () => {
            const id = Number($("#carto-geom-cellule").value);
            if (!id) {
                toast("Creez d'abord une cellule dans le module Cellules.", "info");
                return;
            }
            ouvrirEditeurGeometrieCellule(id, async () => { await rechargerCarto(ctx); });
        });
    }
    // --- Exports ----------------------------------------------------------
    $("#carto-export-geojson").addEventListener("click", () => {
        const features = [];
        for (const c of ctx.donnees.cellules) {
            if (!aUneGeometrie(c))
                continue;
            features.push({
                type: "Feature",
                properties: {
                    type: "cellule", reference: c.reference, nom: c.nom, numero: c.numero,
                    section: ctx.donnees.sections.find(s => s.id === c.sectionId)?.nom || "",
                    membres: ctx.donnees.membres.filter(m => m.celluleId === c.id).length,
                    superficie_m2: Math.round(aireGeometrie(c.geometry)),
                },
                geometry: c.geometry,
            });
        }
        for (const s of ctx.donnees.sections) {
            const geometry = geometrieSection(s, ctx.donnees.cellules);
            if (!geometry)
                continue;
            features.push({
                type: "Feature",
                properties: {
                    type: "section", reference: s.reference, nom: s.nom, numero: s.numero,
                    cellules: ctx.donnees.cellules.filter(c => c.sectionId === s.id).length,
                    superficie_m2: Math.round(aireGeometrie(geometry)),
                },
                geometry,
            });
        }
        if (!features.length) {
            toast("Aucune geometrie a exporter.", "info");
            return;
        }
        telechargerFichierTexte("cartographie_sgbd_mory.geojson", JSON.stringify({ type: "FeatureCollection", features }, null, 2));
        toast("Export GeoJSON genere.", "success");
    });
    $("#carto-export-pdf").addEventListener("click", () => exporterCartePDF(ctx.donnees));
    // Rafraichit le panneau lateral quand une geometrie est cliquee.
    ctx.onSelection = (kind, entite) => {
        selectionPanneau = { kind, id: entite.id };
        majSelection();
    };
}
// ---- Couches administratives (departements, communes) --------------------
// Import d'un fichier GeoJSON : chaque entite du fichier devient une couche
// affichable en fond de la cartographie. Reserve a l'administrateur principal.
function ouvrirImportCoucheAdministrative(apresImport) {
    if (!can(getSession().role, "manageStructure")) {
        toast("Import reserve a l'administrateur principal.", "error");
        return;
    }
    let entites = [];
    let proprietes = [];
    ouvrirModale({
        titre: "Charger une couche administrative",
        taille: "wide",
        contenuHtml: `
      <p class="form-note">Importez la geometrie des <b>departements</b> ou <b>communes</b> au format GeoJSON
      (FeatureCollection, Feature ou geometrie simple). Chaque entite du fichier devient une entree affichable et masquable sur la carte.</p>
      <div class="filtre-bar" style="margin-bottom:12px;">
        <label class="filtre-groupe">
          <span>Niveau *</span>
          <select id="cc-niveau">
            ${NIVEAUX_CARTO.filter(n => n.administratif).map(n => `<option value="${n.id}">${escapeHtml(n.label)}</option>`).join("")}
          </select>
        </label>
        <label class="filtre-groupe" style="flex:1;min-width:200px;">
          <span>Fichier GeoJSON *</span>
          <input type="file" id="cc-fichier" accept=".json,.geojson,application/json,application/geo+json">
        </label>
        <label class="filtre-groupe" style="min-width:180px;">
          <span>Champ contenant le nom</span>
          <select id="cc-propriete" disabled><option value="">—</option></select>
        </label>
      </div>
      <div id="cc-apercu"></div>
      <div class="modal__actions" style="position:static;margin:14px 0 0;padding-top:14px;">
        <button type="button" class="btn btn--ghost" id="cc-annuler">Annuler</button>
        <button type="button" class="btn btn--primary" id="cc-confirmer" disabled>Importer la couche</button>
      </div>`,
        onMonte: (contenu, fermer) => {
            const apercu = contenu.querySelector("#cc-apercu");
            const selProp = contenu.querySelector("#cc-propriete");
            const btnConfirmer = contenu.querySelector("#cc-confirmer");
            const rafraichirApercu = () => {
                const champ = selProp.value;
                const lignes = entites.map((e, i) => ({
                    nom: (champ && e.proprietes[champ] != null && String(e.proprietes[champ]).trim())
                        || `Entite ${i + 1}`,
                    parties: polygonesDeGeometrie(e.geometry).length,
                    superficie: formatSuperficie(aireGeometrie(e.geometry)),
                }));
                apercu.innerHTML = `
          <p class="form-note">${lignes.length} entite(s) exploitable(s) dans ce fichier.</p>
          <div class="table-wrap" style="max-height:280px;overflow:auto;">
            <table class="data-table">
              <thead><tr><th>Nom</th><th class="num">Parties</th><th class="num">Superficie</th></tr></thead>
              <tbody>${lignes.slice(0, 300).map(l => `<tr><td>${escapeHtml(l.nom)}</td><td class="num">${l.parties}</td><td class="num">${escapeHtml(l.superficie)}</td></tr>`).join("")}</tbody>
            </table>
          </div>`;
                btnConfirmer.disabled = lignes.length === 0;
            };
            contenu.querySelector("#cc-fichier").addEventListener("change", async (e) => {
                entites = [];
                proprietes = [];
                btnConfirmer.disabled = true;
                const fichier = e.target.files?.[0];
                if (!fichier) {
                    apercu.innerHTML = "";
                    return;
                }
                try {
                    const json = JSON.parse(await fichier.text());
                    const features = json.type === "FeatureCollection" ? (json.features || [])
                        : json.type === "Feature" ? [json]
                            : [{ type: "Feature", properties: {}, geometry: json }];
                    for (const f of features) {
                        const geometry = normaliserGeometrieImportee(f.geometry || f);
                        if (geometry)
                            entites.push({ geometry, proprietes: f.properties || {} });
                    }
                    if (!entites.length) {
                        apercu.innerHTML = `<p class="form-note form-note--warn">Aucun polygone exploitable dans ce fichier.</p>`;
                        return;
                    }
                    // Champs textuels disponibles pour nommer chaque entite.
                    const cles = new Set();
                    for (const ent of entites)
                        for (const [k, v] of Object.entries(ent.proprietes))
                            if (v == null || typeof v !== "object")
                                cles.add(k);
                    proprietes = [...cles];
                    const prefere = proprietes.find(k => /^(nom|name|nom_?fr|adm\d?_?fr|libelle|label)$/i.test(k)) || proprietes[0] || "";
                    selProp.innerHTML = proprietes.length
                        ? proprietes.map(k => `<option value="${escapeHtml(k)}" ${k === prefere ? "selected" : ""}>${escapeHtml(k)}</option>`).join("")
                        : `<option value="">Aucun champ texte</option>`;
                    selProp.disabled = !proprietes.length;
                    rafraichirApercu();
                }
                catch {
                    apercu.innerHTML = `<p class="form-note form-note--warn">Fichier JSON illisible.</p>`;
                }
            });
            selProp.addEventListener("change", rafraichirApercu);
            contenu.querySelector("#cc-annuler").addEventListener("click", fermer);
            btnConfirmer.addEventListener("click", async () => {
                const niveau = contenu.querySelector("#cc-niveau").value;
                const champ = selProp.value;
                const now = new Date().toISOString();
                await db.couches.bulkAdd(entites.map((e, i) => ({
                    niveau,
                    nom: (champ && e.proprietes[champ] != null && String(e.proprietes[champ]).trim()) || `Entite ${i + 1}`,
                    geometry: e.geometry,
                    createdAt: now,
                })));
                toast(`${entites.length} entite(s) importee(s) dans la couche ${niveau}.`, "success");
                fermer();
                await apresImport?.();
            });
        },
    });
}
// Symbologie des couches administratives : trait, fond, transparence,
// etiquettes. Chaque modification s'applique immediatement sur la carte et
// est enregistree pour le niveau concerne.
function ouvrirSymbologieCouches(ctx) {
    if (!can(getSession().role, "manageStructure")) {
        toast("Symbologie reservee a l'administrateur principal.", "error");
        return;
    }
    const niveaux = NIVEAUX_CARTO.filter(n => n.administratif);
    const bloc = (n) => {
        const s = styleCouche(ctx.donnees, n.id);
        const total = (ctx.donnees.couches || []).filter(c => c.niveau === n.id).length;
        return `
    <fieldset class="bureau-fieldset" data-symbo="${n.id}">
      <legend>${escapeHtml(n.label)} <span class="badge badge--muted">${total} entite(s)</span></legend>
      <label class="field"><span>Couleur du trait</span><input type="color" data-prop="couleur" value="${escapeHtml(s.couleur)}"></label>
      <label class="field"><span>Epaisseur du trait : <b data-affiche="epaisseur">${s.epaisseur}</b> px</span>
        <input type="range" min="0.5" max="8" step="0.5" data-prop="epaisseur" value="${s.epaisseur}"></label>
      <label class="field"><span>Style du trait</span>
        <select data-prop="tirets"><option value="1" ${s.tirets ? "selected" : ""}>Tirets</option><option value="0" ${s.tirets ? "" : "selected"}>Continu</option></select></label>
      <label class="field"><span>Fond</span>
        <select data-prop="remplissage"><option value="0" ${s.remplissage ? "" : "selected"}>Aucun (transparent)</option><option value="1" ${s.remplissage ? "selected" : ""}>Colore</option></select></label>
      <label class="field"><span>Couleur du fond</span><input type="color" data-prop="couleurFond" value="${escapeHtml(s.couleurFond)}"></label>
      <label class="field"><span>Transparence du fond : <b data-affiche="opacite">${Math.round(s.opacite * 100)}</b> %</span>
        <input type="range" min="0" max="1" step="0.05" data-prop="opacite" value="${s.opacite}"></label>
      <label class="field"><span>Etiquettes</span>
        <select data-prop="etiquettes"><option value="1" ${s.etiquettes ? "selected" : ""}>Afficher</option><option value="0" ${s.etiquettes ? "" : "selected"}>Masquer</option></select></label>
      <label class="field"><span>Taille des etiquettes : <b data-affiche="tailleEtiquette">${s.tailleEtiquette}</b> px</span>
        <input type="range" min="8" max="20" step="1" data-prop="tailleEtiquette" value="${s.tailleEtiquette}"></label>
    </fieldset>`;
    };
    ouvrirModale({
        titre: "Symbologie des couches administratives",
        taille: "wide",
        contenuHtml: `
      <p class="form-note">Chaque reglage s'applique immediatement sur la carte et reste memorise pour le niveau concerne.</p>
      <div class="entity-form" style="padding:0;">${niveaux.map(bloc).join("")}</div>
      <div class="modal__actions" style="position:static;margin:12px 0 0;padding-top:12px;">
        <button type="button" class="btn btn--ghost" id="symbo-defaut">Retablir les valeurs par defaut</button>
        <button type="button" class="btn btn--primary" id="symbo-fermer">Fermer</button>
      </div>`,
        onMonte: (contenu, fermer) => {
            const appliquer = async (niveau, racine) => {
                const style = { niveau };
                racine.querySelectorAll("[data-prop]").forEach(champ => {
                    const prop = champ.dataset.prop;
                    if (prop === "tirets" || prop === "remplissage" || prop === "etiquettes")
                        style[prop] = champ.value === "1";
                    else if (champ.type === "range")
                        style[prop] = Number(champ.value);
                    else
                        style[prop] = champ.value;
                });
                // Valeurs chiffrees affichees a cote de leur curseur.
                racine.querySelector('[data-affiche="epaisseur"]').textContent = String(style.epaisseur);
                racine.querySelector('[data-affiche="opacite"]').textContent = String(Math.round(style.opacite * 100));
                racine.querySelector('[data-affiche="tailleEtiquette"]').textContent = String(style.tailleEtiquette);
                await db.stylesCouches.put(style);
                ctx.donnees.styles = await db.stylesCouches.toArray();
                dessinerCouchesCarto(ctx);
                appliquerNiveauZoom(ctx);
            };
            contenu.querySelectorAll("[data-symbo]").forEach(racine => {
                racine.querySelectorAll("[data-prop]").forEach(champ => {
                    champ.addEventListener("input", () => appliquer(racine.dataset.symbo, racine));
                    champ.addEventListener("change", () => appliquer(racine.dataset.symbo, racine));
                });
            });
            contenu.querySelector("#symbo-defaut").addEventListener("click", async () => {
                await db.stylesCouches.clear();
                ctx.donnees.styles = [];
                dessinerCouchesCarto(ctx);
                appliquerNiveauZoom(ctx);
                toast("Symbologie par defaut retablie.", "success");
                fermer();
            });
            contenu.querySelector("#symbo-fermer").addEventListener("click", fermer);
        },
    });
}
// Liste des couches importees, avec suppression par niveau ou entite.
function ouvrirGestionCouches(donnees, apresModification) {
    const couches = donnees.couches || [];
    ouvrirModale({
        titre: `Couches administratives (${couches.length})`,
        taille: "wide",
        contenuHtml: `
      ${couches.length ? "" : `<p class="form-note">Aucune couche importee pour le moment.</p>`}
      <div class="carte-actions" style="margin-bottom:12px;">
        ${NIVEAUX_CARTO.filter(n => n.administratif).map(n => {
            const total = couches.filter(c => c.niveau === n.id).length;
            return total ? `<button type="button" class="btn btn--ghost btn--xs" data-vider="${n.id}">&#128465; Vider ${escapeHtml(n.label.toLowerCase())} (${total})</button>` : "";
        }).join("")}
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr><th>Niveau</th><th>Nom</th><th class="num">Parties</th><th class="num">Superficie</th><th></th></tr></thead>
          <tbody>${couches.map(c => `<tr>
            <td>${escapeHtml(NIVEAUX_CARTO.find(n => n.id === c.niveau)?.label || c.niveau)}</td>
            <td>${escapeHtml(c.nom)}</td>
            <td class="num">${polygonesDeGeometrie(c.geometry).length}</td>
            <td class="num">${escapeHtml(formatSuperficie(aireGeometrie(c.geometry)))}</td>
            <td class="row-actions"><button class="icon-btn icon-btn--danger" data-supprimer="${c.id}" title="Supprimer">&#128465;</button></td>
          </tr>`).join("")}</tbody>
        </table>
      </div>`,
        onMonte: (contenu, fermer) => {
            contenu.querySelectorAll("[data-supprimer]").forEach(b => b.addEventListener("click", async () => {
                await db.couches.delete(Number(b.dataset.supprimer));
                toast("Entite supprimee.", "success");
                fermer();
                await apresModification?.();
            }));
            contenu.querySelectorAll("[data-vider]").forEach(b => b.addEventListener("click", async () => {
                const niveau = b.dataset.vider;
                if (!confirm(`Supprimer toutes les entites de la couche "${niveau}" ?`))
                    return;
                await db.couches.where("niveau").equals(niveau).delete();
                toast("Couche supprimee.", "success");
                fermer();
                await apresModification?.();
            }));
        },
    });
}
// Export PDF de l'ensemble de la cartographie : plan vectoriel + recapitulatif
// des sections et des cellules.
function exporterCartePDF(donnees) {
    const entrees = [];
    for (const section of donnees.sections) {
        const geometry = geometrieSection(section, donnees.cellules);
        if (geometry)
            entrees.push({ geometry, couleur: CARTO_COULEURS.section, remplissage: "#006725", opacite: 0.05, epaisseur: 2.6, label: section.nom });
    }
    for (const cellule of donnees.cellules) {
        if (aUneGeometrie(cellule))
            entrees.push({ geometry: cellule.geometry, couleur: CARTO_COULEURS.cellule, remplissage: "#9F1A16", opacite: 0.18, epaisseur: 1.4, label: cellule.nom });
    }
    if (!entrees.length) {
        toast("Aucune geometrie n'est encore definie : il n'y a rien a exporter.", "info");
        return;
    }
    const lignesSections = donnees.sections.map(s => {
        const geometry = geometrieSection(s, donnees.cellules);
        const cellulesSection = donnees.cellules.filter(c => c.sectionId === s.id);
        return [s.numero, s.reference, s.nom, cellulesSection.length,
            cellulesSection.filter(aUneGeometrie).length,
            donnees.membres.filter(m => m.sectionId === s.id).length,
            geometry ? formatSuperficie(aireGeometrie(geometry)) : "—"];
    });
    const lignesCellules = donnees.cellules.map(c => [
        c.numero, c.reference, c.nom,
        donnees.sections.find(s => s.id === c.sectionId)?.nom || "—",
        donnees.membres.filter(m => m.celluleId === c.id).length,
        aUneGeometrie(c) ? formatSuperficie(aireGeometrie(c.geometry)) : "Sans geometrie",
    ]);
    exporterPDF("Cartographie du territoire", `
    <div class="pdf-resume">
      <div class="pdf-tuile"><b>${donnees.sections.length}</b><span>Sections</span></div>
      <div class="pdf-tuile"><b>${donnees.cellules.length}</b><span>Cellules</span></div>
      <div class="pdf-tuile"><b>${donnees.cellules.filter(aUneGeometrie).length}</b><span>Cellules cartographiees</span></div>
      <div class="pdf-tuile"><b>${donnees.membres.length}</b><span>Membres</span></div>
    </div>
    ${blocCartePDF("Plan des cellules et des sections", entrees, [
        { label: "Cellule", couleur: CARTO_COULEURS.cellule, remplissage: "rgba(159,26,22,.18)" },
        { label: "Section (regroupement automatique)", couleur: CARTO_COULEURS.section, remplissage: "rgba(0,103,37,.06)" },
    ])}
    <h2>Sections</h2>
    ${tableauPDF(["N°", "Reference", "Nom", "Cellules", "dont cartographiees", "Membres", "Superficie"], lignesSections)}
    <h2>Cellules</h2>
    ${tableauPDF(["N°", "Reference", "Nom", "Section", "Membres", "Superficie"], lignesCellules)}
  `, "landscape");
}
// ------------------------------------------------------------------------
// 18. LISTES RATTACHEES (membres d'une cellule / cellules d'une section)
// avec export CSV et export PDF incluant la carte.
// ------------------------------------------------------------------------
// Poste occupe par un membre dans le bureau de sa cellule / section.
function posteAuBureau(structure, roles, membreId) {
    const role = roles.find(r => structure[r.key] === membreId);
    return role ? role.label : "—";
}
async function ouvrirListeMembresCellule(celluleId) {
    const donnees = await chargerDonneesCarto();
    const cellule = donnees.cellules.find(c => c.id === celluleId);
    if (!cellule) {
        toast("Cellule introuvable.", "error");
        return;
    }
    const section = donnees.sections.find(s => s.id === cellule.sectionId);
    const liste = donnees.membres
        .filter(m => m.celluleId === celluleId)
        .sort((a, b) => nomComplet(a).localeCompare(nomComplet(b), "fr"));
    const entetes = ["N°", "Reference", "Prenom & nom", "Sexe", "Telephone", "Quartier / Village",
        "Fonction", "Electeur", "Commune de vote", "Adhesion", "Poste au bureau"];
    const ligneDe = (m) => [
        m.numero, m.reference, nomComplet(m), m.sexe || "—", m.telephone || "—",
        m.quartierVillage || "—", m.fonction || "—", m.electeur || "—",
        m.communeVote || "—", m.adhesion || "—",
        posteAuBureau(cellule, CELLULE_BUREAU_ROLES, m.id),
    ];
    const lignes = liste.map(ligneDe);
    const hommes = liste.filter(m => m.sexe === "M").length;
    const femmes = liste.filter(m => m.sexe === "F").length;
    const geometrie = aUneGeometrie(cellule) ? cellule.geometry : null;
    ouvrirModale({
        titre: `Membres de la cellule — ${cellule.reference}`,
        taille: "xwide",
        contenuHtml: `
      <p class="liste-resume">
        <b>${liste.length}</b> membre(s) rattache(s) &middot; ${hommes} homme(s), ${femmes} femme(s)
        &middot; Section : <b>${escapeHtml(section?.nom || "—")}</b>
        &middot; Geometrie : <b>${geometrie ? formatSuperficie(aireGeometrie(geometrie)) : "non definie"}</b>
      </p>
      <div class="liste-outils">
        <input type="search" class="search-input" id="lm-recherche" placeholder="Filtrer les membres...">
        <button type="button" class="btn btn--ghost" id="lm-csv">&#8681; Exporter CSV</button>
        <button type="button" class="btn btn--primary" id="lm-pdf">&#128438; Exporter PDF</button>
        ${geometrie ? `<button type="button" class="btn btn--ghost" id="lm-carte">&#127757; Voir sur la carte</button>` : ""}
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>${entetes.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
          <tbody id="lm-tbody"></tbody>
        </table>
        <div id="lm-vide"></div>
      </div>`,
        onMonte: (contenu) => {
            const tbody = contenu.querySelector("#lm-tbody");
            const vide = contenu.querySelector("#lm-vide");
            const dessiner = (rows) => {
                tbody.innerHTML = rows.map(r => `<tr>${r.map(c => `<td>${escapeHtml(String(c ?? ""))}</td>`).join("")}</tr>`).join("");
                vide.innerHTML = rows.length ? "" : emptyState("Aucun membre rattache a cette cellule.");
            };
            dessiner(lignes);
            contenu.querySelector("#lm-recherche").addEventListener("input", (e) => {
                const q = e.target.value.trim().toLowerCase();
                dessiner(q ? lignes.filter(r => r.join(" ").toLowerCase().includes(q)) : lignes);
            });
            contenu.querySelector("#lm-csv").addEventListener("click", () => exporterCSV(`membres_${cellule.reference.replace(/[^\w-]+/g, "_")}.csv`, entetes, lignes));
            contenu.querySelector("#lm-pdf").addEventListener("click", () => {
                const carte = geometrie
                    ? blocCartePDF(`Emprise de la cellule ${cellule.nom}`, [
                        ...(section ? [{ geometry: geometrieSection(section, donnees.cellules), couleur: CARTO_COULEURS.section, remplissage: "#006725", opacite: 0.05, epaisseur: 2.2 }] : []),
                        { geometry: geometrie, couleur: CARTO_COULEURS.cellule, remplissage: "#9F1A16", opacite: 0.24, epaisseur: 2.2, label: cellule.nom },
                    ], [
                        { label: `Cellule ${cellule.nom}`, couleur: CARTO_COULEURS.cellule, remplissage: "rgba(159,26,22,.24)" },
                        ...(section ? [{ label: `Section ${section.nom}`, couleur: CARTO_COULEURS.section, remplissage: "rgba(0,103,37,.06)" }] : []),
                    ])
                    : `<p><i>Cette cellule n'a pas encore de geometrie : la carte ne peut pas etre jointe.</i></p>`;
                exporterPDF(`Membres de la cellule ${cellule.nom}`, `
          <div class="pdf-resume">
            <div class="pdf-tuile"><b>${liste.length}</b><span>Membres</span></div>
            <div class="pdf-tuile"><b>${hommes}</b><span>Hommes</span></div>
            <div class="pdf-tuile"><b>${femmes}</b><span>Femmes</span></div>
            <div class="pdf-tuile"><b>${escapeHtml(cellule.reference)}</b><span>Reference</span></div>
            <div class="pdf-tuile"><b>${escapeHtml(section?.nom || "—")}</b><span>Section</span></div>
          </div>
          ${carte}
          <h2>Liste des membres (${liste.length})</h2>
          ${tableauPDF(entetes, lignes)}`, "landscape");
            });
            contenu.querySelector("#lm-carte")?.addEventListener("click", () => ouvrirRechercheGeographique("cellule", cellule.id));
        },
    });
}
async function ouvrirListeCellulesSection(sectionId) {
    const donnees = await chargerDonneesCarto();
    const section = donnees.sections.find(s => s.id === sectionId);
    if (!section) {
        toast("Section introuvable.", "error");
        return;
    }
    const liste = donnees.cellules
        .filter(c => c.sectionId === sectionId)
        .sort((a, b) => a.nom.localeCompare(b.nom, "fr"));
    const nomMembre = (id) => {
        const m = id ? donnees.membres.find(x => x.id === id) : undefined;
        return m ? nomComplet(m) : "—";
    };
    const entetes = ["N°", "Reference", "Nom", "Responsable cellule", "Contact", "Membres", "Bureau", "Geometrie", "Superficie"];
    const lignes = liste.map(c => {
        const { pourvus, total } = bureauCompletude(c, CELLULE_BUREAU_ROLES);
        return [
            c.numero, c.reference, c.nom, nomMembre(c.responsableCelluleId), c.contactResponsable || "—",
            donnees.membres.filter(m => m.celluleId === c.id).length,
            `${pourvus}/${total}`,
            aUneGeometrie(c) ? "Oui" : "Non",
            aUneGeometrie(c) ? formatSuperficie(aireGeometrie(c.geometry)) : "—",
        ];
    });
    const geometrieDeLaSection = geometrieSection(section, donnees.cellules);
    const totalMembres = donnees.membres.filter(m => liste.some(c => c.id === m.celluleId)).length;
    ouvrirModale({
        titre: `Cellules de la section — ${section.reference}`,
        taille: "xwide",
        contenuHtml: `
      <p class="liste-resume">
        <b>${liste.length}</b> cellule(s) regroupee(s) &middot; <b>${totalMembres}</b> membre(s)
        &middot; ${liste.filter(aUneGeometrie).length} cellule(s) cartographiee(s)
        &middot; Superficie de la section : <b>${geometrieDeLaSection ? formatSuperficie(aireGeometrie(geometrieDeLaSection)) : "non definie"}</b>
      </p>
      <div class="liste-outils">
        <input type="search" class="search-input" id="lc-recherche" placeholder="Filtrer les cellules...">
        <button type="button" class="btn btn--ghost" id="lc-csv">&#8681; Exporter CSV</button>
        <button type="button" class="btn btn--primary" id="lc-pdf">&#128438; Exporter PDF</button>
        ${geometrieDeLaSection ? `<button type="button" class="btn btn--ghost" id="lc-carte">&#127757; Voir sur la carte</button>` : ""}
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>${entetes.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
          <tbody id="lc-tbody"></tbody>
        </table>
        <div id="lc-vide"></div>
      </div>`,
        onMonte: (contenu) => {
            const tbody = contenu.querySelector("#lc-tbody");
            const vide = contenu.querySelector("#lc-vide");
            const dessiner = (rows) => {
                tbody.innerHTML = rows.map(r => `<tr>${r.map(c => `<td>${escapeHtml(String(c ?? ""))}</td>`).join("")}</tr>`).join("");
                vide.innerHTML = rows.length ? "" : emptyState("Aucune cellule rattachee a cette section.");
            };
            dessiner(lignes);
            contenu.querySelector("#lc-recherche").addEventListener("input", (e) => {
                const q = e.target.value.trim().toLowerCase();
                dessiner(q ? lignes.filter(r => r.join(" ").toLowerCase().includes(q)) : lignes);
            });
            contenu.querySelector("#lc-csv").addEventListener("click", () => exporterCSV(`cellules_${section.reference.replace(/[^\w-]+/g, "_")}.csv`, entetes, lignes));
            contenu.querySelector("#lc-pdf").addEventListener("click", () => {
                const entrees = [];
                if (geometrieDeLaSection)
                    entrees.push({ geometry: geometrieDeLaSection, couleur: CARTO_COULEURS.section, remplissage: "#006725", opacite: 0.06, epaisseur: 2.8 });
                for (const c of liste) {
                    if (aUneGeometrie(c))
                        entrees.push({ geometry: c.geometry, couleur: CARTO_COULEURS.cellule, remplissage: "#9F1A16", opacite: 0.2, epaisseur: 1.6, label: c.nom });
                }
                const carte = entrees.length
                    ? blocCartePDF(`Section ${section.nom} — cellules regroupees`, entrees, [
                        { label: "Cellule", couleur: CARTO_COULEURS.cellule, remplissage: "rgba(159,26,22,.20)" },
                        { label: "Contour de la section", couleur: CARTO_COULEURS.section, remplissage: "rgba(0,103,37,.06)" },
                    ])
                    : `<p><i>Aucune cellule de cette section n'a de geometrie : la carte ne peut pas etre jointe.</i></p>`;
                exporterPDF(`Cellules de la section ${section.nom}`, `
          <div class="pdf-resume">
            <div class="pdf-tuile"><b>${liste.length}</b><span>Cellules</span></div>
            <div class="pdf-tuile"><b>${totalMembres}</b><span>Membres</span></div>
            <div class="pdf-tuile"><b>${liste.filter(aUneGeometrie).length}</b><span>Cartographiees</span></div>
            <div class="pdf-tuile"><b>${escapeHtml(section.reference)}</b><span>Reference</span></div>
          </div>
          ${carte}
          <h2>Liste des cellules (${liste.length})</h2>
          ${tableauPDF(entetes, lignes)}`, "landscape");
            });
            contenu.querySelector("#lc-carte")?.addEventListener("click", () => ouvrirRechercheGeographique("section", section.id));
        },
    });
}
// ------------------------------------------------------------------------
// 19. MODULE MASSIFICATION
//
// Deux onglets :
//  - "Carte de membres" : liste exhaustive des membres DETENTEURS d'une carte
//    de membre (champ "Carte membre" = Oui), avec toutes leurs informations.
//  - "Analyse spatiale" : carte de densite (choroplethe) du rapport
//    membres / cartes de membre, avec statistiques, filtres de seuil
//    (cellules ou sections ayant PLUS DE / MOINS DE ...) et tableau associe.
// ------------------------------------------------------------------------
// Un membre est "porteur de carte" lorsque le champ "Carte membre" vaut Oui.
function aCarteMembre(m) {
    return m.carteMembre === "Oui";
}
// Rampe sequentielle de la carte de densite : UNE seule teinte (le vert de
// l'application), du clair au fonce. Validee : luminosite strictement
// croissante, ecart suffisant entre paliers, et palier le plus clair encore
// lisible sur fond blanc (2,08:1). Ne jamais remplacer par un arc-en-ciel :
// une grandeur se lit sur une teinte unique.
const RAMPE_MASSIFICATION = ["#83C294", "#54AC6F", "#33934F", "#1B7C3C", "#006725"];
// Gris reserve : entite exclue par le filtre de seuil, ou sans donnee.
const COULEUR_HORS_FILTRE = "#CBD5E1";
const INDICATEURS_MASSIFICATION = [
    { id: "cartes", label: "Cartes de membre (effectif)", court: "Cartes", unite: "carte(s)",
        valeur: (a) => a.cartes, format: (v) => (v == null ? "—" : String(v)) },
    { id: "membres", label: "Membres (effectif)", court: "Membres", unite: "membre(s)",
        valeur: (a) => a.membres, format: (v) => (v == null ? "—" : String(v)) },
    { id: "taux", label: "Taux de couverture (cartes / membres)", court: "Taux de couverture", unite: "%",
        valeur: (a) => a.taux, format: (v) => (v == null ? "—" : `${v.toFixed(1)} %`) },
    { id: "densiteCartes", label: "Densite de cartes (par km²)", court: "Cartes / km²", unite: "carte(s)/km²",
        valeur: (a) => a.densiteCartes, format: (v) => (v == null ? "—" : v.toFixed(1)) },
    { id: "densiteMembres", label: "Densite de membres (par km²)", court: "Membres / km²", unite: "membre(s)/km²",
        valeur: (a) => a.densiteMembres, format: (v) => (v == null ? "—" : v.toFixed(1)) },
];
// Agrege les effectifs par cellule ou par section : membres, porteurs de
// carte, taux de couverture, superficie et densites.
function agregatsMassification(donnees, granularite) {
    const { membres, cellules, sections } = donnees;
    const source = granularite === "cellule" ? cellules : sections;
    return source.map(item => {
        const geometry = granularite === "cellule"
            ? (aUneGeometrie(item) ? item.geometry : null)
            : geometrieSection(item, cellules);
        const lies = membres.filter(m => granularite === "cellule" ? m.celluleId === item.id : m.sectionId === item.id);
        const porteurs = lies.filter(aCarteMembre);
        const superficieKm2 = geometry ? aireGeometrie(geometry) / 1e6 : null;
        return {
            id: item.id, entite: item, nom: item.nom, reference: item.reference, numero: item.numero,
            geometry,
            rattachement: granularite === "cellule"
                ? (sections.find(s => s.id === item.sectionId)?.nom || "—")
                : `${cellules.filter(c => c.sectionId === item.id).length} cellule(s)`,
            membres: lies.length,
            cartes: porteurs.length,
            sansCarte: lies.length - porteurs.length,
            hommes: porteurs.filter(m => m.sexe === "M").length,
            femmes: porteurs.filter(m => m.sexe === "F").length,
            taux: lies.length ? (porteurs.length / lies.length) * 100 : null,
            superficieKm2,
            densiteMembres: superficieKm2 ? lies.length / superficieKm2 : null,
            densiteCartes: superficieKm2 ? porteurs.length / superficieKm2 : null,
        };
    });
}
// Statistiques descriptives d'une serie de valeurs.
function statistiquesSerie(valeurs) {
    const v = valeurs.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
    if (!v.length)
        return null;
    const total = v.reduce((t, x) => t + x, 0);
    const mediane = v.length % 2
        ? v[(v.length - 1) / 2]
        : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
    return { n: v.length, total, moyenne: total / v.length, mediane, min: v[0], max: v[v.length - 1] };
}
// Bornes de classes par quantiles (5 classes au plus). Les quantiles
// resistent mieux aux valeurs extremes qu'un decoupage a intervalles egaux.
function bornesQuantiles(valeurs, nbClasses = 5) {
    const v = valeurs.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
    if (v.length < 2)
        return [];
    const bornes = [];
    for (let i = 1; i < nbClasses; i++)
        bornes.push(v[Math.floor(i * v.length / nbClasses)]);
    return [...new Set(bornes)].filter(b => b > v[0]).sort((a, b) => a - b);
}
function indiceClasse(valeur, bornes) {
    let i = 0;
    while (i < bornes.length && valeur >= bornes[i])
        i++;
    return i;
}
// Etale les classes sur la rampe : avec moins de 5 classes, on choisit des
// paliers regulierement espaces plutot que les premiers de la rampe.
function couleurClasse(indice, nbClasses) {
    if (nbClasses <= 1)
        return RAMPE_MASSIFICATION[RAMPE_MASSIFICATION.length - 1];
    const pas = Math.round(indice * (RAMPE_MASSIFICATION.length - 1) / (nbClasses - 1));
    return RAMPE_MASSIFICATION[Math.min(RAMPE_MASSIFICATION.length - 1, pas)];
}
function libelleClasse(indice, bornes, indicateur) {
    const f = (v) => indicateur.format(v);
    if (!bornes.length)
        return "Toutes les valeurs";
    if (indice === 0)
        return `moins de ${f(bornes[0])}`;
    if (indice === bornes.length)
        return `${f(bornes[bornes.length - 1])} et plus`;
    return `${f(bornes[indice - 1])} a ${f(bornes[indice])}`;
}
let sousOngletMassification = "cartes";
let carteAnalyseCtx = null;
async function renderMassificationView(container) {
    const mods = await modulesUtilisateurCourant();
    let peutCartes = mods.includes("massification.cartes");
    let peutSpatial = mods.includes("massification.spatial");
    // Si aucun sous-module n'est explicitement accorde, les deux le sont
    // (comptes crees avant cette fonctionnalite).
    if (!peutCartes && !peutSpatial) {
        peutCartes = true;
        peutSpatial = true;
    }
    if (sousOngletMassification === "cartes" && !peutCartes)
        sousOngletMassification = "spatial";
    if (sousOngletMassification === "spatial" && !peutSpatial)
        sousOngletMassification = "cartes";
    const donnees = await chargerDonneesCarto();
    const porteurs = donnees.membres.filter(aCarteMembre);
    const tauxGlobal = donnees.membres.length ? (porteurs.length / donnees.membres.length) * 100 : 0;
    const cellulesAvecCarte = donnees.cellules.filter(c => donnees.membres.some(m => m.celluleId === c.id && aCarteMembre(m))).length;
    container.innerHTML = `
    <div class="view-banner view-banner--green">
      <div class="view-banner__eyebrow">Croissance et implantation</div>
      <h2 class="view-banner__title">Massification</h2>
      <p class="view-banner__subtitle">Suivi des cartes de membre et analyse spatiale de leur repartition sur le territoire.</p>
    </div>
    <div class="stat-grid">
      <div class="stat-card stat-card--blue"><div class="stat-card__value">${donnees.membres.length}</div><div class="stat-card__label">Membres enregistres</div></div>
      <div class="stat-card stat-card--green"><div class="stat-card__value">${porteurs.length}</div><div class="stat-card__label">Cartes de membre</div></div>
      <div class="stat-card stat-card--amber"><div class="stat-card__value">${tauxGlobal.toFixed(1)} %</div><div class="stat-card__label">Taux de couverture</div></div>
      <div class="stat-card stat-card--slate"><div class="stat-card__value">${donnees.membres.length - porteurs.length}</div><div class="stat-card__label">Membres sans carte</div></div>
      <div class="stat-card"><div class="stat-card__value">${cellulesAvecCarte}/${donnees.cellules.length}</div><div class="stat-card__label">Cellules avec au moins une carte</div></div>
    </div>
    <div class="btn-group">
      ${peutCartes ? `<button type="button" class="btn ${sousOngletMassification === "cartes" ? "btn--primary" : "btn--ghost"}" id="onglet-massif-cartes">&#127915; Carte de membres (${porteurs.length})</button>` : ""}
      ${peutSpatial ? `<button type="button" class="btn ${sousOngletMassification === "spatial" ? "btn--primary" : "btn--ghost"}" id="onglet-massif-spatial">&#128506; Analyse spatiale</button>` : ""}
    </div>
    <div id="massif-content"></div>`;
    const contenu = $("#massif-content");
    const basculer = (onglet) => {
        sousOngletMassification = onglet;
        renderView();
    };
    if (peutCartes)
        $("#onglet-massif-cartes").addEventListener("click", () => basculer("cartes"));
    if (peutSpatial)
        $("#onglet-massif-spatial").addEventListener("click", () => basculer("spatial"));
    if (sousOngletMassification === "cartes")
        rendreOngletCartesMembres(contenu, donnees);
    else
        rendreOngletAnalyseSpatiale(contenu, donnees);
}
// ---------------- Onglet 1 : carte de membres ---------------------------
// Colonnes = toutes les informations de la fiche membre, restreintes aux
// seuls membres detenteurs d'une carte de membre.
const COLONNES_CARTE_MEMBRE = [
    { label: "N°", valeur: (m) => m.numero },
    { label: "N° carte membre", valeur: (m) => m.numeroCarteMembre || "—" },
    { label: "Reference", valeur: (m) => m.reference },
    { label: "Prenom & nom", valeur: (m) => nomComplet(m) },
    { label: "Sexe", valeur: (m) => m.sexe || "—" },
    { label: "Date de naissance", valeur: (m) => formatDateJJMMAAAA(m.dateNaissance) },
    { label: "Lieu de naissance", valeur: (m) => m.lieuNaissance || "—" },
    { label: "Telephone", valeur: (m) => m.telephone || "—" },
    { label: "Email", valeur: (m) => m.email || "—" },
    { label: "Departement", valeur: (m) => m.departement || "—" },
    { label: "Commune", valeur: (m) => m.commune || "—" },
    { label: "Quartier / Village", valeur: (m) => m.quartierVillage || "—" },
    { label: "Cellule", valeur: (m, ctx) => ctx.nomCellule(m.celluleId) },
    { label: "Section", valeur: (m, ctx) => ctx.nomSection(m.sectionId) },
    { label: "CNI delivree le", valeur: (m) => formatDateJJMMAAAA(m.dateDelivranceCNI) },
    { label: "CNI expire le", valeur: (m) => formatDateJJMMAAAA(m.dateExpirationCNI) },
    { label: "Electeur", valeur: (m) => m.electeur || "—" },
    { label: "Commune de vote", valeur: (m) => m.communeVote || "—" },
    { label: "N° electeur", valeur: (m) => m.numeroElecteur || "—" },
    { label: "Lieu de vote", valeur: (m) => m.lieuVote || "—" },
    { label: "Bureau de vote", valeur: (m) => m.bureauVote || "—" },
    { label: "Adhesion", valeur: (m) => m.adhesion || "—" },
    { label: "Annee d'adhesion", valeur: (m) => m.dateAdhesion || "—" },
    { label: "Fonction", valeur: (m) => m.fonction || "—" },
    { label: "Mouvements affilies", valeur: (m) => (m.mouvements || []).join(" ; ") || "—" },
    { label: "Poste au bureau", valeur: (m, ctx) => ctx.poste(m) },
];
function rendreOngletCartesMembres(contenu, donnees) {
    const { membres, cellules, sections } = donnees;
    const aide = {
        nomCellule: (id) => cellules.find(c => c.id === id)?.nom || "—",
        nomSection: (id) => sections.find(s => s.id === id)?.nom || "—",
        poste: (m) => {
            const cellule = cellules.find(c => c.id === m.celluleId);
            const posteCellule = cellule ? posteAuBureau(cellule, CELLULE_BUREAU_ROLES, m.id) : "—";
            if (posteCellule !== "—")
                return posteCellule;
            const section = sections.find(s => s.id === m.sectionId);
            return section ? posteAuBureau(section, SECTION_BUREAU_ROLES, m.id) : "—";
        },
    };
    const porteurs = membres.filter(aCarteMembre)
        .sort((a, b) => nomComplet(a).localeCompare(nomComplet(b), "fr"));
    const entetes = COLONNES_CARTE_MEMBRE.map(c => c.label);
    const ligneDe = (m) => COLONNES_CARTE_MEMBRE.map(c => String(c.valeur(m, aide) ?? ""));
    contenu.innerHTML = `
    <div class="filtre-bar">
      <label class="filtre-groupe" style="flex:1;min-width:200px;">
        <span>Rechercher</span>
        <input type="search" id="cm-recherche" placeholder="Nom, n° de carte, quartier, fonction...">
      </label>
      <label class="filtre-groupe">
        <span>Cellule</span>
        <select id="cm-cellule">
          <option value="">Toutes</option>
          ${cellules.slice().sort((a, b) => a.nom.localeCompare(b.nom, "fr")).map(c => `<option value="${c.id}">${escapeHtml(c.reference)}</option>`).join("")}
        </select>
      </label>
      <label class="filtre-groupe">
        <span>Section</span>
        <select id="cm-section">
          <option value="">Toutes</option>
          ${sections.slice().sort((a, b) => a.nom.localeCompare(b.nom, "fr")).map(s => `<option value="${s.id}">${escapeHtml(s.reference)}</option>`).join("")}
        </select>
      </label>
      <label class="filtre-groupe" style="min-width:110px;">
        <span>Sexe</span>
        <select id="cm-sexe"><option value="">Tous</option><option value="M">Masculin</option><option value="F">Feminin</option></select>
      </label>
      <div class="filtre-bar__actions">
        <button type="button" class="btn btn--ghost" id="cm-csv">&#8681; Exporter CSV</button>
        <button type="button" class="btn btn--primary" id="cm-pdf">&#128438; Exporter PDF</button>
      </div>
    </div>
    <p class="liste-resume" id="cm-resume"></p>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th></th>${entetes.map(h => `<th>${escapeHtml(h)}</th>`).join("")}<th></th></tr></thead>
        <tbody id="cm-tbody"></tbody>
      </table>
      <div id="cm-vide"></div>
    </div>`;
    const tbody = $("#cm-tbody");
    const vide = $("#cm-vide");
    const resume = $("#cm-resume");
    let filtres = [];
    function appliquerFiltres() {
        const q = $("#cm-recherche").value.trim().toLowerCase();
        const celluleId = Number($("#cm-cellule").value) || null;
        const sectionId = Number($("#cm-section").value) || null;
        const sexe = $("#cm-sexe").value;
        filtres = porteurs.filter(m => (!celluleId || m.celluleId === celluleId)
            && (!sectionId || m.sectionId === sectionId)
            && (!sexe || m.sexe === sexe)
            && (!q || ligneDe(m).join(" ").toLowerCase().includes(q)));
        dessiner();
    }
    function dessiner() {
        const h = filtres.filter(m => m.sexe === "M").length;
        const f = filtres.filter(m => m.sexe === "F").length;
        resume.innerHTML = `<b>${filtres.length}</b> carte(s) de membre affichee(s) sur ${porteurs.length}
      &middot; ${h} homme(s), ${f} femme(s)
      &middot; ${filtres.filter(m => !m.numeroCarteMembre).length} sans numero de carte renseigne`;
        tbody.innerHTML = filtres.map(m => `
      <tr class="data-row--clickable" data-membre="${m.id}">
        <td>${avatarHtml(m.photoDataUrl, nomComplet(m), "sm")}</td>
        ${ligneDe(m).map(v => `<td>${escapeHtml(v)}</td>`).join("")}
        <td class="row-actions">
          <button class="icon-btn" data-localiser="${m.id}" title="Recherche geographique — localiser sur la carte">&#127757;</button>
        </td>
      </tr>`).join("");
        vide.innerHTML = filtres.length ? "" : emptyState("Aucune carte de membre ne correspond aux filtres.");
        tbody.querySelectorAll("[data-membre]").forEach(tr => tr.addEventListener("click", (e) => {
            if (e.target.closest(".row-actions"))
                return;
            const m = porteurs.find(x => x.id === Number(tr.dataset.membre));
            if (m)
                ouvrirFicheMembreModale(m, aide);
        }));
        tbody.querySelectorAll("[data-localiser]").forEach(b => b.addEventListener("click", () => ouvrirRechercheGeographique("membre", Number(b.dataset.localiser))));
    }
    ["#cm-recherche", "#cm-cellule", "#cm-section", "#cm-sexe"].forEach(sel => {
        const champ = $(sel);
        champ.addEventListener(champ.tagName === "SELECT" ? "change" : "input", appliquerFiltres);
    });
    appliquerFiltres();
    $("#cm-csv").addEventListener("click", () => {
        if (!filtres.length) {
            toast("Aucune carte de membre a exporter.", "info");
            return;
        }
        exporterCSV("cartes_de_membre.csv", entetes, filtres.map(ligneDe));
    });
    $("#cm-pdf").addEventListener("click", () => {
        if (!filtres.length) {
            toast("Aucune carte de membre a exporter.", "info");
            return;
        }
        const h = filtres.filter(m => m.sexe === "M").length;
        const f = filtres.filter(m => m.sexe === "F").length;
        exporterPDF("Cartes de membre", `
      <div class="pdf-resume">
        <div class="pdf-tuile"><b>${filtres.length}</b><span>Cartes de membre</span></div>
        <div class="pdf-tuile"><b>${h}</b><span>Hommes</span></div>
        <div class="pdf-tuile"><b>${f}</b><span>Femmes</span></div>
        <div class="pdf-tuile"><b>${membres.length}</b><span>Membres au total</span></div>
      </div>
      <h2>Liste des detenteurs d'une carte de membre (${filtres.length})</h2>
      ${tableauPDF(entetes, filtres.map(ligneDe))}`, "landscape");
    });
}
// Fiche membre en lecture seule, ouverte sans quitter le module.
function ouvrirFicheMembreModale(membre, aide) {
    const ligne = (label, valeur) => `<div class="fiche-row"><span class="fiche-row__label">${escapeHtml(label)}</span><span class="fiche-row__value">${escapeHtml(String(valeur ?? "")) || "—"}</span></div>`;
    ouvrirModale({
        titre: `Fiche membre — ${membre.reference}`,
        taille: "wide",
        contenuHtml: `
      <div class="fiche-header">
        ${avatarHtml(membre.photoDataUrl, nomComplet(membre), "xl")}
        <div>
          <div class="fiche-header__name">${escapeHtml(nomComplet(membre))}</div>
          <div class="fiche-header__sub">${escapeHtml(membre.fonction || "")}</div>
          <div class="fiche-header__alerts"><span class="badge badge--success">Carte n° ${escapeHtml(membre.numeroCarteMembre || "non renseigne")}</span></div>
        </div>
      </div>
      <div class="liste-outils">
        <button type="button" class="btn btn--ghost" id="fm-localiser">&#127757; Recherche geographique</button>
      </div>
      <div class="fiche-grid">
        ${COLONNES_CARTE_MEMBRE.map(c => ligne(c.label, c.valeur(membre, aide))).join("")}
      </div>`,
        onMonte: (contenu) => {
            contenu.querySelector("#fm-localiser").addEventListener("click", () => ouvrirRechercheGeographique("membre", membre.id));
        },
    });
}
// ---------------- Onglet 2 : analyse spatiale ---------------------------
let etatAnalyse = { granularite: "cellule", indicateur: "cartes", comparaison: "plus", seuil: "" };
function rendreOngletAnalyseSpatiale(contenu, donnees) {
    const indicateur = INDICATEURS_MASSIFICATION.find(i => i.id === etatAnalyse.indicateur) || INDICATEURS_MASSIFICATION[0];
    contenu.innerHTML = `
    <div class="filtre-bar">
      <label class="filtre-groupe">
        <span>Niveau d'analyse</span>
        <select id="an-granularite">
          <option value="cellule" ${etatAnalyse.granularite === "cellule" ? "selected" : ""}>Cellules</option>
          <option value="section" ${etatAnalyse.granularite === "section" ? "selected" : ""}>Sections</option>
        </select>
      </label>
      <label class="filtre-groupe" style="min-width:250px;">
        <span>Indicateur cartographie</span>
        <select id="an-indicateur">
          ${INDICATEURS_MASSIFICATION.map(i => `<option value="${i.id}" ${i.id === indicateur.id ? "selected" : ""}>${escapeHtml(i.label)}</option>`).join("")}
        </select>
      </label>
      <label class="filtre-groupe">
        <span>Filtre de seuil</span>
        <select id="an-comparaison">
          <option value="plus" ${etatAnalyse.comparaison === "plus" ? "selected" : ""}>Plus de</option>
          <option value="moins" ${etatAnalyse.comparaison === "moins" ? "selected" : ""}>Moins de</option>
        </select>
      </label>
      <label class="filtre-groupe" style="min-width:120px;">
        <span>Valeur seuil</span>
        <input type="number" id="an-seuil" step="any" min="0" placeholder="aucun" value="${escapeHtml(etatAnalyse.seuil)}">
      </label>
      <div class="filtre-bar__actions">
        <button type="button" class="btn btn--ghost" id="an-reinit">Reinitialiser</button>
        <button type="button" class="btn btn--ghost" id="an-csv">&#8681; CSV</button>
        <button type="button" class="btn btn--primary" id="an-pdf">&#128438; PDF</button>
      </div>
    </div>
    <div class="analyse-grille">
      <div class="analyse-panneau">
        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Statistiques</h4>
          <div class="stat-liste" id="an-stats"></div>
        </div>
        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Legende — <span id="an-legende-titre"></span></h4>
          <div id="an-legende"></div>
        </div>
        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Classement</h4>
          <div class="leaderboard" id="an-classement"></div>
        </div>
      </div>
      <div>
        <div class="analyse-carte" id="an-carte"></div>
        <h3 class="tableau-titre">Tableau des donnees</h3>
        <p class="tableau-note" id="an-note"></p>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr id="an-thead"></tr></thead>
            <tbody id="an-tbody"></tbody>
          </table>
          <div id="an-vide"></div>
        </div>
      </div>
    </div>`;
    // Etat courant recalcule a chaque changement de filtre.
    let agregats = [];
    let bornes = [];
    let nbClasses = 1;
    let retenues = new Set();
    const seuilNumerique = () => {
        const v = parseFloat(etatAnalyse.seuil);
        return isFinite(v) ? v : null;
    };
    function recalculer() {
        agregats = agregatsMassification(donnees, etatAnalyse.granularite);
        const ind = INDICATEURS_MASSIFICATION.find(i => i.id === etatAnalyse.indicateur);
        const valeurs = agregats.map(a => ind.valeur(a));
        bornes = bornesQuantiles(valeurs);
        nbClasses = bornes.length + 1;
        const seuil = seuilNumerique();
        retenues = new Set(agregats.filter(a => {
            const v = ind.valeur(a);
            if (seuil == null)
                return true;
            if (v == null)
                return false;
            return etatAnalyse.comparaison === "plus" ? v > seuil : v < seuil;
        }).map(a => a.id));
        return ind;
    }
    function dessinerTout() {
        const ind = recalculer();
        const seuil = seuilNumerique();
        const valeursRetenues = agregats.filter(a => retenues.has(a.id)).map(a => ind.valeur(a));
        const stats = statistiquesSerie(valeursRetenues);
        const statsGlobales = statistiquesSerie(agregats.map(a => ind.valeur(a)));
        const sansGeometrie = agregats.filter(a => !a.geometry).length;
        const libelleNiveau = etatAnalyse.granularite === "cellule" ? "cellules" : "sections";
        // --- Statistiques ------------------------------------------------
        const l = (label, valeur) => `<div class="stat-liste__ligne"><span>${escapeHtml(label)}</span><b>${valeur}</b></div>`;
        $("#an-stats").innerHTML = [
            l(`${libelleNiveau.charAt(0).toUpperCase() + libelleNiveau.slice(1)} analysees`, `${retenues.size} / ${agregats.length}`),
            stats ? l(`Total (${ind.unite})`, ind.id === "taux" ? "—" : ind.format(stats.total)) : "",
            stats ? l("Moyenne", ind.format(stats.moyenne)) : "",
            stats ? l("Mediane", ind.format(stats.mediane)) : "",
            stats ? l("Minimum", ind.format(stats.min)) : "",
            stats ? l("Maximum", ind.format(stats.max)) : "",
            statsGlobales && stats && stats.n !== statsGlobales.n
                ? l("Maximum (sans filtre)", ind.format(statsGlobales.max)) : "",
            l("Membres au total", agregats.reduce((t, a) => t + a.membres, 0)),
            l("Cartes de membre", agregats.reduce((t, a) => t + a.cartes, 0)),
            l("Porteurs H / F", `${agregats.reduce((t, a) => t + a.hommes, 0)} / ${agregats.reduce((t, a) => t + a.femmes, 0)}`),
            sansGeometrie ? l("Sans geometrie (hors carte)", sansGeometrie) : "",
        ].filter(Boolean).join("");
        // --- Legende ------------------------------------------------------
        $("#an-legende-titre").textContent = ind.court;
        const comptesParClasse = new Array(nbClasses).fill(0);
        for (const a of agregats) {
            const v = ind.valeur(a);
            if (v == null || !retenues.has(a.id))
                continue;
            comptesParClasse[indiceClasse(v, bornes)]++;
        }
        $("#an-legende").innerHTML = comptesParClasse.map((n, i) => `
      <div class="carte-legende__item">
        <span class="carte-pastille" style="background:${couleurClasse(i, nbClasses)};border-color:${couleurClasse(i, nbClasses)};"></span>
        ${escapeHtml(libelleClasse(i, bornes, ind))}
        <span class="classe-compte">${n}</span>
      </div>`).join("")
            + `<div class="carte-legende__item">
           <span class="carte-pastille" style="background:${COULEUR_HORS_FILTRE};border-color:${COULEUR_HORS_FILTRE};"></span>
           ${seuil == null ? "Sans donnee" : "Hors filtre"}
           <span class="classe-compte">${agregats.filter(a => a.geometry && !retenues.has(a.id)).length}</span>
         </div>
         <p class="carte-note">Classes calculees par quantiles sur l'indicateur choisi. Toutes les valeurs sont egalement lisibles dans le tableau ci-contre.</p>`;
        // --- Classement ---------------------------------------------------
        const classement = agregats
            .filter(a => ind.valeur(a) != null)
            .sort((a, b) => ind.valeur(b) - ind.valeur(a))
            .slice(0, 8);
        const maxClassement = Math.max(1, ...classement.map(a => ind.valeur(a)));
        $("#an-classement").innerHTML = classement.length ? classement.map((a, i) => `
      <div class="leaderboard-row" data-zoom="${a.id}" style="cursor:pointer;">
        <div class="leaderboard-row__rank leaderboard-row__rank--${i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "default"}">${i + 1}</div>
        <div class="leaderboard-row__info">
          <div class="leaderboard-row__name">${escapeHtml(a.nom)}</div>
          <div class="leaderboard-row__meta">${escapeHtml(a.reference)}</div>
        </div>
        <div class="leaderboard-row__bar"><div class="leaderboard-row__bar-fill" style="width:${(ind.valeur(a) / maxClassement) * 100}%"></div></div>
        <div class="leaderboard-row__count">${escapeHtml(ind.format(ind.valeur(a)))}</div>
      </div>`).join("") : emptyState("Aucune donnee a classer.");
        $("#an-classement").querySelectorAll("[data-zoom]").forEach(row => row.addEventListener("click", () => {
            if (carteAnalyseCtx)
                localiserSurCarte(carteAnalyseCtx, etatAnalyse.granularite, Number(row.dataset.zoom));
        }));
        // --- Tableau (equivalent textuel de la carte) ----------------------
        const colonnes = ["N°", "Reference", "Nom",
            etatAnalyse.granularite === "cellule" ? "Section" : "Cellules",
            "Membres", "Cartes", "Sans carte", "Taux", "Superficie (km²)", "Membres/km²", "Cartes/km²", "Statut"];
        $("#an-thead").innerHTML = colonnes.map((c, i) => `<th${i >= 4 && i < 11 ? ' class="num"' : ""}>${escapeHtml(c)}</th>`).join("");
        const lignes = agregats
            .slice()
            .sort((a, b) => (ind.valeur(b) ?? -Infinity) - (ind.valeur(a) ?? -Infinity));
        $("#an-tbody").innerHTML = lignes.map(a => `
      <tr class="${retenues.has(a.id) ? "" : "ligne-hors-filtre"}">
        <td>${a.numero}</td>
        <td><span class="ref-badge">${escapeHtml(a.reference)}</span></td>
        <td>${escapeHtml(a.nom)}</td>
        <td>${escapeHtml(a.rattachement)}</td>
        <td class="num">${a.membres}</td>
        <td class="num">${a.cartes}</td>
        <td class="num">${a.sansCarte}</td>
        <td class="num">${a.taux == null ? "—" : a.taux.toFixed(1) + " %"}</td>
        <td class="num">${a.superficieKm2 == null ? "—" : a.superficieKm2.toFixed(3)}</td>
        <td class="num">${a.densiteMembres == null ? "—" : a.densiteMembres.toFixed(1)}</td>
        <td class="num">${a.densiteCartes == null ? "—" : a.densiteCartes.toFixed(1)}</td>
        <td>${!a.geometry ? `<span class="badge badge--muted">Sans geometrie</span>`
            : retenues.has(a.id) ? `<span class="badge badge--success">Retenue</span>`
                : `<span class="badge badge--warn">Hors filtre</span>`}</td>
      </tr>`).join("");
        $("#an-vide").innerHTML = lignes.length ? "" : emptyState(`Aucune ${etatAnalyse.granularite} enregistree.`);
        $("#an-note").textContent = seuil == null
            ? `Toutes les ${libelleNiveau} sont affichees. Definissez une valeur seuil pour isoler celles qui ont plus de (ou moins de) ${ind.court.toLowerCase()}.`
            : `${retenues.size} ${libelleNiveau} ${etatAnalyse.comparaison === "plus" ? "au-dessus de" : "en-dessous de"} ${ind.format(seuil)} — les autres restent listees, grisees.`;
        // --- Carte ----------------------------------------------------------
        majCarteAnalyse(ind);
    }
    function majCarteAnalyse(ind) {
        if (!carteAnalyseCtx)
            return;
        const parId = new Map(agregats.map(a => [a.id, a]));
        carteAnalyseCtx.styleThematique = (kind, entite) => {
            if (kind !== etatAnalyse.granularite)
                return { fillColor: "#94A3B8", fillOpacity: 0, color: "#94A3B8", weight: 0.8, opacity: 0.5 };
            const a = parId.get(entite.id);
            const v = a ? ind.valeur(a) : null;
            if (v == null || !retenues.has(entite.id))
                return { fillColor: COULEUR_HORS_FILTRE, fillOpacity: 0.55 };
            return { fillColor: couleurClasse(indiceClasse(v, bornes), nbClasses), fillOpacity: 0.85 };
        };
        carteAnalyseCtx.texteSurvol = (kind, entite) => {
            if (kind !== etatAnalyse.granularite)
                return null;
            const a = parId.get(entite.id);
            if (!a)
                return null;
            return `<b>${escapeHtml(a.nom)}</b><br>${escapeHtml(ind.court)} : ${escapeHtml(ind.format(ind.valeur(a)))}<br>${a.membres} membre(s) · ${a.cartes} carte(s)`;
        };
        carteAnalyseCtx.lignesInfobulle = (kind, entite) => {
            const a = parId.get(entite.id);
            if (!a || kind !== etatAnalyse.granularite)
                return "";
            return `<div class="popup-ligne"><span>Cartes de membre</span><span>${a.cartes}</span></div>
              <div class="popup-ligne"><span>Taux de couverture</span><span>${a.taux == null ? "—" : a.taux.toFixed(1) + " %"}</span></div>
              <div class="popup-ligne"><span>${escapeHtml(ind.court)}</span><span>${escapeHtml(ind.format(ind.valeur(a)))}</span></div>`;
        };
        // Seul le niveau analyse est mis en avant : l'autre couche est retiree
        // pour que la lecture de la carte de densite reste sans ambiguite.
        if (etatAnalyse.granularite === "cellule") {
            carteAnalyseCtx.coucheCellules.addTo(carteAnalyseCtx.map);
            carteAnalyseCtx.map.removeLayer(carteAnalyseCtx.coucheSections);
        }
        else {
            carteAnalyseCtx.coucheSections.addTo(carteAnalyseCtx.map);
            carteAnalyseCtx.map.removeLayer(carteAnalyseCtx.coucheCellules);
        }
        rafraichirStylesCarto(carteAnalyseCtx);
    }
    // Montage de la carte (fond clair par defaut : une carte thematique se lit
    // mieux sur un fond neutre).
    const hote = $("#an-carte");
    if (cartoDisponible()) {
        carteAnalyseCtx = creerCarteSGBD(hote, donnees, { fondParDefaut: 4 });
        // Carte thematique : les etiquettes surchargeraient la lecture des
        // aplats de densite.
        carteAnalyseCtx.afficherEtiquettes = false;
        dessinerCouchesCarto(carteAnalyseCtx);
        const empriseGlobale = agregatsMassification(donnees, etatAnalyse.granularite)
            .filter(a => a.geometry)
            .map(a => empriseGeometrie(a.geometry));
        if (empriseGlobale.length) {
            const bounds = L.latLngBounds(empriseGlobale.flat());
            setTimeout(() => carteAnalyseCtx?.map.fitBounds(bounds, { padding: [30, 30] }), 250);
        }
    }
    else {
        hote.innerHTML = emptyState("Moteur cartographique indisponible : le tableau et les statistiques restent utilisables.");
    }
    // Branchements des filtres (une seule rangee, au-dessus de tout ce qu'ils
    // filtrent : carte, statistiques, legende, classement et tableau).
    const surChangement = () => {
        etatAnalyse.granularite = $("#an-granularite").value;
        etatAnalyse.indicateur = $("#an-indicateur").value;
        etatAnalyse.comparaison = $("#an-comparaison").value;
        etatAnalyse.seuil = $("#an-seuil").value;
        dessinerTout();
    };
    $("#an-granularite").addEventListener("change", surChangement);
    $("#an-indicateur").addEventListener("change", surChangement);
    $("#an-comparaison").addEventListener("change", surChangement);
    $("#an-seuil").addEventListener("input", surChangement);
    $("#an-reinit").addEventListener("click", () => {
        etatAnalyse = { granularite: "cellule", indicateur: "cartes", comparaison: "plus", seuil: "" };
        renderView();
    });
    // --- Exports ---------------------------------------------------------
    const donneesExportAnalyse = () => {
        const ind = INDICATEURS_MASSIFICATION.find(i => i.id === etatAnalyse.indicateur);
        const entetes = ["N°", "Reference", "Nom",
            etatAnalyse.granularite === "cellule" ? "Section" : "Cellules",
            "Membres", "Cartes de membre", "Membres sans carte", "Taux de couverture",
            "Superficie (km²)", "Membres/km²", "Cartes/km²", "Statut"];
        const lignes = agregats
            .slice()
            .sort((a, b) => (ind.valeur(b) ?? -Infinity) - (ind.valeur(a) ?? -Infinity))
            .map(a => [a.numero, a.reference, a.nom, a.rattachement, a.membres, a.cartes, a.sansCarte,
            a.taux == null ? "—" : a.taux.toFixed(1) + " %",
            a.superficieKm2 == null ? "—" : a.superficieKm2.toFixed(3),
            a.densiteMembres == null ? "—" : a.densiteMembres.toFixed(1),
            a.densiteCartes == null ? "—" : a.densiteCartes.toFixed(1),
            !a.geometry ? "Sans geometrie" : retenues.has(a.id) ? "Retenue" : "Hors filtre"]);
        return { ind, entetes, lignes };
    };
    $("#an-csv").addEventListener("click", () => {
        const { entetes, lignes } = donneesExportAnalyse();
        if (!lignes.length) {
            toast("Aucune donnee a exporter.", "info");
            return;
        }
        exporterCSV(`analyse_spatiale_${etatAnalyse.granularite}s.csv`, entetes, lignes);
    });
    $("#an-pdf").addEventListener("click", () => {
        const { ind, entetes, lignes } = donneesExportAnalyse();
        if (!lignes.length) {
            toast("Aucune donnee a exporter.", "info");
            return;
        }
        const seuil = seuilNumerique();
        const entrees = agregats.filter(a => a.geometry).map(a => {
            const v = ind.valeur(a);
            const dedans = v != null && retenues.has(a.id);
            return {
                geometry: a.geometry,
                remplissage: dedans ? couleurClasse(indiceClasse(v, bornes), nbClasses) : COULEUR_HORS_FILTRE,
                opacite: dedans ? 0.85 : 0.5,
                couleur: "#FFFFFF",
                epaisseur: 1.1,
                label: a.nom,
            };
        });
        const legende = [];
        for (let i = 0; i < nbClasses; i++)
            legende.push({ label: libelleClasse(i, bornes, ind), couleur: couleurClasse(i, nbClasses), remplissage: couleurClasse(i, nbClasses) });
        legende.push({ label: seuil == null ? "Sans donnee" : "Hors filtre", couleur: COULEUR_HORS_FILTRE, remplissage: COULEUR_HORS_FILTRE });
        const stats = statistiquesSerie(agregats.filter(a => retenues.has(a.id)).map(a => ind.valeur(a)));
        const libelleNiveau = etatAnalyse.granularite === "cellule" ? "cellules" : "sections";
        exporterPDF(`Analyse spatiale — ${ind.label}`, `
      <div class="pdf-resume">
        <div class="pdf-tuile"><b>${agregats.reduce((t, a) => t + a.membres, 0)}</b><span>Membres</span></div>
        <div class="pdf-tuile"><b>${agregats.reduce((t, a) => t + a.cartes, 0)}</b><span>Cartes de membre</span></div>
        <div class="pdf-tuile"><b>${retenues.size}/${agregats.length}</b><span>${escapeHtml(libelleNiveau)} retenues</span></div>
        ${stats ? `<div class="pdf-tuile"><b>${escapeHtml(ind.format(stats.moyenne))}</b><span>Moyenne</span></div>
        <div class="pdf-tuile"><b>${escapeHtml(ind.format(stats.mediane))}</b><span>Mediane</span></div>
        <div class="pdf-tuile"><b>${escapeHtml(ind.format(stats.max))}</b><span>Maximum</span></div>` : ""}
      </div>
      <p><b>Filtre applique :</b> ${seuil == null ? "aucun seuil" : `${escapeHtml(libelleNiveau)} ayant ${etatAnalyse.comparaison === "plus" ? "plus de" : "moins de"} ${escapeHtml(ind.format(seuil))}`}
      &middot; <b>Indicateur :</b> ${escapeHtml(ind.label)}</p>
      ${entrees.length ? blocCartePDF(`Carte de densite — ${ind.label}`, entrees, legende)
            : `<p><i>Aucune geometrie disponible : la carte ne peut pas etre representee.</i></p>`}
      <h2>Donnees par ${escapeHtml(libelleNiveau.slice(0, -1))}</h2>
      ${tableauPDF(entetes, lignes)}`, "landscape");
    });
    dessinerTout();
}
// ------------------------------------------------------------------------
// 20. MODULE CARTE ELECTORALE
//
// Importe la carte electorale (lieux et bureaux de vote avec leurs inscrits),
// la croise avec les fiches Membre (via Lieu de vote + Bureau de vote) et
// exploite les resultats de scrutins pour analyser la situation electorale :
// participation, classement des candidats, bureaux gagnes / perdus,
// penetration des membres et primo-votants.
// ------------------------------------------------------------------------
const TYPES_ELECTION = ["Locale", "Legislative", "Presidentielle"];
// Cle de rapprochement entre un bureau de la carte electorale et la fiche
// d'un membre : nom du lieu de vote normalise + numero de bureau sur 2
// chiffres. C'est ce qui permet de correler les deux sources.
function cleBureauVote(lieuVote, numeroBureau) {
    const num = String(numeroBureau ?? "").replace(/\D/g, "");
    return `${cleNom(lieuVote)}|${num.padStart(2, "0")}`;
}
function cleBureauMembre(m) {
    return cleBureauVote(m.lieuVote, m.bureauVote);
}
function libelleBureau(b) {
    return `${b.lieuVote} — bureau ${b.numeroBureau}`;
}
// Annee des 18 ans d'un membre.
function anneeMajorite(dateNaissance) {
    const d = new Date(dateNaissance);
    return isNaN(d.getTime()) ? null : d.getFullYear() + 18;
}
// Primo-votant pour un scrutin : electeur inscrit ayant atteint 18 ans APRES
// le scrutin precedent de meme type — il n'avait donc pas pu voter alors.
// Meme critere d'age, sans condition sur l'inscription : sert a l'onglet
// Primo-votants pour distinguer les inscrits des pas encore inscrits.
function atteintMajoriteEntre(m, anneeScrutin, anneePrecedente) {
    const a = anneeMajorite(m.dateNaissance);
    return a != null && a > anneePrecedente && a <= anneeScrutin;
}
function estPrimoVotant(m, anneeScrutin, anneePrecedente) {
    if (m.electeur !== "Oui")
        return false;
    const a = anneeMajorite(m.dateNaissance);
    return a != null && a > anneePrecedente && a <= anneeScrutin;
}
// Annee du scrutin precedent de meme type ; a defaut, cinq ans avant.
function anneeScrutinPrecedent(election, elections) {
    const memes = elections
        .filter(e => e.type === election.type && e.annee < election.annee)
        .sort((a, b) => b.annee - a.annee);
    return memes.length ? memes[0].annee : election.annee - 5;
}
function libelleElection(e) {
    return `${e.type} ${e.annee}${e.type === "Presidentielle" && e.tour ? ` — ${e.tour}` : ""}${e.libelle ? ` (${e.libelle})` : ""}`;
}
async function chargerDonneesElectorales() {
    const [membres, cellules, sections, bureaux, elections, depouillements, resultats] = await Promise.all([
        db.membres.toArray(), db.cellules.toArray(), db.sections.toArray(),
        db.bureauxVote.toArray(), db.elections.toArray(),
        db.depouillements.toArray(), db.resultats.toArray(),
    ]);
    return { membres, cellules, sections, bureaux, elections, depouillements, resultats };
}
// Regroupe les membres par bureau de vote (cle lieu|bureau).
function indexerMembresParBureau(membres) {
    const index = new Map();
    for (const m of membres) {
        if (!m.lieuVote || !m.bureauVote)
            continue;
        const cle = cleBureauMembre(m);
        if (!index.has(cle))
            index.set(cle, []);
        index.get(cle).push(m);
    }
    return index;
}
// Analyse complete d'un scrutin, bureau par bureau.
function analyserElection(election, d) {
    const index = indexerMembresParBureau(d.membres);
    const anneePrecedente = anneeScrutinPrecedent(election, d.elections);
    const refCle = cleNom(election.candidatReference || "");
    const lignes = d.bureaux.map(bureau => {
        const brut = d.resultats
            .filter(r => r.electionId === election.id && r.bureauId === bureau.id)
            .sort((x, y) => y.voix - x.voix);
        const dep = d.depouillements.find(x => x.electionId === election.id && x.bureauId === bureau.id);
        const exprimes = dep?.exprimes ?? brut.reduce((t, r) => t + r.voix, 0);
        const inscrits = dep?.inscrits ?? bureau.inscrits ?? 0;
        const nuls = dep?.nuls ?? 0;
        const votants = dep?.votants ?? (exprimes + nuls);
        const classement = brut.map((r, i) => ({
            candidat: r.candidat, parti: r.parti || "", voix: r.voix,
            rang: i + 1, part: exprimes ? (r.voix / exprimes) * 100 : null,
        }));
        const gagnant = classement[0] || null;
        const reference = refCle
            ? classement.find(c => cleNom(c.candidat) === refCle || cleNom(c.parti) === refCle) || null
            : null;
        const membresBureau = index.get(bureau.cle) || [];
        return {
            bureau, depouille: classement.length > 0,
            classement, gagnant, reference,
            gagne: classement.length && reference ? reference.rang === 1 : null,
            // Marge : avance sur le 2e si le bureau est gagne, retard sur le 1er sinon.
            ecart: reference && gagnant
                ? (reference.rang === 1 ? reference.voix - (classement[1]?.voix ?? 0) : reference.voix - gagnant.voix)
                : null,
            inscrits, votants, nuls, exprimes,
            participation: inscrits ? (votants / inscrits) * 100 : null,
            membres: membresBureau.length,
            porteursCarte: membresBureau.filter(aCarteMembre).length,
            primoVotants: membresBureau.filter(m => estPrimoVotant(m, election.annee, anneePrecedente)).length,
            penetration: inscrits ? (membresBureau.length / inscrits) * 100 : null,
        };
    });
    return { lignes, anneePrecedente };
}
// Classement des candidats consolide sur l'ensemble des bureaux depouilles.
function classementGlobalElection(election, d) {
    const cumul = new Map();
    for (const r of d.resultats) {
        if (r.electionId !== election.id)
            continue;
        const cle = cleNom(r.candidat);
        const e = cumul.get(cle) || { candidat: r.candidat, parti: r.parti || "", voix: 0, bureaux: 0 };
        e.voix += r.voix;
        e.bureaux++;
        cumul.set(cle, e);
    }
    const liste = [...cumul.values()].sort((a, b) => b.voix - a.voix);
    const somme = liste.reduce((t, c) => t + c.voix, 0);
    return liste.map((c, i) => ({ ...c, rang: i + 1, part: somme ? (c.voix / somme) * 100 : 0 }));
}
// ---- Fenetre d'import CSV generique (carte electorale / resultats) ------
function ouvrirImportCSV({ titre, note, nomModele, contenuModele, colonnesApercu, analyser, confirmer, apresImport }) {
    ouvrirModale({
        titre,
        taille: "wide",
        contenuHtml: `
      <p class="form-note">${note}</p>
      <div class="liste-outils">
        <button type="button" class="btn btn--ghost" id="imp-modele">&#8681; Telecharger le modele CSV</button>
      </div>
      <label class="field field--full" style="margin-bottom:10px;">
        <span>Fichier CSV</span>
        <input type="file" accept=".csv,text/csv" id="imp-fichier">
      </label>
      <div id="imp-apercu"></div>
      <div class="modal__actions" style="position:static;margin:14px 0 0;padding-top:14px;">
        <button type="button" class="btn btn--ghost" id="imp-annuler">Annuler</button>
        <button type="button" class="btn btn--primary" id="imp-confirmer" disabled>Confirmer l'import</button>
      </div>`,
        onMonte: (contenu, fermer) => {
            const apercu = contenu.querySelector("#imp-apercu");
            const btnConfirmer = contenu.querySelector("#imp-confirmer");
            let lignes = [];
            contenu.querySelector("#imp-modele").addEventListener("click", () => telechargerFichierTexte(nomModele, contenuModele()));
            contenu.querySelector("#imp-annuler").addEventListener("click", fermer);
            contenu.querySelector("#imp-fichier").addEventListener("change", async (e) => {
                lignes = [];
                btnConfirmer.disabled = true;
                const fichier = e.target.files?.[0];
                if (!fichier) {
                    apercu.innerHTML = "";
                    return;
                }
                const rows = parseCSV(await fichier.text());
                if (rows.length < 2) {
                    apercu.innerHTML = `<p class="form-note form-note--warn">Fichier vide, ou aucune ligne de donnees apres l'en-tete.</p>`;
                    return;
                }
                const resultat = await analyser(rows);
                if (resultat.erreur) {
                    apercu.innerHTML = `<p class="form-note form-note--warn">${escapeHtml(resultat.erreur)}</p>`;
                    return;
                }
                lignes = resultat.lignes;
                const valides = lignes.filter(l => !l.error).length;
                const rejetees = lignes.length - valides;
                // Le tableau d'apercu est plafonne a 400 lignes pour rester
                // fluide sur de gros fichiers (ex. 15 000+ lignes) — mais les
                // lignes REJETEES doivent rester consultables/exportables en
                // entier, sans quoi une erreur situee apres la ligne 400
                // resterait invisible et incomprise ("pourquoi X lignes
                // manquent-elles a l'import ?").
                apercu.innerHTML = `
          <p class="form-note ${valides === 0 ? "form-note--warn" : ""}">${valides} ligne(s) valide(s) sur ${lignes.length}${rejetees ? ` — <b>${rejetees} ligne(s) rejetee(s)</b>` : ""}.</p>
          ${rejetees ? `<div class="liste-outils"><button type="button" class="btn btn--ghost" id="imp-erreurs-csv">&#8681; Telecharger les ${rejetees} ligne(s) rejetee(s) (CSV)</button></div>` : ""}
          <div class="table-wrap" style="max-height:300px;">
            <table class="data-table">
              <thead><tr>${colonnesApercu.map(c => `<th>${escapeHtml(c)}</th>`).join("")}<th>Statut</th></tr></thead>
              <tbody>${lignes.slice(0, 400).map(l => `<tr>
                ${l.apercu.map(v => `<td>${escapeHtml(String(v ?? ""))}</td>`).join("")}
                <td>${l.error ? `<span class="badge badge--warn" title="${escapeHtml(l.error)}">${escapeHtml(l.error)}</span>` : `<span class="badge badge--success">OK</span>`}</td>
              </tr>`).join("")}</tbody>
            </table>
          </div>
          ${lignes.length > 400 ? `<p class="carte-note">Apercu limite aux 400 premieres lignes ; l'import traitera l'ensemble du fichier${rejetees ? " (utilisez le bouton ci-dessus pour voir TOUTES les lignes rejetees, meme au-dela de la 400e)" : ""}.</p>` : ""}`;
                btnConfirmer.disabled = valides === 0;
                contenu.querySelector("#imp-erreurs-csv")?.addEventListener("click", () => {
                    const enErreur = lignes.filter(l => l.error);
                    exporterCSV(
                        (nomModele || "import").replace(/\.csv$/i, "") + "_lignes_rejetees.csv",
                        [...colonnesApercu, "Motif du rejet"],
                        enErreur.map(l => [...l.apercu, l.error]),
                    );
                });
            });
            btnConfirmer.addEventListener("click", async () => {
                btnConfirmer.disabled = true;
                btnConfirmer.textContent = "Import en cours...";
                const valides = lignes.filter(l => !l.error);
                const rejetees = lignes.length - valides.length;
                const message = await confirmer(valides);
                toast(rejetees ? `${message} (${rejetees} ligne(s) rejetee(s) sur ${lignes.length} — telechargez le detail avant de fermer si besoin).` : message, "success");
                fermer();
                await apresImport?.();
            });
        },
    });
}
// ------------------------------------------------------------------------
let sousOngletElectorale = "bureaux";
let electionSelectionnee = null;
async function renderElectoraleView(container) {
    const mods = await modulesUtilisateurCourant();
    const autorises = {
        bureaux: mods.includes("electorale.bureaux"),
        elections: mods.includes("electorale.elections"),
        analyse: mods.includes("electorale.analyse"),
        primo: mods.includes("electorale.primo"),
        trouver: mods.includes("electorale.trouver"),
    };
    // Aucun sous-module explicitement accorde : tous le sont (comptes crees
    // avant cette fonctionnalite).
    if (!Object.values(autorises).some(Boolean))
        Object.keys(autorises).forEach(k => { autorises[k] = true; });
    if (!autorises[sousOngletElectorale])
        sousOngletElectorale = Object.keys(autorises).find(k => autorises[k]);
    const d = await chargerDonneesElectorales();
    // La carte electorale et les resultats de scrutins sont des donnees de
    // reference communes a toute l'organisation : leur import, leur creation
    // et leur suppression relevent de l'administrateur principal, au meme
    // titre que les cellules et les sections. Les autres comptes ayant le
    // module consultent, filtrent et exportent.
    const peutEditer = can(getSession().role, "manageStructure");
    const index = indexerMembresParBureau(d.membres);
    const inscritsTotal = d.bureaux.reduce((t, b) => t + (b.inscrits || 0), 0);
    const membresRattaches = d.membres.filter(m => d.bureaux.some(b => b.cle === cleBureauMembre(m))).length;
    const anneeCourante = new Date().getFullYear();
    container.innerHTML = `
    <div class="view-banner view-banner--red">
      <div class="view-banner__eyebrow">Situation electorale</div>
      <h2 class="view-banner__title">Carte electorale</h2>
      <p class="view-banner__subtitle">Bureaux de vote, correlation avec les fiches Membre, resultats de scrutins, primo-votants et recherche d'un membre.</p>
    </div>
    <div class="stat-grid">
      <div class="stat-card stat-card--blue"><div class="stat-card__value">${d.bureaux.length}</div><div class="stat-card__label">Bureaux de vote</div></div>
      <div class="stat-card stat-card--green"><div class="stat-card__value">${inscritsTotal.toLocaleString("fr-FR")}</div><div class="stat-card__label">Electeurs inscrits</div></div>
      <div class="stat-card stat-card--amber"><div class="stat-card__value">${membresRattaches}/${d.membres.length}</div><div class="stat-card__label">Membres localises dans un bureau</div></div>
      <div class="stat-card stat-card--slate"><div class="stat-card__value">${inscritsTotal ? ((membresRattaches / inscritsTotal) * 100).toFixed(1) + " %" : "—"}</div><div class="stat-card__label">Penetration globale</div></div>
      <div class="stat-card"><div class="stat-card__value">${d.elections.length}</div><div class="stat-card__label">Scrutins enregistres</div></div>
    </div>
    <div class="btn-group">
      ${autorises.bureaux ? `<button type="button" class="btn ${sousOngletElectorale === "bureaux" ? "btn--primary" : "btn--ghost"}" id="ong-el-bureaux">&#128499; Bureaux de vote (${d.bureaux.length})</button>` : ""}
      ${autorises.elections ? `<button type="button" class="btn ${sousOngletElectorale === "elections" ? "btn--primary" : "btn--ghost"}" id="ong-el-elections">&#128499; Elections et resultats (${d.elections.length})</button>` : ""}
      ${autorises.analyse ? `<button type="button" class="btn ${sousOngletElectorale === "analyse" ? "btn--primary" : "btn--ghost"}" id="ong-el-analyse">&#128202; Analyse electorale</button>` : ""}
      ${autorises.primo ? `<button type="button" class="btn ${sousOngletElectorale === "primo" ? "btn--primary" : "btn--ghost"}" id="ong-el-primo">&#127891; Primo-votants</button>` : ""}
      ${autorises.trouver ? `<button type="button" class="btn ${sousOngletElectorale === "trouver" ? "btn--primary" : "btn--ghost"}" id="ong-el-trouver">&#128269; Trouver un membre</button>` : ""}
    </div>
    <div id="el-content"></div>`;
    const contenu = $("#el-content");
    const basculer = (o) => { sousOngletElectorale = o; renderView(); };
    if (autorises.bureaux)
        $("#ong-el-bureaux").addEventListener("click", () => basculer("bureaux"));
    if (autorises.elections)
        $("#ong-el-elections").addEventListener("click", () => basculer("elections"));
    if (autorises.analyse)
        $("#ong-el-analyse").addEventListener("click", () => basculer("analyse"));
    if (autorises.primo)
        $("#ong-el-primo").addEventListener("click", () => basculer("primo"));
    if (autorises.trouver)
        $("#ong-el-trouver").addEventListener("click", () => basculer("trouver"));
    const contexte = { d, index, peutEditer, anneeCourante };
    if (sousOngletElectorale === "bureaux")
        rendreOngletBureaux(contenu, contexte);
    else if (sousOngletElectorale === "elections")
        rendreOngletElections(contenu, contexte);
    else if (sousOngletElectorale === "analyse")
        rendreOngletAnalyseElectorale(contenu, contexte);
    else if (sousOngletElectorale === "primo")
        rendreOngletPrimoVotants(contenu, contexte);
    else
        rendreOngletTrouverMembre(contenu, contexte);
}
// ---------------- Onglet 1 : bureaux de vote (carte electorale) ---------
// Extraction Departement de Rufisque : la carte electorale Etranger /
// diaspora est entierement retiree ici (pas de bascule de zone, pas
// d'import, pas de champs Republique diplomatique/Pays/Localite) — seule la
// carte nationale existe, et elle accepte tous les departements (Rufisque
// n'est pas obligatoire).
function modeleCarteElectorale() {
    return toCSV([
        ["Region", "Departement", "Commune", "Lieu de vote", "Bureau", "Inscrits", "Quartier", "Cellule"],
        ["DAKAR", "RUFISQUE", "TIVAOUANE PEULH - NIAGA", "Ecole elementaire Niaga 1", "01", "512", "Niaga", ""],
        ["DAKAR", "RUFISQUE", "TIVAOUANE PEULH - NIAGA", "Ecole elementaire Niaga 1", "02", "498", "Niaga", ""],
    ]);
}
// Colonnes toujours numeriques (alignees a droite) — sert a determiner la
// classe "num" des <th>/<td> dynamiquement.
const COLONNES_NUM_BUREAUX = new Set(["Inscrits", "Membres", "Porteurs de carte", "Primo-votants", "Penetration"]);
function rendreOngletBureaux(contenu, { d, index, peutEditer, anneeCourante }) {
    const nomCellule = (id) => d.cellules.find(c => c.id === id)?.nom || "—";
    const bureauxZone = d.bureaux.filter(b => (b.zoneElectorale || "National") === "National");
    const entetes = ["Region", "Departement", "Commune", "Lieu de vote", "Bureau", "Quartier", "Inscrits", "Membres", "Porteurs de carte", "Primo-votants", "Penetration", "Cellules presentes"];
    const ligneCellules = (l) => {
        const b = l.bureau;
        const penetrationTxt = l.penetration == null ? "—" : l.penetration.toFixed(2) + " %";
        const cellulesTxt = l.cellules.join(", ") || "—";
        const chiffres = [b.inscrits || 0, l.membres.length, l.porteurs, l.primo, penetrationTxt];
        return [b.region || "—", b.departement || "—", b.commune || "—", b.lieuVote, b.numeroBureau, b.quartier || "—", ...chiffres, cellulesTxt];
    };
    const lignesBureau = bureauxZone
        .slice()
        .sort((a, b) => a.lieuVote.localeCompare(b.lieuVote, "fr") || a.numeroBureau.localeCompare(b.numeroBureau, "fr"))
        .map(b => {
            const membres = index.get(b.cle) || [];
            return {
                bureau: b, membres,
                cellules: [...new Set(membres.map(m => nomCellule(m.celluleId)).filter(v => v !== "—"))],
                porteurs: membres.filter(aCarteMembre).length,
                primo: membres.filter(m => estPrimoVotant(m, anneeCourante, anneeCourante - 5)).length,
                penetration: b.inscrits ? (membres.length / b.inscrits) * 100 : null,
            };
        });
    // Membres dont le lieu / bureau de vote ne correspond a aucun bureau de la
    // carte electorale importee : ils doivent etre corriges pour etre analyses.
    const clesConnues = new Set(d.bureaux.map(b => b.cle));
    const nonRapproches = d.membres.filter(m => m.electeur === "Oui" && (!m.lieuVote || !m.bureauVote || !clesConnues.has(cleBureauMembre(m))));
    contenu.innerHTML = `
    <div class="filtre-bar">
      <label class="filtre-groupe" style="flex:1;min-width:220px;">
        <span>Rechercher un lieu ou un bureau</span>
        <input type="search" id="bv-recherche" placeholder="Nom du lieu de vote, numero de bureau, commune...">
      </label>
      <label class="filtre-groupe">
        <span>Afficher</span>
        <select id="bv-filtre">
          <option value="tous">Tous les bureaux</option>
          <option value="avec">Avec des membres</option>
          <option value="sans">Sans aucun membre</option>
        </select>
      </label>
      <div class="filtre-bar__actions">
        ${peutEditer ? `<button type="button" class="btn btn--primary" id="bv-importer">&#8679; Importer la carte electorale</button>` : ""}
        ${peutEditer && bureauxZone.length ? `<button type="button" class="btn btn--ghost" id="bv-vider">&#128465; Vider</button>` : ""}
        <button type="button" class="btn btn--ghost" id="bv-csv">&#8681; CSV</button>
        <button type="button" class="btn btn--ghost" id="bv-pdf">&#128438; PDF</button>
      </div>
    </div>
    ${nonRapproches.length ? `<p class="form-note form-note--warn">
      <b>${nonRapproches.length} electeur(s)</b> de la base ne correspondent a aucun bureau de la carte electorale
      (lieu ou numero de bureau absent ou different). <button type="button" class="badge badge--warn badge--clickable" id="bv-voir-ecarts">Voir la liste</button>
    </p>` : ""}
    <p class="liste-resume" id="bv-resume"></p>
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>${entetes.map(h => `<th${COLONNES_NUM_BUREAUX.has(h) ? ' class="num"' : ""}>${escapeHtml(h)}</th>`).join("")}<th></th></tr></thead>
        <tbody id="bv-tbody"></tbody>
      </table>
      <div id="bv-vide"></div>
    </div>`;
    let affichees = lignesBureau;
    function appliquer() {
        const q = cleNom($("#bv-recherche").value);
        const mode = $("#bv-filtre").value;
        affichees = lignesBureau.filter(l => {
            if (mode === "avec" && !l.membres.length)
                return false;
            if (mode === "sans" && l.membres.length)
                return false;
            if (!q)
                return true;
            return cleNom(`${l.bureau.region || ""} ${l.bureau.departement || ""} ${l.bureau.commune} ${l.bureau.lieuVote} ${l.bureau.numeroBureau} ${l.bureau.quartier || ""}`).includes(q);
        });
        dessiner();
    }
    function dessiner() {
        const inscrits = affichees.reduce((t, l) => t + (l.bureau.inscrits || 0), 0);
        const membres = affichees.reduce((t, l) => t + l.membres.length, 0);
        $("#bv-resume").innerHTML = `<b>${affichees.length}</b> bureau(x) affiche(s) sur ${lignesBureau.length}
      &middot; ${inscrits.toLocaleString("fr-FR")} inscrit(s) &middot; ${membres} membre(s) recense(s)
      &middot; penetration ${inscrits ? ((membres / inscrits) * 100).toFixed(2) + " %" : "—"}`;
        $("#bv-tbody").innerHTML = affichees.map(l => {
            const valeurs = ligneCellules(l);
            return `
      <tr class="data-row--clickable" data-bureau="${l.bureau.id}">
        ${entetes.map((h, i) => `<td${COLONNES_NUM_BUREAUX.has(h) ? ' class="num"' : ""}>${escapeHtml(String(valeurs[i] ?? ""))}</td>`).join("")}
        <td class="row-actions"><button class="icon-btn" data-detail="${l.bureau.id}" title="Voir les membres de ce bureau">&#128100;</button></td>
      </tr>`;
        }).join("");
        $("#bv-vide").innerHTML = affichees.length ? "" : emptyState(bureauxZone.length
            ? "Aucun bureau ne correspond a la recherche."
            : "Aucune carte electorale importee pour le moment.");
        $("#bv-tbody").querySelectorAll("[data-detail], [data-bureau]").forEach(el => el.addEventListener("click", (e) => {
            const id = Number(el.dataset.detail || el.dataset.bureau);
            const ligne = lignesBureau.find(l => l.bureau.id === id);
            if (ligne)
                ouvrirDetailBureau(ligne, d, anneeCourante);
            e.stopPropagation();
        }));
    }
    $("#bv-recherche").addEventListener("input", appliquer);
    $("#bv-filtre").addEventListener("change", appliquer);
    appliquer();
    document.getElementById("bv-voir-ecarts")?.addEventListener("click", () => ouvrirListeEcartsCarte(nonRapproches, d));
    $("#bv-csv").addEventListener("click", () => {
        if (!affichees.length) {
            toast("Aucun bureau a exporter.", "info");
            return;
        }
        exporterCSV("carte_electorale.csv", entetes, affichees.map(ligneCellules));
    });
    $("#bv-pdf").addEventListener("click", () => {
        if (!affichees.length) {
            toast("Aucun bureau a exporter.", "info");
            return;
        }
        const inscrits = affichees.reduce((t, l) => t + (l.bureau.inscrits || 0), 0);
        const membres = affichees.reduce((t, l) => t + l.membres.length, 0);
        exporterPDF("Carte electorale", `
      <div class="pdf-resume">
        <div class="pdf-tuile"><b>${affichees.length}</b><span>Bureaux</span></div>
        <div class="pdf-tuile"><b>${inscrits.toLocaleString("fr-FR")}</b><span>Inscrits</span></div>
        <div class="pdf-tuile"><b>${membres}</b><span>Membres recenses</span></div>
        <div class="pdf-tuile"><b>${inscrits ? ((membres / inscrits) * 100).toFixed(2) + " %" : "—"}</b><span>Penetration</span></div>
      </div>
      <h2>Bureaux de vote (${affichees.length})</h2>
      ${tableauPDF(entetes, affichees.map(ligneCellules))}`, "landscape");
    });
    document.getElementById("bv-importer")?.addEventListener("click", () => ouvrirImportCarteElectorale(d));
    document.getElementById("bv-vider")?.addEventListener("click", async () => {
        if (!confirm(`Supprimer toute la carte electorale (${bureauxZone.length} bureau(x)) ?\n\nLes resultats et depouillements de scrutin lies a ces bureaux seront egalement supprimes.`))
            return;
        const idsASupprimer = bureauxZone.map(b => b.id);
        await db.resultats.where("bureauId").anyOf(idsASupprimer).delete();
        await db.depouillements.where("bureauId").anyOf(idsASupprimer).delete();
        await db.bureauxVote.bulkDelete(idsASupprimer);
        toast("Carte electorale supprimee.", "success");
        renderView();
    });
}
// Import de la carte electorale : un bureau par ligne. Extraction
// Departement de Rufisque : uniquement la carte NATIONALE (la carte
// Etranger / diaspora est entierement retiree de cette extraction) ;
// en revanche tous les departements sont acceptes (voir
// DEPARTEMENT_PRINCIPAL — aucune valeur n'est rejetee sur ce critere).
// Source UNIQUE de reference pour les champs Departement/
// Commune, Commune de vote/Lieu de vote/Bureau de vote du formulaire Membre
// (voir departementsElectoraux/communesElectorales/etc. plus haut). Reserve
// a l'administrateur (voir peutEditer / manageStructure dans
// rendreOngletBureaux). Peut etre importe en plusieurs fois : chaque ligne
// ajoute un bureau, sans effacer ceux deja enregistres (utiliser "Vider"
// pour repartir de zero).
function ouvrirImportCarteElectorale(d) {
    ouvrirImportCSV({
        titre: "Importer la carte electorale",
        note: `Colonnes attendues : <b>Departement</b> (obligatoire — tous les departements sont acceptes), <b>Commune</b> (obligatoire), <b>Lieu de vote</b> (obligatoire), <b>Bureau</b> (obligatoire, numero), Region, Inscrits, Quartier, Cellule (nom exact d'une cellule existante, facultatif).
           C'est cette carte qui alimente ensuite les listes deroulantes Departement/Commune et Commune de vote/Lieu de vote/Bureau de vote du formulaire Membre : importez-la avant de saisir des membres.
           Un <b>doublon</b> est une ligne dont Departement, Commune, Lieu de vote, Bureau et Inscrits sont exactement identiques a une autre ligne ; si un seul de ces champs differe, la ligne est conservee.
           Le rapprochement avec les fiches Membre se fait sur <b>Lieu de vote + Bureau de vote</b> : utilisez exactement les memes libelles que dans les fiches.`,
        nomModele: "modele_carte_electorale.csv",
        contenuModele: modeleCarteElectorale,
        colonnesApercu: ["Region", "Departement", "Commune", "Lieu de vote", "Bureau", "Inscrits", "Quartier", "Cellule"],
        analyser: (rows) => {
            const header = rows[0].map(normalizeHeader);
            const idx = (alias) => header.findIndex(h => alias.includes(h));
            const get = (r, i) => (i > -1 ? (r[i] || "").trim() : "");
            const iLieu = idx(["lieu de vote", "lieu", "centre de vote"]);
            const iBureau = idx(["bureau", "bureau de vote", "n°", "n° bureau", "numero de bureau"]);
            const iInscrits = idx(["inscrits", "nombre d'inscrits", "electeurs inscrits"]);
            const signatureBureau = (dep, com, lieu, num, ins) => [cleNom(dep), cleNom(com), cleNom(lieu), String(num ?? "").replace(/\D/g, "").padStart(2, "0"), parseInt(ins, 10) || 0].join("|");
            const existants = new Set(d.bureaux.map(b => signatureBureau(b.departement, b.commune, b.lieuVote, b.numeroBureau, b.inscrits)));
            const clesUtilisees = new Set(d.bureaux.map(b => b.cle));
            const vus = new Set();
            const iRegion = idx(["region"]);
            const iDepartement = idx(["departement"]);
            const iCommune = idx(["commune"]);
            const iQuartier = idx(["quartier", "quartier / village", "village"]);
            const iCellule = idx(["cellule", "cellule de rattachement"]);
            if (iLieu === -1 || iBureau === -1 || iDepartement === -1 || iCommune === -1)
                return { erreur: `Colonnes "Departement", "Commune", "Lieu de vote" et "Bureau" obligatoires et introuvables dans l'en-tete.` };
            const lignes = rows.slice(1).map(r => {
                const region = get(r, iRegion);
                const departement = get(r, iDepartement);
                const lieuVote = get(r, iLieu);
                const numeroBureau = get(r, iBureau).replace(/\D/g, "").padStart(2, "0");
                const commune = get(r, iCommune);
                const quartier = get(r, iQuartier);
                const inscrits = parseInt(get(r, iInscrits).replace(/\s/g, ""), 10) || 0;
                const celluleNom = get(r, iCellule);
                let error = "";
                let celluleId;
                if (!departement)
                    error = "Departement manquant";
                else if (!commune)
                    error = "Commune manquante";
                else if (!lieuVote)
                    error = "Lieu de vote manquant";
                else if (!/\d/.test(numeroBureau))
                    error = "Numero de bureau manquant";
                // Doublon = MEMES departement, commune, lieu de vote, bureau
                // ET inscrits. Si l'un de ces champs differe, ce n'est pas
                // un doublon.
                const signature = signatureBureau(departement, commune, lieuVote, numeroBureau, inscrits);
                if (!error && existants.has(signature))
                    error = "Bureau deja enregistre";
                else if (!error && vus.has(signature))
                    error = "Doublon dans le fichier";
                // La cle technique (lieu|bureau) doit rester unique en base :
                // une ligne non doublon qui la partage recoit un suffixe.
                const cleBase = cleBureauVote(lieuVote, numeroBureau);
                let cle = cleBase;
                if (!error) {
                    let n = 2;
                    while (clesUtilisees.has(cle))
                        cle = `${cleBase}#${n++}`;
                    clesUtilisees.add(cle);
                }
                if (!error && celluleNom) {
                    const c = d.cellules.find(x => cleNom(x.nom) === cleNom(celluleNom));
                    if (c)
                        celluleId = c.id;
                    else
                        error = "Cellule introuvable";
                }
                if (!error)
                    vus.add(signature);
                return {
                    error,
                    apercu: [region || "—", departement || "—", commune || "—", lieuVote || "—", numeroBureau, inscrits, quartier || "—", celluleNom || "—"],
                    donnees: { cle, zoneElectorale: "National", region, departement, commune, lieuVote, numeroBureau, quartier, inscrits, celluleId },
                };
            });
            return { lignes };
        },
        confirmer: async (lignes) => {
            const now = new Date().toISOString();
            await db.bureauxVote.bulkAdd(lignes.map(l => ({ ...l.donnees, createdAt: now, updatedAt: now })));
            return `${lignes.length} bureau(x) de vote importe(s).`;
        },
        apresImport: async () => renderView(),
    });
}
// Detail d'un bureau : membres qui y votent, avec leurs informations cles.
function ouvrirDetailBureau(ligne, d, anneeCourante) {
    const nom = (liste, id) => liste.find(x => x.id === id)?.nom || "—";
    const entetes = ["Prenom & nom", "Reference", "Sexe", "Age", "Telephone", "Cellule", "Section", "Carte membre", "Primo-votant"];
    const lignes = ligne.membres
        .slice().sort((a, b) => nomComplet(a).localeCompare(nomComplet(b), "fr"))
        .map(m => {
            const maj = anneeMajorite(m.dateNaissance);
            return [nomComplet(m), m.reference, m.sexe || "—",
                maj == null ? "—" : String(anneeCourante - (maj - 18)),
                m.telephone || "—", nom(d.cellules, m.celluleId), nom(d.sections, m.sectionId),
                m.carteMembre === "Oui" ? (m.numeroCarteMembre || "Oui") : "Non",
                estPrimoVotant(m, anneeCourante, anneeCourante - 5) ? "Oui" : "Non"];
        });
    ouvrirModale({
        titre: `Bureau de vote — ${libelleBureau(ligne.bureau)}`,
        taille: "xwide",
        contenuHtml: `
      <p class="liste-resume">
        <b>${ligne.membres.length}</b> membre(s) y votent &middot; ${(ligne.bureau.inscrits || 0).toLocaleString("fr-FR")} inscrit(s)
        &middot; penetration <b>${ligne.penetration == null ? "—" : ligne.penetration.toFixed(2) + " %"}</b>
        &middot; ${ligne.porteurs} carte(s) de membre &middot; ${ligne.primo} primo-votant(s)
        ${ligne.bureau.commune ? `&middot; ${escapeHtml(ligne.bureau.commune)}` : ""}
      </p>
      <div class="liste-outils">
        <button type="button" class="btn btn--ghost" id="db-csv">&#8681; Exporter CSV</button>
        <button type="button" class="btn btn--primary" id="db-pdf">&#128438; Exporter PDF</button>
      </div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>${entetes.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
          <tbody>${lignes.map(l => `<tr>${l.map(c => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
        ${lignes.length ? "" : emptyState("Aucun membre de la base ne vote dans ce bureau.")}
      </div>`,
        onMonte: (contenu) => {
            contenu.querySelector("#db-csv").addEventListener("click", () => exporterCSV(`bureau_${ligne.bureau.cle.replace(/[^\w]+/g, "_")}.csv`, entetes, lignes));
            contenu.querySelector("#db-pdf").addEventListener("click", () => exporterPDF(`Bureau de vote — ${libelleBureau(ligne.bureau)}`, `
        <div class="pdf-resume">
          <div class="pdf-tuile"><b>${(ligne.bureau.inscrits || 0).toLocaleString("fr-FR")}</b><span>Inscrits</span></div>
          <div class="pdf-tuile"><b>${ligne.membres.length}</b><span>Membres</span></div>
          <div class="pdf-tuile"><b>${ligne.penetration == null ? "—" : ligne.penetration.toFixed(2) + " %"}</b><span>Penetration</span></div>
          <div class="pdf-tuile"><b>${ligne.porteurs}</b><span>Cartes de membre</span></div>
          <div class="pdf-tuile"><b>${ligne.primo}</b><span>Primo-votants</span></div>
        </div>
        <h2>Membres votant dans ce bureau (${lignes.length})</h2>
        ${tableauPDF(entetes, lignes)}`, "landscape"));
        },
    });
}
// Electeurs de la base sans correspondance dans la carte electorale.
function ouvrirListeEcartsCarte(membres, d) {
    const nom = (liste, id) => liste.find(x => x.id === id)?.nom || "—";
    const entetes = ["Prenom & nom", "Reference", "Lieu de vote saisi", "Bureau saisi", "Commune de vote", "Cellule", "Telephone"];
    const lignes = membres.map(m => [nomComplet(m), m.reference, m.lieuVote || "(vide)", m.bureauVote || "(vide)",
        m.communeVote || "—", nom(d.cellules, m.celluleId), m.telephone || "—"]);
    ouvrirModale({
        titre: `Electeurs non rapproches de la carte electorale (${membres.length})`,
        taille: "xwide",
        contenuHtml: `
      <p class="form-note">Ces membres sont declares electeurs mais leur couple <b>Lieu de vote + Bureau de vote</b> ne correspond a aucun bureau importe.
      Corrigez leur fiche (module Membres) ou completez la carte electorale pour qu'ils entrent dans les analyses.</p>
      <div class="liste-outils"><button type="button" class="btn btn--ghost" id="ec-csv">&#8681; Exporter CSV</button></div>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>${entetes.map(h => `<th>${escapeHtml(h)}</th>`).join("")}</tr></thead>
          <tbody>${lignes.map(l => `<tr>${l.map(c => `<td>${escapeHtml(String(c))}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      </div>`,
        onMonte: (contenu) => {
            contenu.querySelector("#ec-csv").addEventListener("click", () => exporterCSV("electeurs_non_rapproches.csv", entetes, lignes));
        },
    });
}
// ---------------- Onglet 2 : elections et resultats ---------------------
function modeleResultats() {
    return toCSV([
        ["Lieu de vote", "Bureau", "Candidat", "Parti", "Voix", "Inscrits", "Votants", "Bulletins nuls"],
        ["Ecole elementaire Niaga 1", "01", "Candidat A", "Parti A", "212", "512", "389", "7"],
        ["Ecole elementaire Niaga 1", "01", "Candidat B", "Parti B", "170", "512", "389", "7"],
    ]);
}
function rendreOngletElections(contenu, { d, peutEditer }) {
    const stats = (e) => {
        const bureauxDepouilles = new Set(d.resultats.filter(r => r.electionId === e.id).map(r => r.bureauId));
        const classement = classementGlobalElection(e, d);
        const deps = d.depouillements.filter(x => x.electionId === e.id);
        const inscrits = deps.reduce((t, x) => t + (x.inscrits || 0), 0);
        const votants = deps.reduce((t, x) => t + (x.votants || 0), 0);
        return { bureauxDepouilles: bureauxDepouilles.size, candidats: classement.length, classement, inscrits, votants };
    };
    contenu.innerHTML = `
    ${peutEditer ? `
    <div class="carte-bloc" style="margin-bottom:14px;">
      <h4 class="carte-bloc__titre">Enregistrer un scrutin</h4>
      <form id="el-form" class="filtre-bar" style="margin:0;border:none;padding:0;background:none;">
        <label class="filtre-groupe"><span>Type *</span>
          <select name="type" required>${TYPES_ELECTION.map(t => `<option value="${t}">${t}</option>`).join("")}</select>
        </label>
        <label class="filtre-groupe" style="min-width:110px;"><span>Annee *</span>
          <input type="number" name="annee" min="1960" max="2100" value="${new Date().getFullYear()}" required>
        </label>
        <label class="filtre-groupe" id="el-tour-groupe" style="min-width:110px;display:none;"><span>Tour</span>
          <select name="tour"><option value="">—</option><option value="1er tour">1er tour</option><option value="2e tour">2e tour</option></select>
        </label>
        <label class="filtre-groupe" style="flex:1;min-width:170px;"><span>Libelle</span>
          <input type="text" name="libelle" placeholder="ex. Departementales">
        </label>
        <label class="filtre-groupe" style="flex:1;min-width:190px;"><span>Candidat / liste de reference</span>
          <input type="text" name="candidatReference" placeholder="Notre candidat ou notre parti">
        </label>
        <div class="filtre-bar__actions"><button type="submit" class="btn btn--primary">+ Ajouter le scrutin</button></div>
      </form>
      <p class="carte-note">Le "candidat de reference" est celui du point de vue duquel un bureau est declare <b>gagne</b> (il y arrive en tete) ou <b>perdu</b>.</p>
    </div>` : ""}
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>Type</th><th>Annee</th><th>Tour</th><th>Libelle</th><th>Candidat de reference</th>
          <th class="num">Bureaux depouilles</th><th class="num">Candidats</th><th class="num">Participation</th><th></th>
        </tr></thead>
        <tbody id="el-tbody"></tbody>
      </table>
      <div id="el-vide"></div>
    </div>`;
    const tbody = $("#el-tbody");
    tbody.innerHTML = d.elections
        .slice().sort((a, b) => b.annee - a.annee || a.type.localeCompare(b.type))
        .map(e => {
        const s = stats(e);
        return `
      <tr>
        <td>${escapeHtml(e.type)}</td>
        <td>${e.annee}</td>
        <td>${escapeHtml(e.type === "Presidentielle" ? (e.tour || "—") : "—")}</td>
        <td>${escapeHtml(e.libelle || "—")}</td>
        <td>${e.candidatReference ? `<span class="ref-badge">${escapeHtml(e.candidatReference)}</span>` : "—"}</td>
        <td class="num">${s.bureauxDepouilles}/${d.bureaux.length}</td>
        <td class="num">${s.candidats}</td>
        <td class="num">${s.inscrits ? ((s.votants / s.inscrits) * 100).toFixed(1) + " %" : "—"}</td>
        <td class="row-actions">
          <button class="icon-btn" data-analyser="${e.id}" title="Analyser ce scrutin">&#128202;</button>
          ${peutEditer ? `<button class="icon-btn" data-resultats="${e.id}" title="Importer les resultats">&#8679;</button>
          <button class="icon-btn icon-btn--danger" data-supprimer="${e.id}" title="Supprimer ce scrutin">&#128465;</button>` : ""}
        </td>
      </tr>`;
    }).join("");
    $("#el-vide").innerHTML = d.elections.length ? "" : emptyState("Aucun scrutin enregistre pour le moment.");
    tbody.querySelectorAll("[data-analyser]").forEach(b => b.addEventListener("click", () => {
        electionSelectionnee = Number(b.dataset.analyser);
        sousOngletElectorale = "analyse";
        renderView();
    }));
    tbody.querySelectorAll("[data-resultats]").forEach(b => b.addEventListener("click", () => {
        const election = d.elections.find(e => e.id === Number(b.dataset.resultats));
        if (election)
            ouvrirImportResultats(election, d);
    }));
    tbody.querySelectorAll("[data-supprimer]").forEach(b => b.addEventListener("click", async () => {
        const id = Number(b.dataset.supprimer);
        if (!confirm("Supprimer ce scrutin ainsi que tous ses resultats ?"))
            return;
        await db.resultats.where("electionId").equals(id).delete();
        await db.depouillements.where("electionId").equals(id).delete();
        await db.elections.delete(id);
        toast("Scrutin supprime.", "success");
        renderView();
    }));
    const form = document.getElementById("el-form");
    if (form) {
        // Seule l'election presidentielle se joue en deux tours : le champ
        // Tour n'est propose (et enregistre) que pour ce type de scrutin.
        const groupeTour = document.getElementById("el-tour-groupe");
        const selectType = form.querySelector('[name="type"]');
        const majTour = () => {
            const presidentielle = selectType.value === "Presidentielle";
            groupeTour.style.display = presidentielle ? "" : "none";
            if (!presidentielle)
                form.querySelector('[name="tour"]').value = "";
        };
        selectType.addEventListener("change", majTour);
        majTour();
        form.onsubmit = async (e) => {
            e.preventDefault();
            const fd = new FormData(form);
            const annee = Number(fd.get("annee"));
            const type = String(fd.get("type"));
            const tour = type === "Presidentielle" ? String(fd.get("tour") || "") : "";
            if (d.elections.some(x => x.type === type && x.annee === annee && (x.tour || "") === tour)) {
                toast("Un scrutin de ce type, de cette annee et de ce tour existe deja.", "error");
                return;
            }
            await db.elections.add({
                type, annee, tour,
                libelle: String(fd.get("libelle") || "").trim(),
                candidatReference: String(fd.get("candidatReference") || "").trim(),
                createdAt: new Date().toISOString(),
            });
            toast("Scrutin enregistre. Importez maintenant ses resultats.", "success");
            renderView();
        };
    }
}
// Import des resultats d'un scrutin : une ligne par candidat et par bureau.
function ouvrirImportResultats(election, d) {
    ouvrirImportCSV({
        titre: `Importer les resultats — ${libelleElection(election)}`,
        note: `Une ligne par <b>candidat</b> et par <b>bureau</b>. Colonnes attendues : <b>Lieu de vote</b>, <b>Bureau</b>, <b>Candidat</b>, <b>Voix</b>, Parti, Inscrits, Votants, Bulletins nuls.
           Les bureaux doivent avoir ete importes au prealable dans l'onglet "Bureaux de vote". Un nouvel import remplace les resultats deja enregistres pour ce scrutin.`,
        nomModele: `modele_resultats_${election.type.toLowerCase()}_${election.annee}.csv`,
        contenuModele: modeleResultats,
        colonnesApercu: ["Lieu de vote", "Bureau", "Candidat", "Parti", "Voix"],
        analyser: (rows) => {
            if (!d.bureaux.length)
                return { erreur: "Importez d'abord la carte electorale (onglet Bureaux de vote)." };
            const header = rows[0].map(normalizeHeader);
            const idx = (alias) => header.findIndex(h => alias.includes(h));
            const get = (r, i) => (i > -1 ? (r[i] || "").trim() : "");
            const iLieu = idx(["lieu de vote", "lieu", "centre de vote"]);
            const iBureau = idx(["bureau", "bureau de vote", "n° bureau", "numero de bureau"]);
            const iCandidat = idx(["candidat", "candidat / liste", "liste"]);
            const iParti = idx(["parti", "coalition", "formation"]);
            const iVoix = idx(["voix", "suffrages", "nombre de voix"]);
            const iInscrits = idx(["inscrits", "electeurs inscrits"]);
            const iVotants = idx(["votants"]);
            const iNuls = idx(["bulletins nuls", "nuls", "blancs et nuls"]);
            const manquantes = [];
            if (iLieu === -1)
                manquantes.push("Lieu de vote");
            if (iBureau === -1)
                manquantes.push("Bureau");
            if (iCandidat === -1)
                manquantes.push("Candidat");
            if (iVoix === -1)
                manquantes.push("Voix");
            if (manquantes.length)
                return { erreur: `Colonne(s) obligatoire(s) introuvable(s) : ${manquantes.join(", ")}.` };
            const parCle = new Map(d.bureaux.map(b => [b.cle, b]));
            const vus = new Set();
            const lignes = rows.slice(1).map(r => {
                const lieuVote = get(r, iLieu);
                const numeroBureau = get(r, iBureau).replace(/\D/g, "").padStart(2, "0");
                const candidat = get(r, iCandidat);
                const parti = get(r, iParti);
                const voix = parseInt(get(r, iVoix).replace(/\s/g, ""), 10);
                const cle = cleBureauVote(lieuVote, numeroBureau);
                const bureau = parCle.get(cle);
                let error = "";
                if (!lieuVote || !/\d/.test(numeroBureau))
                    error = "Lieu ou bureau manquant";
                else if (!bureau)
                    error = "Bureau absent de la carte electorale";
                else if (!candidat)
                    error = "Candidat manquant";
                else if (!isFinite(voix) || voix < 0)
                    error = "Nombre de voix invalide";
                else if (vus.has(cle + "|" + cleNom(candidat)))
                    error = "Doublon candidat / bureau";
                if (!error)
                    vus.add(cle + "|" + cleNom(candidat));
                return {
                    error,
                    apercu: [lieuVote || "—", numeroBureau, candidat || "—", parti || "—", isFinite(voix) ? voix : "—"],
                    donnees: {
                        bureauId: bureau?.id, candidat, parti, voix: isFinite(voix) ? voix : 0,
                        inscrits: parseInt(get(r, iInscrits).replace(/\s/g, ""), 10) || 0,
                        votants: parseInt(get(r, iVotants).replace(/\s/g, ""), 10) || 0,
                        nuls: parseInt(get(r, iNuls).replace(/\s/g, ""), 10) || 0,
                    },
                };
            });
            return { lignes };
        },
        confirmer: async (lignes) => {
            // Un import remplace integralement les resultats du scrutin.
            await db.resultats.where("electionId").equals(election.id).delete();
            await db.depouillements.where("electionId").equals(election.id).delete();
            await db.resultats.bulkAdd(lignes.map(l => ({
                electionId: election.id, bureauId: l.donnees.bureauId,
                candidat: l.donnees.candidat, parti: l.donnees.parti, voix: l.donnees.voix,
            })));
            // Le depouillement (inscrits / votants / nuls) est commun a toutes
            // les lignes d'un meme bureau : on retient la premiere valeur non
            // nulle rencontree et on complete les suffrages exprimes.
            const parBureau = new Map();
            for (const l of lignes) {
                const id = l.donnees.bureauId;
                const e = parBureau.get(id) || { electionId: election.id, bureauId: id, inscrits: 0, votants: 0, nuls: 0, exprimes: 0 };
                e.inscrits = e.inscrits || l.donnees.inscrits;
                e.votants = e.votants || l.donnees.votants;
                e.nuls = e.nuls || l.donnees.nuls;
                e.exprimes += l.donnees.voix;
                parBureau.set(id, e);
            }
            for (const e of parBureau.values()) {
                if (!e.votants)
                    e.votants = e.exprimes + e.nuls;
            }
            await db.depouillements.bulkAdd([...parBureau.values()]);
            return `${lignes.length} resultat(s) importe(s) sur ${parBureau.size} bureau(x).`;
        },
        apresImport: async () => {
            electionSelectionnee = election.id;
            sousOngletElectorale = "analyse";
            renderView();
        },
    });
}
// ---------------- Onglet 3 : analyse electorale -------------------------
let filtreBureaux = "tous";
function rendreOngletAnalyseElectorale(contenu, { d }) {
    if (!d.elections.length) {
        contenu.innerHTML = emptyState("Aucun scrutin enregistre. Creez-en un dans l'onglet \"Elections et resultats\", puis importez ses resultats.");
        return;
    }
    if (!d.elections.some(e => e.id === electionSelectionnee))
        electionSelectionnee = d.elections.slice().sort((a, b) => b.annee - a.annee)[0].id;
    const election = d.elections.find(e => e.id === electionSelectionnee);
    const { lignes, anneePrecedente } = analyserElection(election, d);
    const global = classementGlobalElection(election, d);
    const depouilles = lignes.filter(l => l.depouille);
    const gagnes = depouilles.filter(l => l.gagne === true);
    const perdus = depouilles.filter(l => l.gagne === false);
    const totalInscrits = depouilles.reduce((t, l) => t + l.inscrits, 0);
    const totalVotants = depouilles.reduce((t, l) => t + l.votants, 0);
    const totalNuls = depouilles.reduce((t, l) => t + l.nuls, 0);
    const totalExprimes = depouilles.reduce((t, l) => t + l.exprimes, 0);
    const totalMembres = depouilles.reduce((t, l) => t + l.membres, 0);
    // Croisements utiles au pilotage : bureaux perdus malgre une presence
    // militante forte (reconquete), bureaux gagnes sans implantation
    // (consolidation), et bureaux les plus serres.
    const penetrationMoyenne = totalInscrits ? (totalMembres / totalInscrits) * 100 : 0;
    const reconquete = perdus.filter(l => (l.penetration ?? 0) > penetrationMoyenne)
        .sort((a, b) => (b.penetration ?? 0) - (a.penetration ?? 0)).slice(0, 5);
    const consolidation = gagnes.filter(l => (l.penetration ?? 0) < penetrationMoyenne)
        .sort((a, b) => (a.penetration ?? 0) - (b.penetration ?? 0)).slice(0, 5);
    const serres = depouilles.filter(l => l.ecart != null && l.exprimes)
        .sort((a, b) => Math.abs(a.ecart / (a.exprimes || 1)) - Math.abs(b.ecart / (b.exprimes || 1))).slice(0, 5);
    const entetes = ["Commune", "Lieu de vote", "Bureau", "Inscrits", "Votants", "Participation",
        "Exprimes", "Nuls", "Arrive en tete", "Voix", "%", "Notre score", "Voix", "%", "Ecart",
        "Statut", "Membres", "Penetration"];
    const ligneExport = (l) => [
        l.bureau.commune || "—", l.bureau.lieuVote, l.bureau.numeroBureau,
        l.inscrits, l.votants, l.participation == null ? "—" : l.participation.toFixed(1) + " %",
        l.exprimes, l.nuls,
        l.gagnant ? l.gagnant.candidat : "—", l.gagnant ? l.gagnant.voix : "—",
        l.gagnant?.part == null ? "—" : l.gagnant.part.toFixed(1) + " %",
        l.reference ? `${l.reference.candidat} (${l.reference.rang}e)` : "—",
        l.reference ? l.reference.voix : "—",
        l.reference?.part == null ? "—" : l.reference.part.toFixed(1) + " %",
        l.ecart == null ? "—" : (l.ecart > 0 ? "+" : "") + l.ecart,
        !l.depouille ? "Non depouille" : l.gagne === null ? "—" : l.gagne ? "Gagne" : "Perdu",
        l.membres, l.penetration == null ? "—" : l.penetration.toFixed(2) + " %",
    ];
    const bloc = (titre, liste, description) => `
    <div class="carte-bloc">
      <h4 class="carte-bloc__titre">${escapeHtml(titre)}</h4>
      ${liste.length ? liste.map(l => `
        <div class="stat-liste__ligne">
          <span>${escapeHtml(libelleBureau(l.bureau))}</span>
          <b>${l.penetration == null ? "—" : l.penetration.toFixed(1) + " %"}${l.ecart != null ? ` · ${l.ecart > 0 ? "+" : ""}${l.ecart} voix` : ""}</b>
        </div>`).join("") : `<p class="carte-note">Aucun bureau dans ce cas.</p>`}
      <p class="carte-note">${escapeHtml(description)}</p>
    </div>`;
    contenu.innerHTML = `
    <div class="filtre-bar">
      <label class="filtre-groupe" style="min-width:250px;">
        <span>Scrutin</span>
        <select id="an-el-election">
          ${d.elections.slice().sort((a, b) => b.annee - a.annee).map(e => `<option value="${e.id}" ${e.id === election.id ? "selected" : ""}>${escapeHtml(libelleElection(e))}</option>`).join("")}
        </select>
      </label>
      <label class="filtre-groupe" style="flex:1;min-width:200px;">
        <span>Rechercher un lieu ou un bureau</span>
        <input type="search" id="an-el-q" placeholder="Lieu de vote, bureau, commune...">
      </label>
      <div class="filtre-groupe">
        <span>Bureaux affiches</span>
        <div class="carte-actions">
          <button type="button" class="btn btn--xs ${filtreBureaux === "tous" ? "btn--primary" : "btn--ghost"}" data-filtre="tous">Tous (${depouilles.length})</button>
          <button type="button" class="btn btn--xs ${filtreBureaux === "gagnes" ? "btn--primary" : "btn--ghost"}" data-filtre="gagnes">Gagnes (${gagnes.length})</button>
          <button type="button" class="btn btn--xs ${filtreBureaux === "perdus" ? "btn--primary" : "btn--ghost"}" data-filtre="perdus">Perdus (${perdus.length})</button>
          <button type="button" class="btn btn--xs ${filtreBureaux === "nondep" ? "btn--primary" : "btn--ghost"}" data-filtre="nondep">Non depouilles (${lignes.length - depouilles.length})</button>
        </div>
      </div>
      <div class="filtre-bar__actions">
        <button type="button" class="btn btn--ghost" id="an-el-csv">&#8681; CSV</button>
        <button type="button" class="btn btn--primary" id="an-el-pdf">&#128438; PDF</button>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card stat-card--blue"><div class="stat-card__value">${totalInscrits.toLocaleString("fr-FR")}</div><div class="stat-card__label">Inscrits (bureaux depouilles)</div></div>
      <div class="stat-card stat-card--green"><div class="stat-card__value">${totalInscrits ? ((totalVotants / totalInscrits) * 100).toFixed(1) + " %" : "—"}</div><div class="stat-card__label">Participation</div></div>
      <div class="stat-card stat-card--amber"><div class="stat-card__value">${gagnes.length}/${depouilles.length}</div><div class="stat-card__label">Bureaux gagnes</div></div>
      <div class="stat-card stat-card--slate"><div class="stat-card__value">${totalExprimes.toLocaleString("fr-FR")}</div><div class="stat-card__label">Suffrages exprimes</div></div>
      <div class="stat-card"><div class="stat-card__value">${penetrationMoyenne.toFixed(2)} %</div><div class="stat-card__label">Penetration militante</div></div>
    </div>

    <div class="analyse-grille" style="margin-top:14px;">
      <div class="analyse-panneau">
        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Classement des candidats</h4>
          <div class="leaderboard" id="an-el-classement"></div>
          <p class="carte-note">${election.candidatReference
        ? `Reference : <b>${escapeHtml(election.candidatReference)}</b>. Un bureau est "gagne" lorsque cette reference y arrive en tete.`
        : `Aucun candidat de reference defini pour ce scrutin : les colonnes "Notre score" et le statut gagne / perdu restent vides. Renseignez-le dans l'onglet "Elections et resultats".`}</p>
        </div>
        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Cle de lecture</h4>
          <div class="stat-liste">
            <div class="stat-liste__ligne"><span>Bureaux depouilles</span><b>${depouilles.length} / ${lignes.length}</b></div>
            <div class="stat-liste__ligne"><span>Bulletins nuls</span><b>${totalNuls.toLocaleString("fr-FR")}${totalVotants ? ` (${((totalNuls / totalVotants) * 100).toFixed(1)} %)` : ""}</b></div>
            <div class="stat-liste__ligne"><span>Membres dans ces bureaux</span><b>${totalMembres}</b></div>
            <div class="stat-liste__ligne"><span>Primo-votants (vs ${anneePrecedente})</span><b>${depouilles.reduce((t, l) => t + l.primoVotants, 0)}</b></div>
            <div class="stat-liste__ligne"><span>Cartes de membre</span><b>${depouilles.reduce((t, l) => t + l.porteursCarte, 0)}</b></div>
          </div>
        </div>
        ${bloc("A reconquerir", reconquete, "Bureaux perdus alors que notre implantation y est superieure a la moyenne : le potentiel existe deja.")}
        ${bloc("A consolider", consolidation, "Bureaux gagnes avec une implantation inferieure a la moyenne : victoire fragile, a securiser.")}
        ${bloc("Bureaux les plus serres", serres, "Ecart le plus faible rapporte aux suffrages exprimes : quelques voix font basculer le resultat.")}
      </div>
      <div>
        <p class="tableau-note" id="an-el-note"></p>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr>${entetes.map((h, i) => `<th${[3, 4, 5, 6, 7, 9, 10, 12, 13, 14, 16, 17].includes(i) ? ' class="num"' : ""}>${escapeHtml(h)}</th>`).join("")}</tr></thead>
            <tbody id="an-el-tbody"></tbody>
          </table>
          <div id="an-el-vide"></div>
        </div>
      </div>
    </div>`;
    // Classement global des candidats.
    const maxVoix = Math.max(1, ...global.map(c => c.voix));
    $("#an-el-classement").innerHTML = global.length ? global.map((c, i) => {
        const estRef = election.candidatReference && (cleNom(c.candidat) === cleNom(election.candidatReference) || cleNom(c.parti) === cleNom(election.candidatReference));
        return `
      <div class="leaderboard-row">
        <div class="leaderboard-row__rank leaderboard-row__rank--${i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "default"}">${c.rang}</div>
        <div class="leaderboard-row__info">
          <div class="leaderboard-row__name">${escapeHtml(c.candidat)}${estRef ? ` <span class="badge badge--success">reference</span>` : ""}</div>
          <div class="leaderboard-row__meta">${escapeHtml(c.parti || "—")} · ${c.bureaux} bureau(x)</div>
        </div>
        <div class="leaderboard-row__bar"><div class="leaderboard-row__bar-fill" style="width:${(c.voix / maxVoix) * 100}%"></div></div>
        <div class="leaderboard-row__count">${c.voix.toLocaleString("fr-FR")} · ${c.part.toFixed(1)} %</div>
      </div>`;
    }).join("") : emptyState("Aucun resultat importe pour ce scrutin.");
    let affichees = [];
    function appliquer() {
        const q = cleNom($("#an-el-q").value);
        affichees = lignes.filter(l => {
            if (filtreBureaux === "gagnes" && l.gagne !== true)
                return false;
            if (filtreBureaux === "perdus" && l.gagne !== false)
                return false;
            if (filtreBureaux === "nondep" && l.depouille)
                return false;
            if (filtreBureaux === "tous" && !l.depouille)
                return false;
            if (!q)
                return true;
            return cleNom(`${l.bureau.commune} ${l.bureau.lieuVote} ${l.bureau.numeroBureau}`).includes(q);
        }).sort((a, b) => b.exprimes - a.exprimes);
        $("#an-el-note").textContent = `${affichees.length} bureau(x) affiche(s). Cliquez une ligne pour voir le classement complet des candidats dans ce bureau.`;
        $("#an-el-tbody").innerHTML = affichees.map(l => `
      <tr class="data-row--clickable" data-bureau="${l.bureau.id}">
        <td>${escapeHtml(l.bureau.commune || "—")}</td>
        <td>${escapeHtml(l.bureau.lieuVote)}</td>
        <td>${escapeHtml(l.bureau.numeroBureau)}</td>
        <td class="num">${l.inscrits.toLocaleString("fr-FR")}</td>
        <td class="num">${l.votants.toLocaleString("fr-FR")}</td>
        <td class="num">${l.participation == null ? "—" : l.participation.toFixed(1) + " %"}</td>
        <td class="num">${l.exprimes.toLocaleString("fr-FR")}</td>
        <td class="num">${l.nuls}</td>
        <td>${l.gagnant ? escapeHtml(l.gagnant.candidat) : "—"}</td>
        <td class="num">${l.gagnant ? l.gagnant.voix : "—"}</td>
        <td class="num">${l.gagnant?.part == null ? "—" : l.gagnant.part.toFixed(1) + " %"}</td>
        <td>${l.reference ? `${escapeHtml(l.reference.candidat)} <span class="badge badge--muted">${l.reference.rang}e</span>` : "—"}</td>
        <td class="num">${l.reference ? l.reference.voix : "—"}</td>
        <td class="num">${l.reference?.part == null ? "—" : l.reference.part.toFixed(1) + " %"}</td>
        <td class="num">${l.ecart == null ? "—" : (l.ecart > 0 ? "+" : "") + l.ecart}</td>
        <td>${!l.depouille ? `<span class="badge badge--muted">Non depouille</span>`
            : l.gagne === null ? "—"
                : l.gagne ? `<span class="badge badge--success">Gagne</span>` : `<span class="badge badge--warn">Perdu</span>`}</td>
        <td class="num">${l.membres}</td>
        <td class="num">${l.penetration == null ? "—" : l.penetration.toFixed(2) + " %"}</td>
      </tr>`).join("");
        $("#an-el-vide").innerHTML = affichees.length ? "" : emptyState("Aucun bureau ne correspond a ce filtre.");
        $("#an-el-tbody").querySelectorAll("[data-bureau]").forEach(tr => tr.addEventListener("click", () => {
            const l = lignes.find(x => x.bureau.id === Number(tr.dataset.bureau));
            if (l)
                ouvrirClassementBureau(l, election);
        }));
    }
    appliquer();
    $("#an-el-q").addEventListener("input", appliquer);
    contenu.querySelectorAll("[data-filtre]").forEach(b => b.addEventListener("click", () => {
        filtreBureaux = b.dataset.filtre;
        renderView();
    }));
    $("#an-el-election").addEventListener("change", (e) => {
        electionSelectionnee = Number(e.target.value);
        renderView();
    });
    $("#an-el-csv").addEventListener("click", () => {
        if (!affichees.length) {
            toast("Aucun bureau a exporter.", "info");
            return;
        }
        exporterCSV(`resultats_${election.type}_${election.annee}.csv`, entetes, affichees.map(ligneExport));
    });
    $("#an-el-pdf").addEventListener("click", () => {
        if (!affichees.length) {
            toast("Aucun bureau a exporter.", "info");
            return;
        }
        exporterPDF(`Analyse electorale — ${libelleElection(election)}`, `
      <div class="pdf-resume">
        <div class="pdf-tuile"><b>${totalInscrits.toLocaleString("fr-FR")}</b><span>Inscrits</span></div>
        <div class="pdf-tuile"><b>${totalInscrits ? ((totalVotants / totalInscrits) * 100).toFixed(1) + " %" : "—"}</b><span>Participation</span></div>
        <div class="pdf-tuile"><b>${gagnes.length}/${depouilles.length}</b><span>Bureaux gagnes</span></div>
        <div class="pdf-tuile"><b>${totalExprimes.toLocaleString("fr-FR")}</b><span>Exprimes</span></div>
        <div class="pdf-tuile"><b>${penetrationMoyenne.toFixed(2)} %</b><span>Penetration militante</span></div>
      </div>
      <p><b>Candidat de reference :</b> ${escapeHtml(election.candidatReference || "non defini")}
         &middot; <b>Filtre :</b> ${filtreBureaux === "tous" ? "tous les bureaux depouilles" : filtreBureaux === "gagnes" ? "bureaux gagnes" : filtreBureaux === "perdus" ? "bureaux perdus" : "bureaux non depouilles"}</p>
      <h2>Classement des candidats</h2>
      ${tableauPDF(["Rang", "Candidat", "Parti", "Voix", "%", "Bureaux"], global.map(c => [c.rang, c.candidat, c.parti || "—", c.voix, c.part.toFixed(1) + " %", c.bureaux]))}
      <h2>Resultats par bureau (${affichees.length})</h2>
      ${tableauPDF(entetes, affichees.map(ligneExport))}
      ${reconquete.length ? `<h2>Bureaux a reconquerir</h2>${tableauPDF(["Bureau", "Penetration militante", "Retard en voix"], reconquete.map(l => [libelleBureau(l.bureau), (l.penetration ?? 0).toFixed(2) + " %", l.ecart]))}` : ""}
      ${consolidation.length ? `<h2>Bureaux a consolider</h2>${tableauPDF(["Bureau", "Penetration militante", "Avance en voix"], consolidation.map(l => [libelleBureau(l.bureau), (l.penetration ?? 0).toFixed(2) + " %", l.ecart]))}` : ""}`, "landscape");
    });
}
// Classement complet des candidats dans un bureau donne.
function ouvrirClassementBureau(l, election) {
    const entetes = ["Rang", "Candidat", "Parti", "Voix", "% des exprimes"];
    const lignes = l.classement.map(c => [c.rang, c.candidat, c.parti || "—", c.voix, c.part == null ? "—" : c.part.toFixed(2) + " %"]);
    ouvrirModale({
        titre: `${libelleBureau(l.bureau)} — ${libelleElection(election)}`,
        taille: "wide",
        contenuHtml: `
      <p class="liste-resume">
        ${l.inscrits.toLocaleString("fr-FR")} inscrit(s) &middot; ${l.votants.toLocaleString("fr-FR")} votant(s)
        &middot; participation <b>${l.participation == null ? "—" : l.participation.toFixed(1) + " %"}</b>
        &middot; ${l.exprimes.toLocaleString("fr-FR")} exprime(s), ${l.nuls} nul(s)
      </p>
      <p class="liste-resume">
        ${l.membres} membre(s) y votent (penetration <b>${l.penetration == null ? "—" : l.penetration.toFixed(2) + " %"}</b>)
        &middot; ${l.porteursCarte} carte(s) de membre &middot; ${l.primoVotants} primo-votant(s)
        &middot; ${!l.depouille ? `<span class="badge badge--muted">Non depouille</span>`
            : l.gagne === null ? ""
                : l.gagne ? `<span class="badge badge--success">Bureau gagne</span>` : `<span class="badge badge--warn">Bureau perdu</span>`}
      </p>
      <div class="table-wrap">
        <table class="data-table">
          <thead><tr>${entetes.map((h, i) => `<th${i >= 3 ? ' class="num"' : ""}>${escapeHtml(h)}</th>`).join("")}</tr></thead>
          <tbody>${lignes.map((r, i) => `<tr${i === 0 ? ' style="font-weight:700;"' : ""}>${r.map((c, j) => `<td${j >= 3 ? ' class="num"' : ""}>${escapeHtml(String(c))}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
        ${lignes.length ? "" : emptyState("Ce bureau n'a pas encore de resultats importes.")}
      </div>
      <div class="liste-outils" style="margin-top:12px;">
        <button type="button" class="btn btn--ghost" id="cb-csv">&#8681; Exporter CSV</button>
        <button type="button" class="btn btn--primary" id="cb-pdf">&#128438; Exporter PDF</button>
      </div>`,
        onMonte: (contenu) => {
            contenu.querySelector("#cb-csv").addEventListener("click", () => exporterCSV(`classement_${l.bureau.cle.replace(/[^\w]+/g, "_")}.csv`, entetes, lignes));
            contenu.querySelector("#cb-pdf").addEventListener("click", () => exporterPDF(`${libelleBureau(l.bureau)} — ${libelleElection(election)}`, `
        <div class="pdf-resume">
          <div class="pdf-tuile"><b>${l.inscrits.toLocaleString("fr-FR")}</b><span>Inscrits</span></div>
          <div class="pdf-tuile"><b>${l.participation == null ? "—" : l.participation.toFixed(1) + " %"}</b><span>Participation</span></div>
          <div class="pdf-tuile"><b>${l.exprimes.toLocaleString("fr-FR")}</b><span>Exprimes</span></div>
          <div class="pdf-tuile"><b>${l.membres}</b><span>Membres</span></div>
        </div>
        <h2>Classement des candidats</h2>
        ${tableauPDF(entetes, lignes)}`));
        },
    });
}
// ---------------- Onglet 4 : primo-votants ------------------------------
function rendreOngletPrimoVotants(contenu, { d, anneeCourante }) {
    const scrutins = d.elections.slice().sort((a, b) => b.annee - a.annee);
    contenu.innerHTML = `
    <div class="filtre-bar">
      <label class="filtre-groupe" style="min-width:250px;">
        <span>Reference</span>
        <select id="pv-reference">
          <option value="">Annee en cours (${anneeCourante}), 5 ans de recul</option>
          ${scrutins.map(e => `<option value="${e.id}">${escapeHtml(libelleElection(e))}</option>`).join("")}
        </select>
      </label>
      <label class="filtre-groupe" style="min-width:130px;">
        <span>Annee du scrutin</span>
        <input type="number" id="pv-annee" min="1960" max="2100" value="${anneeCourante}">
      </label>
      <label class="filtre-groupe" style="min-width:150px;">
        <span>Scrutin precedent</span>
        <input type="number" id="pv-precedent" min="1960" max="2100" value="${anneeCourante - 5}">
      </label>
      <label class="filtre-groupe" style="min-width:210px;">
        <span>Electeur</span>
        <select id="pv-electeur">
          <option value="">Tous</option>
          <option value="Oui">Deja inscrits (Electeur = Oui)</option>
          <option value="Non">Pas encore inscrits (Electeur = Non)</option>
        </select>
      </label>
      <label class="filtre-groupe" style="flex:1;min-width:180px;">
        <span>Rechercher</span>
        <input type="search" id="pv-q" placeholder="Nom, lieu de vote, cellule...">
      </label>
      <div class="filtre-bar__actions">
        <button type="button" class="btn btn--ghost" id="pv-csv">&#8681; CSV</button>
        <button type="button" class="btn btn--primary" id="pv-pdf">&#128438; PDF</button>
      </div>
    </div>
    <p class="tableau-note">Un primo-votant est un membre ayant atteint 18 ans <b>apres</b> le scrutin precedent : il n'avait donc pas pu voter alors. Le filtre <b>Electeur</b> permet de voir ceux qui sont <b>deja inscrits</b> (Electeur = Oui) et ceux qui ne le sont <b>pas encore</b> (Electeur = Non).</p>
    <div class="stat-grid" id="pv-stats"></div>
    <div class="analyse-grille" style="margin-top:14px;">
      <div class="analyse-panneau">
        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Par cellule</h4>
          <div class="leaderboard" id="pv-cellules"></div>
        </div>
        <div class="carte-bloc">
          <h4 class="carte-bloc__titre">Par bureau de vote</h4>
          <div class="leaderboard" id="pv-bureaux"></div>
        </div>
      </div>
      <div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr>
              <th>Prenom &amp; nom</th><th>Reference</th><th>Sexe</th><th class="num">Age</th><th class="num">18 ans en</th>
              <th>Telephone</th><th>Cellule</th><th>Section</th><th>Lieu de vote</th><th>Bureau</th>
              <th>Carte membre</th><th>Bureau connu</th><th>Electeur</th>
            </tr></thead>
            <tbody id="pv-tbody"></tbody>
          </table>
          <div id="pv-vide"></div>
        </div>
      </div>
    </div>`;
    const nom = (liste, id) => liste.find(x => x.id === id)?.nom || "—";
    const clesBureaux = new Set(d.bureaux.map(b => b.cle));
    const entetes = ["Prenom & nom", "Reference", "Sexe", "Age", "18 ans en", "Telephone",
        "Cellule", "Section", "Lieu de vote", "Bureau", "Carte membre", "Bureau connu", "Electeur"];
    let liste = [];
    let annee = anneeCourante;
    let precedent = anneeCourante - 5;
    const ligneExport = (m) => {
        const maj = anneeMajorite(m.dateNaissance);
        return [nomComplet(m), m.reference, m.sexe || "—",
            maj == null ? "—" : String(annee - (maj - 18)), maj == null ? "—" : String(maj),
            m.telephone || "—", nom(d.cellules, m.celluleId), nom(d.sections, m.sectionId),
            m.lieuVote || "—", m.bureauVote || "—",
            m.carteMembre === "Oui" ? (m.numeroCarteMembre || "Oui") : "Non",
            clesBureaux.has(cleBureauMembre(m)) ? "Oui" : "Non",
            m.electeur === "Oui" ? "Inscrit" : m.electeur === "Non" ? "Pas encore inscrit" : "—"];
    };
    function recalculer() {
        annee = Number($("#pv-annee").value) || anneeCourante;
        precedent = Number($("#pv-precedent").value);
        if (!isFinite(precedent))
            precedent = annee - 5;
        const q = cleNom($("#pv-q").value);
        const filtreElecteur = $("#pv-electeur").value;
        liste = d.membres
            .filter(m => atteintMajoriteEntre(m, annee, precedent))
            .filter(m => !filtreElecteur || m.electeur === filtreElecteur)
            .filter(m => !q || cleNom(`${nomComplet(m)} ${m.lieuVote || ""} ${nom(d.cellules, m.celluleId)} ${m.reference}`).includes(q))
            .sort((a, b) => nomComplet(a).localeCompare(nomComplet(b), "fr"));
        dessiner();
    }
    function dessiner() {
        const avecBureau = liste.filter(m => clesBureaux.has(cleBureauMembre(m))).length;
        const porteurs = liste.filter(aCarteMembre).length;
        const totalElecteurs = d.membres.filter(m => m.electeur === "Oui").length;
        const inscritsListe = liste.filter(m => m.electeur === "Oui").length;
        const pasInscritsListe = liste.filter(m => m.electeur === "Non").length;
        $("#pv-stats").innerHTML = `
      <div class="stat-card stat-card--green"><div class="stat-card__value">${liste.length}</div><div class="stat-card__label">Primo-votants (${precedent} &rarr; ${annee})</div></div>
      <div class="stat-card stat-card--blue"><div class="stat-card__value">${totalElecteurs ? ((inscritsListe / totalElecteurs) * 100).toFixed(1) + " %" : "—"}</div><div class="stat-card__label">Part des electeurs de la base (inscrits)</div></div>
      <div class="stat-card stat-card--amber"><div class="stat-card__value">${inscritsListe}/${pasInscritsListe}</div><div class="stat-card__label">Deja inscrits / pas encore inscrits</div></div>
      <div class="stat-card stat-card--amber"><div class="stat-card__value">${avecBureau}</div><div class="stat-card__label">Rattaches a un bureau connu</div></div>
      <div class="stat-card stat-card--slate"><div class="stat-card__value">${porteurs}</div><div class="stat-card__label">Deja porteurs d'une carte</div></div>
      <div class="stat-card"><div class="stat-card__value">${liste.filter(m => m.sexe === "F").length}/${liste.filter(m => m.sexe === "M").length}</div><div class="stat-card__label">Femmes / hommes</div></div>`;
        const grouper = (cle) => {
            const map = new Map();
            for (const m of liste) {
                const k = cle(m);
                map.set(k, (map.get(k) || 0) + 1);
            }
            return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
        };
        const barres = (entrees, vide) => {
            if (!entrees.length)
                return emptyState(vide);
            const max = Math.max(1, ...entrees.map(e => e[1]));
            return entrees.map(([label, n], i) => `
        <div class="leaderboard-row">
          <div class="leaderboard-row__rank leaderboard-row__rank--${i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "default"}">${i + 1}</div>
          <div class="leaderboard-row__info"><div class="leaderboard-row__name">${escapeHtml(label)}</div></div>
          <div class="leaderboard-row__bar"><div class="leaderboard-row__bar-fill" style="width:${(n / max) * 100}%"></div></div>
          <div class="leaderboard-row__count">${n}</div>
        </div>`).join("");
        };
        $("#pv-cellules").innerHTML = barres(grouper(m => nom(d.cellules, m.celluleId)), "Aucun primo-votant.");
        $("#pv-bureaux").innerHTML = barres(grouper(m => (m.lieuVote ? `${m.lieuVote} — ${m.bureauVote || "?"}` : "Bureau non renseigne")), "Aucun primo-votant.");
        $("#pv-tbody").innerHTML = liste.map(m => `<tr>${ligneExport(m).map((c, i) => `<td${i === 3 || i === 4 ? ' class="num"' : ""}>${escapeHtml(String(c))}</td>`).join("")}</tr>`).join("");
        $("#pv-vide").innerHTML = liste.length ? "" : emptyState("Aucun primo-votant sur cette periode.");
    }
    $("#pv-reference").addEventListener("change", (e) => {
        const id = Number(e.target.value);
        if (!id) {
            $("#pv-annee").value = String(anneeCourante);
            $("#pv-precedent").value = String(anneeCourante - 5);
        }
        else {
            const election = d.elections.find(x => x.id === id);
            $("#pv-annee").value = String(election.annee);
            $("#pv-precedent").value = String(anneeScrutinPrecedent(election, d.elections));
        }
        recalculer();
    });
    ["#pv-annee", "#pv-precedent", "#pv-q"].forEach(sel => $(sel).addEventListener("input", recalculer));
    $("#pv-electeur").addEventListener("change", recalculer);
    recalculer();
    $("#pv-csv").addEventListener("click", () => {
        if (!liste.length) {
            toast("Aucun primo-votant a exporter.", "info");
            return;
        }
        exporterCSV(`primo_votants_${annee}.csv`, entetes, liste.map(ligneExport));
    });
    $("#pv-pdf").addEventListener("click", () => {
        if (!liste.length) {
            toast("Aucun primo-votant a exporter.", "info");
            return;
        }
        exporterPDF(`Primo-votants ${annee}`, `
      <div class="pdf-resume">
        <div class="pdf-tuile"><b>${liste.length}</b><span>Primo-votants</span></div>
        <div class="pdf-tuile"><b>${precedent} &rarr; ${annee}</b><span>Periode</span></div>
        <div class="pdf-tuile"><b>${liste.filter(aCarteMembre).length}</b><span>Avec carte de membre</span></div>
        <div class="pdf-tuile"><b>${liste.filter(m => m.sexe === "F").length}/${liste.filter(m => m.sexe === "M").length}</b><span>Femmes / hommes</span></div>
      </div>
      <p>Membres ayant atteint 18 ans entre ${precedent + 1} et ${annee} : ils votent pour la premiere fois a ce scrutin.${$("#pv-electeur").value ? ` Filtre Electeur : ${$("#pv-electeur").value === "Oui" ? "deja inscrits" : "pas encore inscrits"}.` : ""}</p>
      <h2>Liste des primo-votants (${liste.length})</h2>
      ${tableauPDF(entetes, liste.map(ligneExport))}`, "landscape");
    });
}
// ---------------- Onglet 5 : trouver un membre ---------------------------
// Recherche d'un membre sur un ou plusieurs criteres (combines par ET) et
// correlation de sa fiche avec la carte electorale chargee. La carte importee
// decrit les BUREAUX de vote (pas les electeurs nominativement) : la
// verification porte donc sur le statut Electeur de la fiche et sur la
// coherence de sa commune / lieu / bureau de vote avec la carte.
function rendreOngletTrouverMembre(contenu, { d }) {
    const nom = (liste, id) => liste.find(x => x.id === id)?.nom || "";
    const champs = [
        ["nom", "Nom", "text"], ["prenom", "Prenom", "text"], ["dateNaissance", "Date de naissance", "date"],
        ["telephone", "Telephone", "text"], ["numeroElecteur", "N° d'electeur", "text"], ["reference", "Reference", "text"],
        ["communeVote", "Commune de vote", "text"], ["lieuVote", "Lieu de vote", "text"], ["bureauVote", "Bureau de vote", "text"],
    ];
    contenu.innerHTML = `
    ${d.bureaux.length ? "" : `<p class="form-note form-note--warn">Aucune carte electorale n'est chargee : la correlation avec les bureaux de vote est impossible tant qu'elle n'est pas importee (onglet Bureaux de vote).</p>`}
    <div class="filtre-bar" style="flex-wrap:wrap;">
      ${champs.map(([k, label, type]) => `
      <label class="filtre-groupe" style="min-width:150px;flex:1;">
        <span>${label}</span>
        <input type="${type === "date" ? "date" : "search"}" id="tm-${k}" autocomplete="off">
      </label>`).join("")}
      <div class="filtre-bar__actions">
        <button type="button" class="btn btn--ghost" id="tm-csv" title="Exporter les resultats au format CSV">&#8681; CSV</button>
        <button type="button" class="btn btn--ghost" id="tm-pdf" title="Exporter les resultats au format PDF">&#128438; PDF</button>
        <button type="button" class="btn btn--ghost" id="tm-reset">Effacer</button>
      </div>
    </div>
    <p class="tableau-note">Saisissez <b>un ou plusieurs criteres</b> (ils se cumulent) : la recherche est partielle et ignore la casse et les accents. Chaque membre trouve est confronte a la carte electorale chargee : statut electeur, commune, lieu et bureau de vote. La carte decrit les bureaux de vote : un membre est dit <b>confirme</b> lorsque son bureau existe bien dans la carte.</p>
    <div id="tm-resultats"></div>`;
    const lire = () => Object.fromEntries(champs.map(([k]) => [k, $(`#tm-${k}`).value.trim()]));
    const chiffres = (x) => String(x ?? "").replace(/\D/g, "");
    const contient = (val, q) => !q || cleNom(val || "").includes(cleNom(q));
    const correspond = (m, c) => {
        if (!contient(m.nom, c.nom) || !contient(m.prenom, c.prenom) || !contient(m.reference, c.reference))
            return false;
        if (!contient(m.communeVote, c.communeVote) || !contient(m.lieuVote, c.lieuVote))
            return false;
        if (c.dateNaissance && String(m.dateNaissance || "").slice(0, 10) !== c.dateNaissance)
            return false;
        if (c.telephone && !chiffres(m.telephone).includes(chiffres(c.telephone)))
            return false;
        if (c.numeroElecteur && (!chiffres(c.numeroElecteur) || !chiffres(m.numeroElecteur).includes(chiffres(c.numeroElecteur))))
            return false;
        if (c.bureauVote && (!chiffres(c.bureauVote) || chiffres(m.bureauVote).padStart(2, "0") !== chiffres(c.bureauVote).padStart(2, "0")))
            return false;
        return true;
    };
    // Confronte la fiche a la carte electorale chargee.
    const verifier = (m) => {
        const cle = cleBureauMembre(m);
        const aLieuEtBureau = !!m.lieuVote && !!m.bureauVote;
        const strict = aLieuEtBureau ? d.bureaux.filter(b => cleBureauVote(b.lieuVote, b.numeroBureau) === cle
            && (!m.communeVote || cleNom(b.commune) === cleNom(m.communeVote))) : [];
        const ailleurs = aLieuEtBureau && !strict.length ? d.bureaux.filter(b => cleBureauVote(b.lieuVote, b.numeroBureau) === cle) : [];
        let niveau, texte;
        if (m.electeur === "Non") {
            niveau = "warn";
            texte = "Non inscrit sur le fichier electoral (Electeur = Non)";
        }
        else if (!d.bureaux.length) {
            niveau = "muted";
            texte = m.electeur === "Oui" ? "Electeur declare — carte electorale non chargee, verification impossible" : "Statut electeur non renseigne — carte electorale non chargee";
        }
        else if (m.electeur === "Oui" && strict.length) {
            niveau = "success";
            texte = "Present : electeur declare, bureau confirme dans la carte electorale";
        }
        else if (m.electeur === "Oui" && !aLieuEtBureau) {
            niveau = "warn";
            texte = "Electeur declare, mais lieu et/ou bureau de vote non renseigne(s) : verification impossible";
        }
        else if (m.electeur === "Oui" && ailleurs.length) {
            niveau = "warn";
            texte = `Electeur declare : ce lieu et ce bureau existent dans la carte, mais pour la commune ${[...new Set(ailleurs.map(b => b.commune))].join(" / ")} (et non ${m.communeVote})`;
        }
        else if (m.electeur === "Oui") {
            niveau = "danger";
            texte = "Electeur declare, mais ce lieu / bureau de vote est introuvable dans la carte electorale";
        }
        else if (strict.length) {
            niveau = "info";
            texte = "Statut electeur non renseigne — son bureau de vote existe dans la carte electorale";
        }
        else {
            niveau = "muted";
            texte = "Statut electeur non renseigne — aucun bureau de vote confirme dans la carte";
        }
        return { niveau, texte, bureaux: strict.length ? strict : ailleurs };
    };
    const MAX = 50;
    let dernier = { c: {}, resultats: [] };
    const ligneInfo = (label, valeur) => `<div class="fiche-row"><span class="fiche-row__label">${escapeHtml(label)}</span><span class="fiche-row__value">${escapeHtml(valeur === undefined || valeur === null || valeur === "" ? "—" : String(valeur))}</span></div>`;
    function rechercher() {
        const c = lire();
        const zone = $("#tm-resultats");
        if (!Object.values(c).some(Boolean)) {
            dernier = { c, resultats: [] };
            zone.innerHTML = emptyState("Saisissez au moins un critere pour rechercher un membre.");
            return;
        }
        const trouves = d.membres.filter(m => correspond(m, c))
            .sort((a, b) => nomComplet(a).localeCompare(nomComplet(b), "fr"));
        dernier = { c, resultats: trouves.map(m => ({ m, v: verifier(m) })) };
        if (!trouves.length) {
            zone.innerHTML = `
        <div class="carte-bloc"><span class="badge badge--danger">Introuvable</span>
          <p style="margin:8px 0 0;">Aucune fiche membre ne correspond a ces criteres : cette personne n'est pas enregistree comme membre (ou un critere est mal saisi). Essayez avec moins de criteres.</p>
        </div>`;
            return;
        }
        const affiches = trouves.slice(0, MAX);
        zone.innerHTML = `
      <p class="form-note">${trouves.length} membre(s) trouve(s)${trouves.length > MAX ? ` — affichage des ${MAX} premiers : affinez la recherche` : ""}.</p>
      ${affiches.map(m => {
            const v = verifier(m);
            const b0 = v.bureaux[0];
            const communesCarte = [...new Set(v.bureaux.map(b => b.commune))].join(" / ");
            return `
      <div class="carte-bloc tm-carte" data-tm-fiche="${m.id}" title="Cliquer pour consulter la fiche du membre" style="margin-bottom:12px;">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
          ${avatarHtml(m.photoDataUrl, nomComplet(m), "sm")}
          <div style="flex:1;min-width:200px;">
            <div style="font-weight:700;font-size:15px;">${escapeHtml(nomComplet(m))}</div>
            <div class="fiche-bureau-row__role">${escapeHtml(m.reference || "")}</div>
          </div>
          <span class="badge badge--${v.niveau}">${escapeHtml(v.texte)}</span>
          <span class="btn btn--ghost" aria-hidden="true">Consulter la fiche &rarr;</span>
        </div>
        <div class="fiche-grid">
          ${ligneInfo("Electeur", m.electeur)}
          ${ligneInfo("N° d'electeur", m.numeroElecteur)}
          ${ligneInfo("Commune de vote", m.communeVote)}
          ${ligneInfo("Lieu de vote", m.lieuVote)}
          ${ligneInfo("Bureau de vote", m.bureauVote)}
          ${ligneInfo("Date de naissance", m.dateNaissance ? formatDateJJMMAAAA(m.dateNaissance) : "")}
          ${ligneInfo("Lieu de naissance", m.lieuNaissance)}
          ${ligneInfo("Telephone", m.telephone)}
          ${ligneInfo("Commune de residence", m.commune)}
          ${ligneInfo("Cellule / Section", [nom(d.cellules, m.celluleId), nom(d.sections, m.sectionId)].filter(Boolean).join(" / "))}
        </div>
        ${b0 ? `
        <h4 class="fiche-section-title">Dans la carte electorale</h4>
        <div class="fiche-grid">
          ${ligneInfo("Region", b0.region)}
          ${ligneInfo("Departement", b0.departement)}
          ${ligneInfo("Commune", communesCarte)}
          ${ligneInfo("Lieu de vote", b0.lieuVote)}
          ${ligneInfo("Bureau", b0.numeroBureau)}
          ${ligneInfo("Inscrits au bureau", v.bureaux.length === 1 ? (b0.inscrits ?? "").toLocaleString?.("fr-FR") ?? b0.inscrits : v.bureaux.reduce((t, b) => t + (b.inscrits || 0), 0).toLocaleString("fr-FR"))}
        </div>` : ""}
      </div>`;
        }).join("")}`;
        zone.querySelectorAll("[data-tm-fiche]").forEach(carte => carte.addEventListener("click", () => ouvrirFicheMembreDepuisAilleurs(Number(carte.dataset.tmFiche))));
    }
    const libelleCriteres = () => champs.filter(([k]) => dernier.c[k]).map(([k, label]) => `${label} : ${dernier.c[k]}`).join(" · ");
    $("#tm-csv").addEventListener("click", () => {
        if (!dernier.resultats.length) {
            toast("Aucun resultat a exporter : lancez d'abord une recherche.", "info");
            return;
        }
        const dj = (iso) => iso ? formatDateJJMMAAAA(iso) : "";
        exporterCSV(`recherche_membre_carte_electorale_${new Date().toISOString().slice(0, 10)}.csv`,
            ["N°", "Reference", "Nom", "Prenom", "Date de naissance", "Lieu de naissance", "Telephone", "Cellule", "Section",
                "Electeur", "N° d'electeur", "Commune de vote", "Lieu de vote", "Bureau de vote", "Verification",
                "Carte : region", "Carte : departement", "Carte : commune", "Carte : lieu de vote", "Carte : bureau", "Carte : inscrits"],
            dernier.resultats.map(({ m, v }) => {
                const b0 = v.bureaux[0];
                return [m.numero, m.reference, m.nom, m.prenom, dj(m.dateNaissance), m.lieuNaissance || "", m.telephone || "",
                    nom(d.cellules, m.celluleId), nom(d.sections, m.sectionId), m.electeur || "", m.numeroElecteur || "",
                    m.communeVote || "", m.lieuVote || "", m.bureauVote || "", v.texte,
                    b0?.region || "", b0?.departement || "", [...new Set(v.bureaux.map(b => b.commune))].join(" / "), b0?.lieuVote || "", b0?.numeroBureau || "",
                    b0 ? v.bureaux.reduce((t, b) => t + (b.inscrits || 0), 0) : ""];
            }));
    });
    $("#tm-pdf").addEventListener("click", () => {
        if (!dernier.resultats.length) {
            toast("Aucun resultat a exporter : lancez d'abord une recherche.", "info");
            return;
        }
        const r = dernier.resultats;
        const confirmes = r.filter(x => x.v.niveau === "success").length;
        const nonInscrits = r.filter(x => x.m.electeur === "Non").length;
        const aVerifier = r.length - confirmes - nonInscrits;
        exporterPDF("Recherche de membres — verification carte electorale", `
      <div class="pdf-resume">
        <div class="pdf-tuile"><b>${r.length}</b><span>Membres trouves</span></div>
        <div class="pdf-tuile"><b>${confirmes}</b><span>Presents (bureau confirme)</span></div>
        <div class="pdf-tuile"><b>${nonInscrits}</b><span>Non inscrits</span></div>
        <div class="pdf-tuile"><b>${aVerifier}</b><span>A verifier</span></div>
      </div>
      <div class="pdf-meta" style="text-align:left;margin-bottom:8px;">Criteres : ${escapeHtml(libelleCriteres())}</div>
      ${tableauPDF(["Reference", "Prenom & nom", "Telephone", "Electeur", "N° electeur", "Commune de vote", "Lieu de vote", "Bureau", "Verification"],
            r.map(({ m, v }) => [m.reference, nomComplet(m), m.telephone || "—", m.electeur || "—", m.numeroElecteur || "—",
                m.communeVote || "—", m.lieuVote || "—", m.bureauVote || "—", v.texte]))}`, "landscape");
    });
    champs.forEach(([k]) => $(`#tm-${k}`).addEventListener("input", rechercher));
    $("#tm-reset").addEventListener("click", () => {
        champs.forEach(([k]) => { $(`#tm-${k}`).value = ""; });
        rechercher();
    });
    rechercher();
}
// ------------------------------------------------------------------------
// 24. BOOTSTRAP
// ------------------------------------------------------------------------
function render() {
    const session = getSession();
    if (!session)
        renderHome();
    else
        renderShell();
}
async function bootstrap() {
    if (!getSession()) {
        render();
        return;
    }
    // Remise a plat des references (numerotation propre a chaque nom de
    // cellule / section). Les anciennes migrations de donnees locales ne sont
    // plus necessaires : la base PostgreSQL demarre vide.
    try {
        await synchroniserReferences();
    }
    catch (e) {
        console.error("Synchronisation des references impossible :", e);
    }
    render();
}
bootstrap();
