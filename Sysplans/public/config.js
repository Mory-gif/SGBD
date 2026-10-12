/* ============================================================================
   SYSPLANS — config.js
   Adresse de l'API (le serveur Node.js).

   • Interface servie par le serveur lui-même (Render, ou en local avec
     « npm start ») : laissez la valeur vide ''. Les appels à l'API se font
     alors sur le même domaine.

   • Interface hébergée séparément (Netlify) : indiquez ici l'adresse publique
     du serveur sur Render, sans barre finale. Exemple :
         window.SYSPLANS_API_URL = 'https://sysplans-api.onrender.com';
     Pensez à autoriser l'adresse Netlify côté serveur (variable CORS_ORIGINS).
   ============================================================================ */
window.SYSPLANS_API_URL = '';
