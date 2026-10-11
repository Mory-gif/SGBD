/* Adresse de l'API.
   - Laisser vide ("") quand l'interface est servie par le serveur Node lui-même
     (cas d'un déploiement Render seul, ou du lancement en local).
   - Mettre l'adresse complète de l'API (sans "/" final) quand l'interface est
     hébergée ailleurs, par exemple sur Netlify :
         window.SGBD_API_BASE = "https://sgbd-pastef-rufisque.onrender.com";
*/
window.SGBD_API_BASE = "";
