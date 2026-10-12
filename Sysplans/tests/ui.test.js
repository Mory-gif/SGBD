/* Test de l'interface dans un navigateur simulé (jsdom) contre un serveur réel. */
const { JSDOM, VirtualConsole } = require('jsdom');
const BASE = process.env.BASE || 'http://localhost:3111';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = 0, ko = 0;
const t = (n, c, i) => { c ? (ok++, console.log('  ✔', n)) : (ko++, console.log('  ✘', n, i !== undefined ? JSON.stringify(i) : '')); };

(async () => {
  const erreurs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => erreurs.push(String(e.message || e).slice(0, 200)));
  const dom = await JSDOM.fromURL(BASE + '/', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, BASE).href, o);       // fetch du Node vers le vrai serveur
      w.confirm = () => true; w.alert = () => {};
      w.matchMedia = w.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      w.L = new Proxy(function () {}, { get: () => () => new Proxy({}, { get: () => () => ({}) }) }); // Leaflet factice
      w.HTMLCanvasElement.prototype.getContext = () => null;
    } });
  const w = dom.window; const d = w.document;
  await wait(1500);
  t('page chargée, écran de connexion visible', d.querySelector('#loginScreen').style.display !== 'none');
  t('note de stockage : serveur PostgreSQL', /serveur/.test(d.querySelector('#storageNoteTxt').textContent));

  // mauvais mot de passe
  d.querySelector('#login-identifiant').value = 'admin';
  d.querySelector('#login-motdepasse').value = 'faux';
  d.querySelector('#btnLogin').click();
  await wait(800);
  t('mauvais mot de passe : message d\'erreur', /incorrect/.test(d.querySelector('#loginError').textContent), d.querySelector('#loginError').textContent);
  t('toujours sur l\'écran de connexion', d.querySelector('#appRoot').style.display === 'none');

  // bonne connexion
  d.querySelector('#login-motdepasse').value = 'Admin#2026';
  d.querySelector('#btnLogin').click();
  await wait(2000);
  t('connexion réussie : application affichée', d.querySelector('#appRoot').style.display !== 'none' && d.querySelector('#loginScreen').style.display === 'none', erreurs.slice(0, 3));
  t('jeton enregistré dans le navigateur', !!w.localStorage.getItem('sysplans:token'));
  t('aucun mot de passe stocké côté navigateur', !JSON.stringify(Object.assign({}, w.localStorage)).includes('Admin#2026'));

  // une catégorie est exigée avant toute activité : on la crée via l'API (administrateur)
  const tok0 = w.localStorage.getItem('sysplans:token');
  await fetch(BASE + '/api/categories/sync', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok0 },
    body: JSON.stringify({ upserts: [{ id: 'cat_ui', intitule: 'Catégorie UI', objectif: '', annee: 2026, actif: true, types: [] }] }) });
  // le rafraîchissement automatique ne les relit pas : on se reconnecte pour charger la catégorie
  d.querySelector('#btnLogout').click(); await wait(300);
  d.querySelector('#login-identifiant').value = 'admin'; d.querySelector('#login-motdepasse').value = 'Admin#2026';
  d.querySelector('#btnLogin').click(); await wait(2000);

  // créer une activité depuis l'interface
  const btnNew = [...d.querySelectorAll('button')].find((b) => /Nouvelle activité|Ajouter une activité/i.test(b.textContent));
  t('bouton de création d\'activité présent', !!btnNew);
  btnNew && btnNew.click();
  await wait(500);
  const radio = d.querySelector('input[name="type"][value="prospection"]');
  if (radio) { radio.checked = true; radio.dispatchEvent(new w.Event('change', { bubbles: true })); }
  await wait(300);
  const set = (id, v) => { const e = d.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new w.Event('input', { bubbles: true })); e.dispatchEvent(new w.Event('change', { bubbles: true })); } };
  set('f-categorie', 'cat_ui');
  set('f-titre', 'Prospection test UI');
  set('f-departement', 'Dakar'); set('f-commune', 'Plateau'); set('f-zone', 'Sandaga');
  set('f-date', '2026-11-20'); set('f-heure', '09:00');
  const save = d.querySelector('#btnSave');
  save && save.click();
  await wait(1500);
  console.log('   (toast :', d.querySelector('#toast').textContent, ')');

  // vérifier côté serveur
  const tok = w.localStorage.getItem('sysplans:token');
  const r = await fetch(BASE + '/api/activites', { headers: { Authorization: 'Bearer ' + tok } });
  const liste = await r.json();
  const a = liste.find((x) => x.titre === 'Prospection test UI');
  t('l\'activité créée dans l\'interface est enregistrée dans PostgreSQL', !!a, liste.map((x) => x.titre));
  if (a) {
    t('champs enregistrés (type, lieu, date)', a.type === 'prospection' && a.departement === 'Dakar' && a.date === '2026-11-20', a);
    // la modifier
    set('x', ''); 
  }

  // rechargement de la page : la session est restaurée par le jeton
  const dom2 = await JSDOM.fromURL(BASE + '/', { runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w2) {
      w2.fetch = (u, o) => fetch(new URL(u, BASE).href, o);
      w2.confirm = () => true; w2.alert = () => {};
      w2.matchMedia = w2.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
      w2.L = new Proxy(function () {}, { get: () => () => new Proxy({}, { get: () => () => ({}) }) });
      w2.HTMLCanvasElement.prototype.getContext = () => null;
      try { w2.localStorage.setItem('sysplans:token', tok); } catch (_) {}
    } });
  await wait(2500);
  t('actualisation de la page : session restaurée sans ressaisir le mot de passe', dom2.window.document.querySelector('#appRoot').style.display !== 'none');

  // déconnexion
  d.querySelector('#btnLogout').click();
  await wait(300);
  t('déconnexion : retour à l\'écran de connexion et jeton effacé', d.querySelector('#loginScreen').style.display !== 'none' && !w.localStorage.getItem('sysplans:token'));

  console.log('\nErreurs JS de la page :', erreurs.length ? erreurs.slice(0, 5) : 'aucune');
  console.log(`${ok} réussi(s), ${ko} échec(s)`);
  process.exit(ko ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
