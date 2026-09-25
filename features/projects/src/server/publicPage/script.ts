import { createHash } from 'node:crypto';

/**
 * Le script de la page publique, servi à part (`script-src 'self'`) plutôt qu'en
 * ligne. Deux gestes : les dates remises dans le fuseau du visiteur, et le
 * tableau relu toutes les minutes tant qu'il est à l'écran. Sans lui, la page
 * reste lisible, à l'heure de Paris.
 *
 * Une chaîne dans un fichier TypeScript, et non un `.js` : rien à copier au
 * build, et l'ETag se calcule sur ce qui sera réellement servi.
 */
export const BOARD_SCRIPT = `(function () {
    'use strict';
    var REFRESH_MS = 60000;
    var formats = {
        moment: new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }),
        day: new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })
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
                var next = new DOMParser().parseFromString(html, 'text/html').getElementById('board');
                var current = document.getElementById('board');
                if (!next || !current) return;
                localize(next);
                // Le défilement horizontal du tableau survit à la relecture.
                var scroller = current.querySelector('.board');
                var left = scroller ? scroller.scrollLeft : 0;
                current.replaceWith(next);
                var after = next.querySelector('.board');
                if (after) after.scrollLeft = left;
            })
            .catch(function () {});
    }

    localize(document);
    setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
})();
`;

export const BOARD_SCRIPT_ETAG = `"${createHash('sha256').update(BOARD_SCRIPT).digest('hex').slice(0, 16)}"`;
