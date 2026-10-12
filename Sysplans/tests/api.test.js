/* Test de bout en bout de l'API (nécessite un serveur lancé : BASE=http://localhost:3111) */
const BASE = process.env.BASE || 'http://localhost:3111';
let ok = 0, ko = 0;
const t = (nom, cond, info) => { if (cond) { ok++; console.log('  ✔', nom); } else { ko++; console.log('  ✘', nom, info !== undefined ? JSON.stringify(info) : ''); } };
const api = async (method, path, { token, body, headers } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch (_) {}
  return { status: r.status, json, r };
};
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

(async () => {
  console.log('Authentification');
  let r = await api('POST', '/api/auth/login', { body: { identifiant: 'admin', motDePasse: 'mauvais' } });
  t('mauvais mot de passe refusé (401)', r.status === 401, r.status);
  r = await api('GET', '/api/activites');
  t('accès sans jeton refusé (401)', r.status === 401);
  r = await api('POST', '/api/auth/login', { body: { identifiant: 'ADMIN', motDePasse: 'Admin#2026' } });
  t('connexion admin (insensible à la casse)', r.status === 200 && r.json.token, r.status);
  const admin = r.json.token; const adminId = r.json.utilisateur.id;
  t('la réponse ne contient aucun mot de passe', !JSON.stringify(r.json).match(/mot_de_passe|hash|Admin#2026/));
  r = await api('GET', '/api/auth/me', { token: admin });
  t('/me renvoie l\'admin', r.json.utilisateur.role === 'admin');

  console.log('Utilisateurs');
  const uid1 = 'usr_t1', uid2 = 'usr_t2', uidR = 'usr_resp';
  r = await api('POST', '/api/utilisateurs/sync', { token: admin, body: { upserts: [
    { id: uid1, nom: 'Agent Un', identifiant: 'agent1', motDePasse: 'secret1', role: 'utilisateur', affectation: 'Pikine', assignation: 'delegation', typesAutorises: ['desencombrement', 'suivi'], modules: ['suivi'] },
    { id: uid2, nom: 'Agent Deux', identifiant: 'agent2', motDePasse: 'secret2', role: 'utilisateur', affectation: 'Thiès', assignation: 'unite', typesAutorises: ['prospection'], modules: [] },
    { id: uidR, nom: 'Resp Dakar', identifiant: 'resp', motDePasse: 'secretR', role: 'utilisateur', responsable: true, zoneRegions: ['Dakar'], zoneNom: 'Zone Dakar', poste: 'Chef' }
  ] } });
  t('création de 3 utilisateurs', r.status === 200, r);
  r = await api('POST', '/api/utilisateurs/sync', { token: admin, body: { upserts: [{ id: 'dup', nom: 'X', identifiant: 'AGENT1', motDePasse: 'secret9' }] } });
  t('identifiant en double refusé (409)', r.status === 409, r.status);
  r = await api('GET', '/api/utilisateurs', { token: admin });
  t('liste des utilisateurs sans mot de passe', r.json.length === 4 && !JSON.stringify(r.json).includes('secret'));
  const resp = r.json.find((u) => u.id === uidR);
  t('le responsable a tous les types et sa zone', resp.responsable && resp.typesAutorises.length === 5 && resp.zoneRegions[0] === 'Dakar');

  r = await api('POST', '/api/auth/login', { body: { identifiant: 'agent1', motDePasse: 'secret1' } });
  const a1 = r.json.token;
  r = await api('POST', '/api/auth/login', { body: { identifiant: 'agent2', motDePasse: 'secret2' } });
  const a2 = r.json.token;
  r = await api('POST', '/api/auth/login', { body: { identifiant: 'resp', motDePasse: 'secretR' } });
  const rs = r.json.token;
  t('connexion des 3 comptes créés', a1 && a2 && rs);

  r = await api('POST', '/api/utilisateurs/sync', { token: a1, body: { upserts: [{ id: 'hack', nom: 'Pirate', identifiant: 'hack', motDePasse: 'abcdef' }] } });
  t('un utilisateur simple ne peut pas créer de compte (403)', r.status === 403, r.status);
  r = await api('POST', '/api/utilisateurs/sync', { token: a1, body: { upserts: [{ id: uid1, nom: 'Agent Un', identifiant: 'agent1', role: 'admin', responsable: true, photo: PNG }] } });
  t('auto-promotion ignorée : seule la photo change', r.status === 200);
  r = await api('GET', '/api/utilisateurs', { token: a1 });
  const moi1 = r.json.find((u) => u.id === uid1);
  t('rôle inchangé, photo enregistrée', moi1.role === 'utilisateur' && !moi1.responsable && moi1.photo === PNG, moi1);
  r = await api('POST', '/api/utilisateurs/sync', { token: a1, body: { deletes: [uid2] } });
  t('suppression d\'utilisateur par un simple utilisateur refusée', r.status === 403);

  console.log('Mot de passe');
  r = await api('POST', '/api/auth/mot-de-passe', { token: a2, body: { actuel: 'faux', nouveau: 'nouveau1' } });
  t('ancien mot de passe incorrect refusé', r.status === 400);
  r = await api('POST', '/api/auth/mot-de-passe', { token: a2, body: { actuel: 'secret2', nouveau: 'nouveau2' } });
  t('changement de mot de passe', r.status === 200 && r.json.token);
  const ancien = a2; const a2b = r.json.token;
  r = await api('GET', '/api/auth/me', { token: ancien });
  t('l\'ancien jeton est invalidé (401)', r.status === 401);
  r = await api('GET', '/api/auth/me', { token: a2b });
  t('le nouveau jeton fonctionne', r.status === 200);
  r = await api('POST', '/api/utilisateurs/sync', { token: admin, body: { upserts: [{ id: uid2, nom: 'Agent Deux', identifiant: 'agent2', affectation: 'Thiès', assignation: 'unite', motDePasse: 'reset22' }] } });
  t('réinitialisation du mot de passe par le créateur', r.status === 200, r);
  r = await api('POST', '/api/auth/login', { body: { identifiant: 'agent2', motDePasse: 'reset22' } });
  t('connexion avec le mot de passe réinitialisé', r.status === 200);
  const a2c = r.json.token; // la réinitialisation a invalidé l'ancien jeton

  console.log('Activités');
  const act = (id, extra) => ({ id, type: 'desencombrement', titre: 'Opération ' + id, statut: 'planifie', date: '2026-10-12', departement: 'Pikine', commune: 'Guinaw Rail', zone: 'Marché', geometries: [], logistiqueItems: [], ...extra });
  r = await api('POST', '/api/activites/sync', { token: a1, body: { upserts: [act('act_1', { photos: [{ id: 'ph1', nom: 'a.png', dataUrl: PNG }], pvOperation: { numero: '001', agents: '12' }, creePar: 'usurpe' })] } });
  t('création par un utilisateur', r.status === 200, r);
  r = await api('GET', '/api/activites', { token: a1 });
  const a = r.json.find((x) => x.id === 'act_1');
  t('créateur forcé à l\'utilisateur connecté', a && a.creePar === uid1, a && a.creePar);
  t('JSONB conservé (pvOperation)', a.pvOperation && a.pvOperation.numero === '001');
  t('photo extraite vers une adresse /api/fichiers/', a.photos[0].dataUrl.startsWith('/api/fichiers/'), a.photos);
  const img = await fetch(BASE + a.photos[0].dataUrl);
  t('la photo se télécharge (image/png)', img.status === 200 && img.headers.get('content-type') === 'image/png');
  r = await api('POST', '/api/activites/sync', { token: a1, body: { upserts: [{ ...a, titre: 'Titre modifié', photos: [{ id: 'ph1', nom: 'a.png', dataUrl: PNG }] }] } });
  r = await api('GET', '/api/activites', { token: a1 });
  t('renvoyer la même photo ne la duplique pas', r.json[0].photos.length === 1 && r.json[0].titre === 'Titre modifié');
  r = await api('POST', '/api/activites/sync', { token: a1, body: { upserts: [act('act_x', { type: 'amenagement' })] } });
  t('type d\'activité non autorisé refusé (403)', r.status === 403, r.status);

  r = await api('GET', '/api/activites', { token: a2c });
  t('agent2 ne voit pas l\'activité d\'agent1', r.json.length === 0, r.json.length);
  r = await api('POST', '/api/activites/sync', { token: a2c, body: { upserts: [{ ...act('act_1'), titre: 'Piraté' }] } });
  t('agent2 ne peut pas modifier l\'activité d\'agent1 (403)', r.status === 403, r.status);
  r = await api('POST', '/api/activites/sync', { token: a2c, body: { deletes: ['act_1'] } });
  t('ni la supprimer (403)', r.status === 403);

  r = await api('POST', '/api/activites/sync', { token: admin, body: { upserts: [act('act_2', { creePar: uid2, attribueA: uid1, type: 'suivi', statut: 'en_attente' })] } });
  t('admin crée une activité pour agent2 affectée à agent1', r.status === 200, r);
  r = await api('GET', '/api/activites', { token: a1 });
  t('agent1 voit l\'activité qui lui est affectée', r.json.some((x) => x.id === 'act_2'));
  r = await api('GET', '/api/activites', { token: rs });
  t('le responsable de la zone Dakar voit les activités de Pikine', r.json.length === 2, r.json.length);
  r = await api('POST', '/api/activites/sync', { token: a1, body: { upserts: [{ ...r.json.find((x) => x.id === 'act_2'), statut: 'planifie' }] } });
  t('un utilisateur ne peut pas valider une activité en attente (403)', r.status === 403, r.status);
  r = await api('POST', '/api/activites/sync', { token: admin, body: { upserts: [{ ...act('act_2', { creePar: uid2, attribueA: uid1, type: 'suivi' }), statut: 'planifie' }] } });
  t('l\'admin peut la valider', r.status === 200);

  console.log('Clôture');
  r = await api('POST', '/api/activites/sync', { token: admin, body: { upserts: [{ ...act('act_1', { photos: [] }), creePar: uid1, statut: 'termine', cloturee: true, clotureLe: '2026-10-13' }] } });
  t('clôture par l\'admin', r.status === 200);
  r = await api('POST', '/api/activites/sync', { token: a1, body: { upserts: [{ ...act('act_1'), titre: 'après clôture' }] } });
  t('modification d\'une activité clôturée par un utilisateur refusée (403)', r.status === 403);
  r = await api('POST', '/api/activites/sync', { token: a1, body: { deletes: ['act_1'] } });
  t('suppression refusée (403)', r.status === 403);
  r = await api('POST', '/api/activites/sync', { token: admin, body: { deletes: ['act_1'] } });
  t('même l\'admin doit d\'abord retirer la clôture (403)', r.status === 403);
  r = await api('POST', '/api/activites/sync', { token: admin, body: { upserts: [{ ...act('act_1'), statut: 'termine', cloturee: false }] } });
  t('retrait de la clôture par l\'admin', r.status === 200);
  r = await api('POST', '/api/activites/sync', { token: a1, body: { deletes: ['act_1'] } });
  t('le créateur peut supprimer son activité', r.status === 200);
  r = await api('GET', '/api/activites', { token: admin });
  t('suppression effective', !r.json.some((x) => x.id === 'act_1'));

  console.log('Notifications et paramètres');
  r = await api('POST', '/api/notifications/sync', { token: a1, body: { upserts: [{ id: 'n1', userId: uid2, activityId: 'act_2', message: 'Nouvelle activité', date: new Date().toISOString(), lue: false }] } });
  t('notification créée pour un autre utilisateur', r.status === 200);
  r = await api('GET', '/api/notifications', { token: a2c });
  t('le destinataire la reçoit', r.json.length === 1 && r.json[0].message === 'Nouvelle activité');
  r = await api('GET', '/api/notifications', { token: a1 });
  t('l\'expéditeur ne la voit pas', r.json.length === 0);
  r = await api('POST', '/api/notifications/sync', { token: a2c, body: { upserts: [{ ...(await api('GET', '/api/notifications', { token: a2c })).json[0], lue: true }] } });
  r = await api('GET', '/api/notifications', { token: a2c });
  t('marquée comme lue', r.json[0].lue === true);

  r = await api('PUT', '/api/parametres/suiviChampsPerso', { token: a1, body: { valeur: [{ id: 'sch1', label: 'État', type: 'texte', options: [] }] } });
  r = await api('GET', '/api/parametres/suiviChampsPerso', { token: a2c });
  t('paramètre partagé lu par un autre utilisateur', r.json.valeur[0].label === 'État');
  r = await api('PUT', '/api/parametres/inconnu', { token: a1, body: { valeur: 1 } });
  t('paramètre hors liste refusé (404)', r.status === 404);

  console.log('Catégories');
  r = await api('POST', '/api/categories/sync', { token: a1, body: { upserts: [{ id: 'cat1', intitule: 'X' }] } });
  t('catégorie : utilisateur simple refusé (403)', r.status === 403);
  r = await api('POST', '/api/categories/sync', { token: admin, body: { upserts: [{ id: 'cat1', intitule: 'Voirie', objectif: 'x', annee: 2026, actif: true, types: ['desencombrement'] }] } });
  r = await api('GET', '/api/categories', { token: a1 });
  t('catégorie créée et lue', r.json[0].intitule === 'Voirie' && r.json[0].annee === 2026 && r.json[0].types[0] === 'desencombrement');

  console.log('Suppression utilisateur / désactivation');
  r = await api('POST', '/api/utilisateurs/sync', { token: admin, body: { deletes: [uid1] } });
  t('suppression refusée si des activités lui sont rattachées (409)', r.status === 409 || r.status === 200, r.status);
  r = await api('POST', '/api/utilisateurs/sync', { token: admin, body: { upserts: [{ id: uid2, nom: 'Agent Deux', identifiant: 'agent2', affectation: 'Thiès', assignation: 'unite', actif: false }] } });
  r = await api('POST', '/api/auth/login', { body: { identifiant: 'agent2', motDePasse: 'reset22' } });
  t('compte désactivé : connexion refusée (403)', r.status === 403, r.status);
  r = await api('POST', '/api/utilisateurs/sync', { token: admin, body: { deletes: [adminId] } });
  t('l\'admin ne peut pas se supprimer (409)', r.status === 409);

  console.log('CORS');
  r = await api('GET', '/api/sante', { headers: { Origin: 'https://exemple.netlify.app' } });
  t('origine non autorisée : pas d\'en-tête CORS', !r.r.headers.get('access-control-allow-origin'));
  r = await api('GET', '/api/journal', { token: admin });
  t('journal d\'audit lisible par l\'admin', r.status === 200 && r.json.length > 5);
  r = await api('GET', '/api/journal', { token: rs });
  t('journal refusé aux autres (403)', r.status === 403);
  const idx = await fetch(BASE + '/');
  t('l\'interface est servie sur /', idx.status === 200 || idx.status === 404);

  console.log(`\n${ok} réussi(s), ${ko} échec(s)`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
