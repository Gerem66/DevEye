import { Resolver } from 'dns/promises';

import { field, tag, type OsintProbeAdapter, type OsintProbeDraft } from './shared';

/**
 * Relevé DNS complet d'un domaine.
 *
 * Un résolveur **dédié** plutôt que le résolveur par défaut du processus : celui
 * du système peut être un cache d'entreprise ou un menteur (DNS captif, filtrage
 * FAI), et une reconnaissance qui rend la vue biaisée de l'hébergeur ne sert à
 * rien. Cloudflare et Google en secours, avec un délai borné.
 */
function resolver(): Resolver {
    const r = new Resolver({ timeout: 4000, tries: 2 });
    r.setServers(['1.1.1.1', '8.8.8.8']);
    return r;
}

/** Une absence d'enregistrement n'est pas une panne : elle se lit comme une liste vide. */
async function tryResolve<T>(fn: () => Promise<T[]>): Promise<T[]> {
    try {
        return await fn();
    } catch {
        return [];
    }
}

export const dnsProbe: OsintProbeAdapter = {
    id: 'dns',
    appliesTo: ['domain', 'url'],
    ttlMs: 5 * 60 * 1000,
    async run({ target }) {
        const r = resolver();
        const domain = target.value;

        const [a, aaaa, mx, ns, txt, cname, soa, dmarc] = await Promise.all([
            tryResolve(() => r.resolve4(domain)),
            tryResolve(() => r.resolve6(domain)),
            tryResolve(() => r.resolveMx(domain)),
            tryResolve(() => r.resolveNs(domain)),
            tryResolve(() => r.resolveTxt(domain)),
            tryResolve(() => r.resolveCname(domain)),
            tryResolve(async () => [await r.resolveSoa(domain)]),
            tryResolve(() => r.resolveTxt(`_dmarc.${domain}`))
        ]);

        const txtFlat = txt.map((parts) => parts.join(''));
        const spf = txtFlat.find((t) => t.toLowerCase().startsWith('v=spf1')) ?? null;
        const dmarcFlat = dmarc.map((parts) => parts.join('')).find((t) => t.toLowerCase().startsWith('v=dmarc1'));

        const fields = [];
        if (a.length) fields.push(field('A', a.join(', '), { mono: true }));
        if (aaaa.length) fields.push(field('AAAA', aaaa.join(', '), { mono: true }));
        if (cname.length) fields.push(field('CNAME', cname.join(', '), { mono: true }));
        if (mx.length) {
            const sorted = [...mx].sort((x, y) => x.priority - y.priority);
            fields.push(field('MX', sorted.map((m) => `${m.priority} ${m.exchange}`).join('\n'), { mono: true }));
        }
        if (ns.length) fields.push(field('NS', ns.join('\n'), { mono: true }));
        if (soa.length) fields.push(field('SOA', `${soa[0].nsname} — série ${soa[0].serial}`, { mono: true }));
        if (spf) fields.push(field('SPF', spf, { mono: true }));
        if (dmarcFlat) fields.push(field('DMARC', dmarcFlat, { mono: true }));

        const others = txtFlat.filter((t) => t !== spf);
        if (others.length) fields.push(field('TXT', others.join('\n'), { mono: true }));

        if (fields.length === 0) {
            return { status: 'empty', summary: `Aucun enregistrement DNS pour ${domain}.` };
        }

        const tags = [];
        if (mx.length) tags.push(tag('Reçoit du courrier', 'neutral'));
        // Un domaine qui reçoit du courrier sans SPF ni DMARC est usurpable :
        // c'est le constat le plus actionnable de toute la carte.
        if (mx.length && !spf) tags.push(tag('Sans SPF', 'bad'));
        else if (spf) tags.push(tag('SPF', 'good'));
        if (mx.length && !dmarcFlat) tags.push(tag('Sans DMARC', 'warn'));
        else if (dmarcFlat) tags.push(tag('DMARC', 'good'));
        if (!a.length && !aaaa.length) tags.push(tag('Ne pointe nulle part', 'warn'));
        if (aaaa.length) tags.push(tag('IPv6', 'good'));

        const draft: OsintProbeDraft = {
            summary: `${a.length + aaaa.length} adresse(s), ${mx.length} MX, ${ns.length} NS.`,
            fields,
            tags,
            // Les adresses trouvées sont des cibles à leur tour : le client en
            // fait des liens qui relancent une recherche sur l'IP.
            links: [...a, ...aaaa].slice(0, 8).map((ip) => ({ label: ip, href: `osint:ip/${ip}` }))
        };
        return draft;
    }
};
