// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { safeFetch } from '@/Services/netFetch';
import {
    field,
    formatDate,
    tag,
    type OsintField,
    type OsintProbeAdapter,
    type OsintProbeDraft,
    type OsintTag
} from './shared';

/**
 * Les ports ouverts d'une IP, tels que Shodan les a vus en balayant Internet :
 * rien n'est sondé depuis le serveur. InternetDB (gratuit, sans clé) rend la
 * liste ; une clé Shodan y ajoute le logiciel et la version de chaque service.
 */

interface InternetDb {
    ports?: number[];
    hostnames?: string[];
    cpes?: string[];
    tags?: string[];
    vulns?: string[];
}

interface ShodanHost {
    ports?: number[];
    hostnames?: string[];
    org?: string;
    isp?: string;
    os?: string | null;
    tags?: string[];
    vulns?: string[];
    last_update?: string;
    data?: { port: number; transport?: string; product?: string; version?: string }[];
}

async function getJson<T>(url: string): Promise<T | null> {
    const res = await safeFetch(url, {
        signal: AbortSignal.timeout(6000),
        headers: { accept: 'application/json', 'user-agent': 'DevEye-OSINT' }
    });
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) {
        throw new Error('Clé Shodan refusée : vérifiez-la dans les réglages.');
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
}

function common(ports: number[], hostnames: string[], vulns: string[], labels: string[]): OsintProbeDraft {
    const fields: OsintField[] = [];
    if (hostnames.length) fields.push(field('Noms', hostnames.slice(0, 8).join('\n'), { mono: true }));
    if (vulns.length) {
        fields.push(field(`Vulnérabilités (${vulns.length})`, vulns.slice(0, 12).join(', '), { mono: true }));
    }

    const tags: OsintTag[] = [tag(`${ports.length} port(s)`, ports.length > 10 ? 'warn' : 'neutral')];
    if (vulns.length) tags.push(tag(`${vulns.length} CVE`, 'bad'));
    for (const l of labels.slice(0, 4)) tags.push(tag(l, 'neutral'));

    return {
        fields,
        tags,
        links: [
            ...hostnames.slice(0, 3).map((h) => ({ label: h, href: `osint:domain/${h}` })),
            ...vulns.slice(0, 5).map((v) => ({ label: v, href: `https://nvd.nist.gov/vuln/detail/${v}` }))
        ]
    };
}

export const portsProbe: OsintProbeAdapter = {
    id: 'ports',
    appliesTo: ['ip'],
    ttlMs: 6 * 60 * 60 * 1000,
    async run({ target, key }) {
        const ip = encodeURIComponent(target.value);
        const shodanLink = { label: 'Fiche Shodan', href: `https://www.shodan.io/host/${ip}` };

        if (key) {
            const host = await getJson<ShodanHost>(
                `https://api.shodan.io/shodan/host/${ip}?key=${encodeURIComponent(key)}`
            );
            if (!host) return { status: 'empty', summary: 'Shodan n’a jamais vu de service ouvert sur cette adresse.' };
            const ports = host.ports ?? [];
            const base = common(ports, host.hostnames ?? [], host.vulns ?? [], host.tags ?? []);
            const services = (host.data ?? [])
                .sort((a, b) => a.port - b.port)
                .map((s) =>
                    `${s.port}/${s.transport ?? 'tcp'} ${[s.product, s.version].filter(Boolean).join(' ')}`.trim()
                );
            const head: OsintField[] = [field('Services', services.join('\n') || ports.join(', '), { mono: true })];
            if (host.org) head.push(field('Organisation', host.org));
            if (host.os) head.push(field('Système', host.os));
            if (host.last_update) head.push(field('Dernier passage', formatDate(host.last_update) ?? host.last_update));
            return {
                ...base,
                summary: `${ports.length} port(s) ouvert(s) vus par Shodan.`,
                fields: [...head, ...(base.fields ?? [])],
                links: [shodanLink, ...(base.links ?? [])]
            };
        }

        const db = await getJson<InternetDb>(`https://internetdb.shodan.io/${ip}`);
        if (!db || (db.ports ?? []).length === 0) {
            return {
                status: 'empty',
                summary: 'Aucun port ouvert vu par Shodan sur cette adresse.',
                links: [shodanLink]
            };
        }
        const ports = db.ports ?? [];
        const base = common(ports, db.hostnames ?? [], db.vulns ?? [], db.tags ?? []);
        const head: OsintField[] = [field('Ports', [...ports].sort((a, b) => a - b).join(', '), { mono: true })];
        if (db.cpes?.length) head.push(field('Logiciels', db.cpes.slice(0, 10).join('\n'), { mono: true }));
        return {
            ...base,
            summary: `${ports.length} port(s) ouvert(s) vus par Shodan. Une clé Shodan ajoute la version de chaque service.`,
            fields: [...head, ...(base.fields ?? [])],
            links: [shodanLink, ...(base.links ?? [])]
        };
    }
};
