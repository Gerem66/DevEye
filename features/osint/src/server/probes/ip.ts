import { Resolver } from 'dns/promises';
import { isIPv4 } from 'net';

// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { fetchJson, isPublicIp } from '@/Services/netFetch';
import { mapLimit } from '@deveye/types/sdk/server';

import { field, type OsintProbeAdapter, type OsintTag, publicResolver, tag } from './shared';

/* --------------------------------- Reverse -------------------------------- */

export const ptrProbe: OsintProbeAdapter = {
    id: 'ptr',
    appliesTo: ['ip'],
    ttlMs: 30 * 60 * 1000,
    async run({ target }) {
        let names: string[] = [];
        try {
            names = await publicResolver().reverse(target.value);
        } catch {
            names = [];
        }
        if (names.length === 0) {
            return { status: 'empty', summary: 'Aucun enregistrement PTR — IP sans nom inverse.' };
        }

        const tags: OsintTag[] = [];
        const joined = names.join(' ').toLowerCase();
        // Un PTR générique d'hébergeur dit « machine louée », un PTR nominatif
        // dit « service assumé ». La nuance vaut d'être rendue visible.
        if (/\b(static|dynamic|dsl|pool|cust|client)\b|^\d+[-.]\d+[-.]\d+[-.]\d+/.test(joined)) {
            tags.push(tag('Nom générique', 'neutral'));
        }
        if (/(amazonaws|googleusercontent|azure|ovh|scaleway|hetzner|digitalocean|linode|vultr)/.test(joined)) {
            tags.push(tag('Hébergeur', 'neutral'));
        }

        return {
            summary: names[0],
            fields: [field('PTR', names.join('\n'), { mono: true })],
            tags,
            links: names.slice(0, 5).map((n) => ({ label: n, href: `osint:domain/${n}` }))
        };
    }
};

/* ------------------------------ Géolocalisation ---------------------------- */

/**
 * `ipwho.is` : libre, HTTPS, sans clé, et il rend un bloc `security` avec les
 * drapeaux VPN / proxy / Tor, ce qui fait l'intérêt de la carte.
 */
interface IpWhoIs {
    success?: boolean;
    message?: string;
    ip?: string;
    type?: string;
    country?: string;
    country_code?: string;
    region?: string;
    city?: string;
    latitude?: number;
    longitude?: number;
    timezone?: { id?: string };
    connection?: { asn?: number; org?: string; isp?: string; domain?: string };
    security?: { anonymous?: boolean; proxy?: boolean; vpn?: boolean; tor?: boolean; hosting?: boolean };
}

export const geoipProbe: OsintProbeAdapter = {
    id: 'geoip',
    appliesTo: ['ip'],
    ttlMs: 6 * 60 * 60 * 1000,
    async run({ target }) {
        const data = await fetchJson<IpWhoIs>(`https://ipwho.is/${encodeURIComponent(target.value)}`);
        if (data.success === false) {
            return { status: 'empty', summary: data.message ?? 'Adresse inconnue du fournisseur.' };
        }

        const fields = [];
        const place = [data.city, data.region, data.country].filter(Boolean).join(', ');
        if (place) fields.push(field('Localisation', place));
        if (data.country_code) fields.push(field('Pays', `${data.country ?? ''} (${data.country_code})`.trim()));
        if (data.connection?.isp) fields.push(field('FAI', data.connection.isp));
        if (data.connection?.org && data.connection.org !== data.connection.isp) {
            fields.push(field('Organisation', data.connection.org));
        }
        if (data.connection?.asn) fields.push(field('ASN', `AS${data.connection.asn}`, { mono: true }));
        if (data.connection?.domain) fields.push(field('Domaine', data.connection.domain, { mono: true }));
        if (data.timezone?.id) fields.push(field('Fuseau', data.timezone.id));
        if (data.type) fields.push(field('Type', data.type));

        const s = data.security ?? {};
        const tags: OsintTag[] = [];
        if (s.tor) tags.push(tag('Tor', 'bad'));
        if (s.vpn) tags.push(tag('VPN', 'warn'));
        if (s.proxy) tags.push(tag('Proxy', 'warn'));
        if (s.anonymous) tags.push(tag('Anonymisé', 'warn'));
        if (s.hosting) tags.push(tag('Centre de données', 'neutral'));
        if (!s.vpn && !s.proxy && !s.tor && !s.hosting) tags.push(tag('Accès résidentiel', 'good'));
        if (data.country_code) tags.push(tag(data.country_code, 'neutral'));

        const links = [];
        if (data.latitude != null && data.longitude != null) {
            links.push({
                label: 'Voir sur la carte',
                href: `https://www.openstreetmap.org/?mlat=${data.latitude}&mlon=${data.longitude}#map=11/${data.latitude}/${data.longitude}`
            });
        }

        return {
            summary: place
                ? `${place}${data.connection?.isp ? ` — ${data.connection.isp}` : ''}`
                : 'Adresse localisée.',
            fields,
            tags,
            links,
            raw: JSON.stringify(data, null, 2)
        };
    }
};

/* -------------------------------- Réputation ------------------------------- */

/**
 * Listes noires en DNS pur : octets inversés, zone suffixée, une réponse A
 * signifie « listée ». SpamCop et Barracuda sont libres ; Spamhaus réserve ses
 * miroirs publics au non commercial, il ne s'interroge ici que par la clé DQS
 * de l'espace, qui prend place dans le nom de zone.
 */
