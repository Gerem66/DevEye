import { createHash } from 'crypto';

/**
 * Le script que les pages suivies embarquent : une vue à l'ouverture puis une
 * par changement de route, `window.deveye.event` / `identify` / `submit`, et un
 * regroupement des envois vidé par `sendBeacon` quand l'onglet part.
 *
 * Servi tel quel, sans minification et avec ses commentaires : c'est le seul
 * morceau de DevEye que quelqu'un d'autre lira dans son propre navigateur, et
 * un script de mesure qu'on ne peut pas relire est un script qu'on n'installe
 * pas. Une chaîne dans un fichier TypeScript, et non un `.js` à côté : rien à
 * copier au build, rien à retrouver selon le répertoire de travail, et l'ETag
 * se calcule sur ce qui sera réellement servi.
 *
 * `submit` fait exception à tout le reste du script : il n'est jamais
 * automatique, il ne groupe rien, et il rend une promesse. Une mesure est un
 * effet de bord discret, un retour est un geste dont l'auteur attend une
 * réponse.
 *
 * Aucune empreinte de navigateur, jamais, et par défaut rien n'est écrit chez
 * le visiteur : il est reconstitué côté serveur par un condensé tournant.
 * `data-visitor="persistent"` seul change cela, en rangeant un identifiant tiré
 * au sort dans `localStorage` ; il faut aussi que le site soit réglé en mode
 * persistant, et ce mode relève du consentement, comme un cookie.
 */
