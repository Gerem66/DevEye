// Privilège de native rapatriée : le garde SSRF est partagé par toute l'app, pas propre au module.
import { fetchJson } from '@/Services/netFetch';
import { field, tag, type OsintProbeAdapter } from './shared';

/**
 * Sous-domaines par transparence des certificats (crt.sh).
 *
 * La source libre la plus rentable de toute la feature. Depuis 2018, toute
 * autorité de certification publique doit journaliser publiquement chaque
 * certificat émis. Ces journaux sont donc un **index quasi exhaustif des
 * sous-domaines** de n'importe quel domaine — sans envoyer le moindre paquet à
 * la cible, et sans deviner des noms.
 *
 * crt.sh est lent (la requête frappe une grosse base Postgres publique) : d'où
 * un délai large, une mise en cache longue, et le classement de cette sonde
 * parmi les lentes côté client.
 */

const CRTSH_TIMEOUT_MS = 20_000;
const MAX_SHOWN = 200;

interface CrtShEntry {
    name_value?: string;
    common_name?: string;
    issuer_name?: string;
    not_after?: string;
}

export const crtshProbe: OsintProbeAdapter = {
    id: 'crtsh',
    appliesTo: ['domain', 'url'],
    ttlMs: 6 * 60 * 60 * 1000,
    async run({ target }) {
        const domain = target.value;
        const url = `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json&exclude=expired`;

        const entries = await fetchJson<CrtShEntry[]>(url, {}, CRTSH_TIMEOUT_MS);
        if (!Array.isArray(entries) || entries.length === 0) {
            return { status: 'empty', summary: `Aucun certificat journalisé pour ${domain}.` };
        }

        // `name_value` porte plusieurs noms séparés par des retours à la ligne.
        const names = new Set<string>();
        for (const e of entries) {
            for (const raw of (e.name_value ?? '').split('\n')) {
                const n = raw.trim().toLowerCase();
                if (!n || n.includes(' ')) continue;
                // On ne garde que ce qui est sous le domaine visé : les journaux
                // renvoient parfois des noms d'un certificat mutualisé.
                if (n === domain || n.endsWith(`.${domain}`)) names.add(n);
            }
        }

        const wildcards = [...names].filter((n) => n.startsWith('*.')).sort();
        const hosts = [...names].filter((n) => !n.startsWith('*.') && n !== domain).sort();

        if (hosts.length === 0 && wildcards.length === 0) {
            return {
                status: 'empty',
                summary: `${entries.length} certificat(s), mais aucun sous-domaine distinct.`
            };
        }

        const issuers = new Set(entries.map((e) => e.issuer_name ?? '').filter(Boolean));

        const fields = [];
        if (hosts.length) {
            const shown = hosts.slice(0, MAX_SHOWN);
            fields.push(
                field(
                    `Sous-domaines (${hosts.length})`,
                    shown.join('\n') + (hosts.length > shown.length ? `\n… +${hosts.length - shown.length}` : ''),
                    { mono: true }
                )
            );
        }
        if (wildcards.length) fields.push(field('Jokers', wildcards.join('\n'), { mono: true }));
        fields.push(field('Certificats journalisés', String(entries.length)));
        if (issuers.size) {
            fields.push(field('Autorités', [...issuers].slice(0, 5).map(shortIssuer).join('\n'), { mono: true }));
        }

        const tags = [tag(`${hosts.length} sous-domaine(s)`, hosts.length > 0 ? 'good' : 'neutral')];
        // Un nom qui contient « dev », « staging », « admin » ou « vpn » est
        // exactement ce qu'une reconnaissance cherche : de l'interne exposé.
        const sensitive = hosts.filter((h) =>
            /(^|[.-])(dev|test|staging|preprod|recette|admin|vpn|internal|git|jenkins|grafana|kibana)[.-]/.test(h)
        );
        if (sensitive.length) tags.push(tag(`${sensitive.length} nom(s) sensible(s)`, 'warn'));

        return {
            summary: `${hosts.length} sous-domaine(s) trouvé(s) dans ${entries.length} certificat(s).`,
            fields,
            tags,
            links: [
                ...sensitive.slice(0, 10).map((h) => ({ label: h, href: `osint:domain/${h}` })),
                { label: 'Voir sur crt.sh', href: `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}` }
            ]
        };
    }
};

/** `C=US, O=Let's Encrypt, CN=R3` → `Let's Encrypt / R3`. */
function shortIssuer(dn: string): string {
    const o = dn.match(/O=([^,]+)/)?.[1]?.trim();
    const cn = dn.match(/CN=([^,]+)/)?.[1]?.trim();
    return [o, cn].filter(Boolean).join(' / ') || dn;
}
