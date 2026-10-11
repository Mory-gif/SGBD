"use strict";
/* =========================================================================
   api-client.js — accès aux données via l'API serveur
   -------------------------------------------------------------------------
   Remplace la base locale IndexedDB (Dexie) de la version d'origine : cette
   classe expose les mêmes méthodes asynchrones que celles utilisées par
   l'interface (toArray, get, add, update, delete, where().equals(), filter(),
   bulkAdd, put...), de sorte que le reste du code n'a pas à changer.
   Chaque table est mise en cache dans le navigateur et revalidée auprès du
   serveur par un numéro de version (ETag) : une lecture inchangée ne coûte
   qu'une réponse 304 de quelques octets.
   ========================================================================= */
(function () {
    const BASE = String(window.SGBD_API_BASE || "").replace(/\/+$/, "");
    const SESSION_KEY = "sgbd_mory_rufisque_session";
    const FRESH_MS = 1500;               // durée pendant laquelle un cache validé est réutilisé sans question au serveur

    class ApiError extends Error {
        constructor(status, message, code) {
            super(message);
            this.name = code === "ConstraintError" ? "ConstraintError" : "ApiError";
            this.status = status;
            this.code = code;
        }
    }
    function token() {
        try {
            const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
            return s && s.token ? s.token : null;
        }
        catch {
            return null;
        }
    }
    const absoluteUrl = (u) => (typeof u === "string" && u.startsWith("/api/") ? (BASE || window.location.origin) + u : u);
    // undefined -> null : une propriete mise a undefined doit etre effacee cote serveur.
    const serialize = (obj) => JSON.stringify(obj, (k, v) => (v === undefined ? null : v));
    const clone = (o) => ({ ...o });
    const normalize = (row) => {
        if (row && typeof row.photoDataUrl === "string")
            row.photoDataUrl = absoluteUrl(row.photoDataUrl);
        return row;
    };

    let sessionExpiredHandled = false;
    async function raw(method, path, body, extraHeaders) {
        const headers = { ...(extraHeaders || {}) };
        const t = token();
        if (t)
            headers.Authorization = "Bearer " + t;
        if (body !== undefined)
            headers["Content-Type"] = "application/json";
        let res;
        try {
            res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : serialize(body), cache: "no-store" });
        }
        catch {
            throw new ApiError(0, "Serveur injoignable : verifiez votre connexion Internet puis reessayez.", "network");
        }
        if (res.status === 304)
            return { status: 304, headers: res.headers, json: null };
        let json = null;
        const text = await res.text();
        if (text) {
            try {
                json = JSON.parse(text);
            }
            catch { /* reponse non JSON */ }
        }
        if (!res.ok) {
            if (res.status === 401 && path !== "/api/login" && !sessionExpiredHandled) {
                sessionExpiredHandled = true;
                sessionStorage.removeItem(SESSION_KEY);
                alert((json && json.message) || "Session expiree : veuillez vous reconnecter.");
                window.location.reload();
            }
            throw new ApiError(res.status, (json && json.message) || `Erreur serveur (${res.status}).`, json && json.error);
        }
        return { status: res.status, headers: res.headers, json };
    }
    const versionOf = (etag) => {
        const m = /v(\d+)/.exec(etag || "");
        return m ? Number(m[1]) : null;
    };

    // Toute ecriture peut modifier d'autres tables (cascades) : on force une
    // revalidation (legere, en 304 si rien n'a change) a la prochaine lecture.
    const tables = [];
    const staleAll = () => tables.forEach((t) => { t.cache.checkedAt = 0; });

    class Collection {
        constructor(table, getRows) {
            this.table = table;
            this.getRows = getRows;
        }
        async toArray() { return (await this.getRows()).map(clone); }
        async count() { return (await this.getRows()).length; }
        async first() {
            const rows = await this.getRows();
            return rows.length ? clone(rows[0]) : undefined;
        }
        async primaryKeys() { return (await this.getRows()).map((r) => r[this.table.pk]); }
        filter(fn) { return new Collection(this.table, async () => (await this.getRows()).filter(fn)); }
        async delete() {
            const ids = await this.primaryKeys();
            if (!ids.length)
                return 0;
            await this.table.bulkDelete(ids);
            return ids.length;
        }
        // Equivalent de Dexie modify(fn) : applique fn a une copie de chaque ligne
        // et n'envoie au serveur que les lignes reellement modifiees.
        async modify(fn) {
            const rows = await this.getRows();
            const patches = [];
            for (const original of rows) {
                const copy = JSON.parse(JSON.stringify(original));
                fn(copy);
                const changes = {};
                let changed = false;
                for (const k of Object.keys(copy)) {
                    if (JSON.stringify(copy[k]) !== JSON.stringify(original[k])) {
                        changes[k] = copy[k];
                        changed = true;
                    }
                }
                for (const k of Object.keys(original)) {
                    if (!(k in copy)) {
                        changes[k] = null;
                        changed = true;
                    }
                }
                if (changed)
                    patches.push({ id: original[this.table.pk], changes });
            }
            if (!patches.length)
                return 0;
            await this.table._batchPatch(patches);
            return patches.length;
        }
    }
    class WhereClause {
        constructor(table, field) {
            this.table = table;
            this.field = field;
        }
        equals(value) { return new Collection(this.table, async () => (await this.table._rows()).filter((r) => r[this.field] === value)); }
        anyOf(values) {
            const set = new Set(values);
            return new Collection(this.table, async () => (await this.table._rows()).filter((r) => set.has(r[this.field])));
        }
    }

    class Table {
        constructor(name, pk = "id") {
            this.name = name;
            this.pk = pk;
            this.cache = { rows: null, version: null, checkedAt: 0, inflight: null };
            tables.push(this);
        }
        // Lignes a jour (revalidation aupres du serveur si le cache n'est plus frais).
        async _rows() {
            const c = this.cache;
            if (c.rows && Date.now() - c.checkedAt < FRESH_MS)
                return c.rows;
            if (c.inflight)
                return c.inflight;
            c.inflight = (async () => {
                try {
                    const headers = c.rows && c.version !== null ? { "If-None-Match": `"v${c.version}"` } : {};
                    const r = await raw("GET", `/api/data/${this.name}`, undefined, headers);
                    if (r.status !== 304) {
                        c.rows = r.json.map(normalize);
                        c.version = versionOf(r.headers.get("ETag"));
                    }
                    c.checkedAt = Date.now();
                    return c.rows;
                }
                finally {
                    c.inflight = null;
                }
            })();
            return c.inflight;
        }
        // Applique localement une ecriture quand le cache etait a jour avant elle.
        _applied(v, mutate) {
            const c = this.cache;
            if (c.rows && v && c.version === v.before) {
                mutate(c.rows);
                c.version = v.after;
            }
            else if (v && c.rows) {
                c.checkedAt = 0;       // une autre ecriture s'est intercalee : tout revalider
            }
            staleAll();
        }
        _invalidate() {
            this.cache.checkedAt = 0;
            staleAll();
        }
        async toArray() { return (await this._rows()).map(clone); }
        async count() { return (await this._rows()).length; }
        async get(id) {
            const row = (await this._rows()).find((r) => r[this.pk] === id);
            return row ? clone(row) : undefined;
        }
        toCollection() { return new Collection(this, () => this._rows()); }
        filter(fn) { return this.toCollection().filter(fn); }
        where(field) { return new WhereClause(this, field); }
        async add(obj) {
            const r = await raw("POST", `/api/data/${this.name}`, obj);
            this._applied(r.json.v, (rows) => rows.push(normalize(r.json.row)));
            return r.json.id;
        }
        async bulkAdd(list) {
            if (!list.length)
                return undefined;
            const r = await raw("POST", `/api/data/${this.name}/bulk`, { rows: list });
            this._invalidate();
            return r.json.ids[r.json.ids.length - 1];
        }
        async update(id, changes) {
            try {
                const r = await raw("PATCH", `/api/data/${this.name}/${encodeURIComponent(id)}`, changes);
                this._applied(r.json.v, (rows) => {
                    const i = rows.findIndex((x) => x[this.pk] === id);
                    if (i >= 0)
                        rows[i] = normalize(r.json.row);
                });
                return 1;
            }
            catch (e) {
                if (e instanceof ApiError && e.status === 404)
                    return 0;
                throw e;
            }
        }
        async _batchPatch(patches) {
            const r = await raw("POST", `/api/data/${this.name}/batch-patch`, { patches });
            this._applied(r.json.v, (rows) => {
                for (const row of r.json.rows) {
                    const i = rows.findIndex((x) => x[this.pk] === row[this.pk]);
                    if (i >= 0)
                        rows[i] = normalize(row);
                }
            });
        }
        async put(obj) {
            const key = obj[this.pk];
            const r = await raw("PUT", `/api/data/${this.name}/${encodeURIComponent(key)}`, obj);
            this._applied(r.json.v, (rows) => {
                const i = rows.findIndex((x) => x[this.pk] === key);
                if (i >= 0)
                    rows[i] = clone(obj);
                else
                    rows.push(clone(obj));
            });
            this._invalidate();          // le serveur normalise la ligne : relecture a la prochaine lecture
            return key;
        }
        async delete(id) {
            const r = await raw("DELETE", `/api/data/${this.name}/${encodeURIComponent(id)}`);
            this._applied(r.json.v, (rows) => {
                const i = rows.findIndex((x) => x[this.pk] === id);
                if (i >= 0)
                    rows.splice(i, 1);
            });
        }
        async bulkDelete(ids) {
            if (!ids.length)
                return;
            const r = await raw("POST", `/api/data/${this.name}/bulk-delete`, { ids });
            const set = new Set(ids);
            this._applied(r.json.v, (rows) => {
                for (let i = rows.length - 1; i >= 0; i--)
                    if (set.has(rows[i][this.pk]))
                        rows.splice(i, 1);
            });
        }
        async clear() {
            const r = await raw("POST", `/api/data/${this.name}/clear`);
            this._applied(r.json.v, (rows) => { rows.length = 0; });
        }
    }

    // Comptes : la liste complete est reservee a l'administrateur principal ; un
    // utilisateur ordinaire ne lit que sa propre fiche. Mots de passe : jamais renvoyes.
    class UsersTable extends Table {
        constructor() {
            super("users");
            this.own = new Map();
        }
        async get(id) {
            if (this.cache.rows && Date.now() - this.cache.checkedAt < FRESH_MS) {
                const hit = this.cache.rows.find((r) => r.id === id);
                if (hit)
                    return clone(hit);
            }
            const mine = this.own.get(id);
            if (mine && Date.now() - mine.t < FRESH_MS)
                return clone(mine.row);
            try {
                const r = await raw("GET", `/api/data/users/${id}`);
                const row = normalize(r.json);
                this.own.set(id, { row, t: Date.now() });
                return clone(row);
            }
            catch (e) {
                if (e instanceof ApiError && (e.status === 404 || e.status === 403))
                    return undefined;
                throw e;
            }
        }
        _invalidate() {
            this.own.clear();
            super._invalidate();
        }
        _applied(v, mutate) {
            this.own.clear();
            super._applied(v, mutate);
        }
    }

    class SgbdApiDatabase {
        constructor() {
            this.users = new UsersTable();
            for (const name of ["membres", "cellules", "sections", "quartiers", "bureauxVote", "elections",
                "depouillements", "resultats", "couches"])
                this[name] = new Table(name);
            this.stylesCouches = new Table("stylesCouches", "niveau");
        }
    }
    window.SgbdApiDatabase = SgbdApiDatabase;

    window.sgbdApi = {
        base: BASE,
        ApiError,
        async login(identifiant, motDePasse) {
            try {
                const r = await raw("POST", "/api/login", { identifiant, motDePasse });
                return { ...r.json.session, token: r.json.token };
            }
            catch (e) {
                if (e instanceof ApiError && (e.status === 401 || e.status === 429)) {
                    if (e.status === 429)
                        throw e;
                    return null;
                }
                throw e;
            }
        },
        async loginPreview(identifiant) {
            try {
                const r = await raw("GET", `/api/login-preview?identifiant=${encodeURIComponent(identifiant)}`);
                return r.json && r.json.identifiant ? { identifiant: r.json.identifiant, photoDataUrl: absoluteUrl(r.json.photoDataUrl) } : null;
            }
            catch {
                return null;           // l'apercu est facultatif : on ignore les erreurs
            }
        },
        resetAfterLogout() {
            sessionExpiredHandled = false;
            tables.forEach((t) => { t.cache = { rows: null, version: null, checkedAt: 0, inflight: null }; });
        },
    };

    // Les erreurs d'API non gerees par l'interface s'affichent comme les autres messages d'erreur.
    window.addEventListener("unhandledrejection", (e) => {
        if (e.reason instanceof ApiError && typeof window.toast === "function" && e.reason.status !== 401) {
            e.preventDefault();
            window.toast(e.reason.message, "error");
        }
    });
})();