export const TRACKER_SCRIPT = `(function () {
    'use strict';

    var script = document.currentScript;
    if (!script) return;

    var key = script.getAttribute('data-key');
    if (!key) {
        console.warn('[deveye] data-key manquant, aucune mesure ne sera envoyée.');
        return;
    }

    // L'adresse d'envoi est celle d'où vient ce script. Rien à configurer : si
    // la balise pointe t.exemple.fr, les mesures y retournent.
    var origin = new URL(script.src, location.href).origin;
    var endpoint = origin + '/api/t/b';
    var submitEndpoint = origin + '/api/t/s';

    // En développement on ne mesure rien, sauf demande explicite : sans cette
    // règle, chaque rechargement local gonflerait les chiffres de production.
    var isLocal = location.hostname === 'localhost' ||
        location.hostname === '127.0.0.1' ||
        location.hostname === '' ||
        location.protocol === 'file:';
    if (isLocal && script.getAttribute('data-local') !== 'true') {
        console.info('[deveye] hôte local, mesure désactivée (data-local="true" pour l\\'activer).');
        return;
    }

    var auto = script.getAttribute('data-manual') !== 'true';

    // Reconnaître le visiteur d'une visite à l'autre.
    //
    // Éteint par défaut, et il faut le vouloir des DEUX côtés : cet attribut
    // ici, et le mode « persistant » sur le site dans DevEye. Sans le réglage,
    // le serveur ignore l'identifiant ; sans l'attribut, aucun n'est posé.
    //
    // ⚠️ Ranger un identifiant durable chez le visiteur relève du consentement,
    // que ce soit un cookie ou du localStorage : la directive ePrivacy ne
    // distingue pas les deux. Le mode par défaut, lui, n'écrit rien.
    var visitorId = null;
    if (script.getAttribute('data-visitor') === 'persistent') {
        var storeKey = 'deveye:v:' + key;
        try {
            visitorId = localStorage.getItem(storeKey);
            if (!visitorId) {
                visitorId =
                    (crypto.randomUUID && crypto.randomUUID()) ||
                    String(Date.now()) + Math.random().toString(36).slice(2);
                localStorage.setItem(storeKey, visitorId);
            }
        } catch (e) {
            // Navigation privée, stockage refusé, quota plein : on retombe sur
            // la mesure anonyme plutôt que de ne rien envoyer. La visite compte,
            // elle ne sera simplement jamais « déjà venue ».
            visitorId = null;
        }
    }
    var queue = [];
    var timer = null;
    var identity = null;
    var lastPath = null;
    var sentReferrer = false;

    function context() {
        var payload = {
            timezone: undefined,
            tzOffset: new Date().getTimezoneOffset(),
            screenWidth: window.innerWidth || undefined,
            language: navigator.language || undefined
        };
        try {
            payload.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        } catch (e) {
            // Navigateur sans Intl : le fuseau restera inconnu, le reste vaut.
        }
        if (identity) payload.identity = identity;
        // Le référent n'est envoyé qu'une fois : c'est d'où l'on vient, pas une
        // propriété de chaque page vue ensuite.
        if (!sentReferrer && document.referrer) {
            payload.referrer = document.referrer;
            sentReferrer = true;
        }
        return payload;
    }

    function push(event) {
        queue.push(event);
        if (timer) return;
        // Un court regroupement : une navigation qui déclenche deux mesures
        // coup sur coup ne doit pas produire deux requêtes.
        timer = setTimeout(flush, 500);
    }

    function flush(beacon) {
        if (timer) { clearTimeout(timer); timer = null; }
        if (queue.length === 0) return;
        var payload = { key: key, events: queue.splice(0, queue.length) };
        // Porté par le lot et non par chaque événement : c'est une propriété du
        // client, pas de la mesure. Le répéter vingt fois coûterait plus que
        // tout le reste du corps.
        if (visitorId) payload.visitorId = visitorId;
        var body = JSON.stringify(payload);

        // text/plain, et non application/json : c'est ce qui fait de cet envoi
        // une requête « simple » au sens CORS, donc sans requête préalable
        // OPTIONS. Le serveur sait le lire.
        if (beacon && navigator.sendBeacon) {
            navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }));
            return;
        }
        try {
            fetch(endpoint, {
                method: 'POST',
                body: body,
                headers: { 'Content-Type': 'text/plain' },
                keepalive: true,
                credentials: 'omit',
                mode: 'cors'
            }).catch(function () {});
        } catch (e) {
            // Une mesure perdue ne doit jamais interrompre la page qui la porte.
        }
    }

    function view(path) {
        var next = path || location.pathname;
        // Une SPA rejoue volontiers replaceState sur la même route ; deux vues
        // identiques d'affilée ne décrivent rien de plus qu'une seule.
        if (next === lastPath) return;
        lastPath = next;
        var event = context();
        event.type = 'view';
        event.path = next;
        push(event);
    }

    function event(name, options) {
        if (!name) return;
        var payload = context();
        payload.type = 'event';
        payload.name = String(name);
        payload.path = (options && options.path) || location.pathname;
        push(payload);
    }

    function identify(value) {
        identity = value ? String(value) : null;
    }

    // Un retour part seul et tout de suite, sans passer par la file : celui qui
    // l'envoie attend de savoir s'il est parti pour afficher « envoyé », et un
    // message perdu au changement de page ne se rattrape pas.
    function submit(form, fields) {
        var payload = { key: key, form: String(form || 'contact'), fields: fields || {}, path: location.pathname };
        if (visitorId) payload.visitorId = visitorId;
        return fetch(submitEndpoint, {
            method: 'POST',
            body: JSON.stringify(payload),
            // text/plain pour la même raison qu'au-dessus : requête « simple » au
            // sens CORS, donc sans requête préalable OPTIONS.
            headers: { 'Content-Type': 'text/plain' },
            credentials: 'omit',
            mode: 'cors'
        }).then(function (res) {
            return res.ok;
        });
    }

    window.deveye = { view: view, event: event, identify: identify, submit: submit, flush: flush };

    if (auto) {
        // Les SPA changent de route sans recharger : on écoute les deux verbes
        // de l'History API plus le retour arrière du navigateur.
        var wrap = function (method) {
            var original = history[method];
            history[method] = function () {
                var result = original.apply(this, arguments);
                view();
                return result;
            };
        };
        wrap('pushState');
        wrap('replaceState');
        window.addEventListener('popstate', function () { view(); });
        view();
    }

    // L'onglet s'en va : on envoie ce qui reste par un canal qui survit à la
    // navigation. 'visibilitychange' plutôt que 'unload', que Safari mobile
    // n'appelle pas de façon fiable.
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flush(true);
    });
    window.addEventListener('pagehide', function () { flush(true); });
})();
`;

/**
 * L'empreinte du script, pour l'ETag. Calculée une fois au chargement : le
 * contenu est une constante, la recalculer à chaque requête paierait un sha256
 * pour toujours obtenir la même réponse.
 */
export const TRACKER_SCRIPT_ETAG = `"${createHash('sha256').update(TRACKER_SCRIPT).digest('hex').slice(0, 16)}"`;
