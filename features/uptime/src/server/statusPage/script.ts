import { createHash } from 'node:crypto';

/**
 * Le script de la page de statut, servi à part (`script-src 'self'`) plutôt
 * qu'en ligne : la politique de l'écouteur de l'app le laisse passer aussi.
 * Deux gestes, rien d'autre : les heures remises dans le fuseau du visiteur, et
 * la page relue toutes les minutes tant qu'elle est à l'écran. Sans lui, la
 * page reste lisible, en heures UTC.
 *
 * Une chaîne dans un fichier TypeScript, et non un `.js` : rien à copier au
 * build, et l'ETag se calcule sur ce qui sera réellement servi.
 */
export const STATUS_SCRIPT = `(function () {
    'use strict';
    var REFRESH_MS = 60000;
    var formats = {
        moment: new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }),
        time: new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' })
    };

    function localize(root) {
        var nodes = root.querySelectorAll('time[data-format]');
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            var format = formats[node.getAttribute('data-format')];
            var date = new Date(node.getAttribute('datetime'));
            if (format && !isNaN(date.getTime())) node.textContent = format.format(date);
        }
    }

    function refresh() {
        if (document.visibilityState !== 'visible') return;
        fetch(location.href, { cache: 'no-store', credentials: 'omit' })
            .then(function (res) {
                // Une page retirée entre-temps : la recharger dit qu'elle n'existe plus.
                if (res.status === 404) location.reload();
                return res.ok ? res.text() : null;
            })
            .then(function (html) {
                if (!html) return;
                var next = new DOMParser().parseFromString(html, 'text/html').getElementById('status');
                var current = document.getElementById('status');
                if (!next || !current) return;
                localize(next);
                current.replaceWith(next);
            })
            .catch(function () {});
    }

    localize(document);
    setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
})();
`;

export const STATUS_SCRIPT_ETAG = `"${createHash('sha256').update(STATUS_SCRIPT).digest('hex').slice(0, 16)}"`;
