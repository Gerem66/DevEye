// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { BROWSER_UA, isSafePublicUrl, safeFetch, titleTag } from '@/Services/netFetch';
import { field, tag, type OsintProbeAdapter, type OsintTag } from './shared';

/**
 * Chaîne de redirections, technologie annoncée, en-têtes de sécurité manquants.
 * Redirections suivies à la main (`redirect: 'manual'`) : la chaîne elle-même
 * est le renseignement.
 */

const MAX_HOPS = 6;
const HOP_TIMEOUT_MS = 5000;

/** En-têtes dont l'absence vaut d'être signalée, avec ce qu'ils protègent. */
const SECURITY_HEADERS: { name: string; label: string }[] = [
    { name: 'strict-transport-security', label: 'HSTS' },
    { name: 'content-security-policy', label: 'CSP' },
    { name: 'x-frame-options', label: 'X-Frame-Options' },
    { name: 'x-content-type-options', label: 'X-Content-Type-Options' },
    { name: 'referrer-policy', label: 'Referrer-Policy' }
];

export const httpProbe: OsintProbeAdapter = {
    id: 'http',
    appliesTo: ['domain', 'url'],
    ttlMs: 10 * 60 * 1000,
    async run({ target }) {
        const chain: string[] = [];
        let url = `https://${target.value}/`;
        let res: Awaited<ReturnType<typeof safeFetch>> | null = null;

        for (let hop = 0; hop < MAX_HOPS; hop++) {
            const parsed = new URL(url);
            if (!isSafePublicUrl(parsed)) {
                return {
                    status: 'error',
                    summary: `Redirection vers une adresse non publique (${parsed.hostname}) — arrêt.`,
                    fields: chain.map((u, i) => field(`Étape ${i + 1}`, u, { mono: true }))
                };
            }

            // `safeFetch` borne aussi l'adresse jointe : le nom a passé le garde,
            // pas encore ce vers quoi il résout.
            res = await safeFetch(url, {
                method: 'GET',
                redirect: 'manual',
                signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
                headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml' }
            });
            chain.push(`${res.status} ${url}`);

            const location = res.headers.get('location');
            if (res.status >= 300 && res.status < 400 && location) {
                url = new URL(location, url).toString();
                continue;
            }
            break;
        }

        if (!res) return { status: 'empty', summary: 'Aucune réponse.' };

        const fields = [];
        fields.push(field('Statut', `${res.status} ${res.statusText}`.trim()));
        if (chain.length > 1) fields.push(field('Redirections', chain.join('\n→ '), { mono: true }));
        fields.push(field('URL finale', url, { mono: true, href: url }));

        const server = res.headers.get('server');
        if (server) fields.push(field('Serveur', server, { mono: true }));
        const powered = res.headers.get('x-powered-by');
        if (powered) fields.push(field('Technologie', powered, { mono: true }));

        const present = SECURITY_HEADERS.filter((h) => res.headers.get(h.name));
        const missing = SECURITY_HEADERS.filter((h) => !res.headers.get(h.name));
        if (present.length) fields.push(field('En-têtes de sécurité', present.map((h) => h.label).join(', ')));
        if (missing.length) fields.push(field('Manquants', missing.map((h) => h.label).join(', ')));

        // Le titre situe la page en un coup d'œil (page parquée, panneau
        // d'admin, hébergeur par défaut) mieux que n'importe quel en-tête.
        let title: string | null = null;
        const ct = res.headers.get('content-type') ?? '';
        if (/text\/html/i.test(ct)) {
            try {
                const html = (await res.text()).slice(0, 65_536);
                title = titleTag(html);
                if (title) fields.unshift(field('Titre', title));
            } catch {
                // Corps illisible : les en-têtes suffisent.
            }
        }

        const tags: OsintTag[] = [];
        if (res.status >= 200 && res.status < 300) tags.push(tag('En ligne', 'good'));
        else if (res.status >= 500) tags.push(tag('Erreur serveur', 'bad'));
        else if (res.status >= 400) tags.push(tag(`HTTP ${res.status}`, 'warn'));
        if (missing.length >= 4) tags.push(tag('Peu durci', 'warn'));
        else if (missing.length === 0) tags.push(tag('Bien durci', 'good'));
        if (!new URL(url).protocol.startsWith('https')) tags.push(tag('Sans HTTPS', 'bad'));
        if (chain.length > 2) tags.push(tag(`${chain.length - 1} redirections`, 'neutral'));

        return {
            summary: title ?? `Le serveur répond ${res.status}.`,
            fields,
            tags
        };
    }
};