const OPEN_ZONES: { zone: string; label: string; keyed?: true }[] = [
    { zone: 'bl.spamcop.net', label: 'SpamCop' },
    { zone: 'b.barracudacentral.org', label: 'Barracuda' }
];

/** Une clé DQS finit dans un nom DNS : rien d'autre que des lettres et des chiffres. */
const DQS_KEY = /^[a-z0-9]{16,64}$/i;

const SPAMHAUS_SIGNUP = 'https://www.spamhaus.com/free-trial/sign-up-for-a-free-data-query-service-account/';

function reverseOctets(ip: string): string {
    return ip.split('.').reverse().join('.');
}

type BlVerdict = 'listed' | 'clean' | 'refused';

/**
 * Toute réponse A ne vaut pas signalement : les zones Spamhaus répondent
 * `127.255.255.x` pour refuser la requête (clé invalide, quota dépassé), ce qui
 * listait n'importe quelle adresse, 8.8.8.8 comprise. Seul le bloc `127.0.0.x`
 * est un vrai verdict.
 */
function readVerdict(answers: string[]): BlVerdict {
    if (answers.length === 0) return 'clean';
    if (answers.some((a) => a.startsWith('127.255.255.'))) return 'refused';
    if (answers.some((a) => a.startsWith('127.0.0.'))) return 'listed';
    return 'refused';
}

/**
 * Toute liste publie une entrée de test, `127.0.0.2`, toujours listée. Si elle
 * ne répond pas, un silence sur la cible ne prouve rien : la liste a fermé
 * (SORBS en 2024), refuse ce serveur, ou la clé ne vaut rien.
 */
async function zoneAlive(r: Resolver, zone: string): Promise<boolean> {
    try {
        return (await r.resolve4(`2.0.0.127.${zone}`)).some((a) => a.startsWith('127.0.0.'));
    } catch {
        return false;
    }
}

export const blocklistProbe: OsintProbeAdapter = {
    id: 'blocklist',
    appliesTo: ['ip'],
    ttlMs: 30 * 60 * 1000,
    async run({ target, key }) {
        // Les zones DNSBL historiques n'indexent que l'IPv4. Le dire est plus
        // honnête que de rendre « aucune liste » pour une IPv6 jamais consultée.
        if (!isIPv4(target.value)) {
            return { status: 'empty', summary: 'Les listes interrogées ne couvrent que l’IPv4.' };
        }

        const zones = [...OPEN_ZONES];
        if (key && DQS_KEY.test(key)) {
            zones.push({ zone: `${key}.zen.dq.spamhaus.net`, label: 'Spamhaus ZEN', keyed: true });
        }

        const rev = reverseOctets(target.value);
        // Le résolveur **du système**, et non les publics utilisés ailleurs :
        // les DNSBL refusent explicitement les requêtes venant de 1.1.1.1 ou
        // 8.8.8.8, et rendent alors un code d'erreur au lieu d'un verdict.
        const r = new Resolver({ timeout: 4000, tries: 2 });

        const results = await mapLimit(zones, 4, async ({ zone, label, keyed }) => {
            const [alive, answers] = await Promise.all([
                zoneAlive(r, zone),
                // NXDOMAIN, le cas normal, lève : c'est une absence.
                r.resolve4(`${rev}.${zone}`).catch(() => [] as string[])
            ]);
            return {
                label,
                keyed,
                verdict: alive ? readVerdict(answers) : ('refused' as BlVerdict),
                codes: answers.join(', ')
            };
        });

        const listed = results.filter((x) => x.verdict === 'listed');
        const refused = results.filter((x) => x.verdict === 'refused');

        const fields = results.map((x) =>
            field(
                x.label,
                x.verdict === 'listed'
                    ? `listée (${x.codes})`
                    : x.verdict === 'refused'
                      ? x.keyed
                          ? 'indéterminé : clé DQS refusée, ou liste injoignable'
                          : 'indéterminé : la liste ne répond pas depuis ce serveur'
                      : 'non listée',
                { mono: x.verdict === 'listed' }
            )
        );
        if (!key) {
            fields.push(field('Spamhaus ZEN', 'non interrogée : il faut la clé DQS de l’espace (onglet Sondes)'));
        } else if (!DQS_KEY.test(key)) {
            fields.push(field('Spamhaus ZEN', 'non interrogée : la clé enregistrée n’a pas la forme d’une clé DQS'));
        }

        const tags: OsintTag[] = [];
        if (listed.length) tags.push(tag(`Listée sur ${listed.length}/${results.length}`, 'bad'));
        else if (refused.length === results.length) tags.push(tag('Aucun verdict obtenu', 'warn'));
        else tags.push(tag('Aucune liste noire', 'good'));
        if (refused.length && listed.length) tags.push(tag(`${refused.length} indéterminé(s)`, 'warn'));

        return {
            summary: listed.length
                ? `Signalée par ${listed.map((x) => x.label).join(', ')}.`
                : refused.length === results.length
                  ? 'Aucune liste n’a accepté de répondre depuis ce serveur.'
                  : `Absente des ${results.length - refused.length} liste(s) ayant répondu.`,
            fields,
            tags,
            links: key ? [] : [{ label: 'Spamhaus : obtenir une clé DQS', href: SPAMHAUS_SIGNUP }]
        };
    }
};

/** Refus commun aux sondes qui reçoivent une IP : rien de privé ne se sonde. */
export function assertProbeableIp(ip: string): void {
    if (!isPublicIp(ip)) {
        throw new Error('Adresse non routable publiquement — sondage refusé.');
    }
}
