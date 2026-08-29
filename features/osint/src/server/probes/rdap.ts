// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { fetchJson } from '@/Services/netFetch';
import { daysUntil, field, formatDate, tag, type OsintProbeAdapter, type OsintTag } from './shared';

/**
 * RDAP, le successeur structuré de WHOIS : du JSON, routé par `rdap.org` vers le
 * bon serveur. WHOIS reste servi à côté : beaucoup de ccTLD (l'AFNIC pour `.fr`)
 * publient en WHOIS des champs que leur RDAP omet.
 */

interface RdapVcardEntity {
    roles?: string[];
    vcardArray?: unknown;
    handle?: string;
}

interface RdapEvent {
    eventAction?: string;
    eventDate?: string;
}

interface RdapNameserver {
    ldhName?: string;
}

interface RdapResponse {
    handle?: string;
    ldhName?: string;
    status?: string[];
    events?: RdapEvent[];
    entities?: RdapVcardEntity[];
    nameservers?: RdapNameserver[];
    country?: string;
    name?: string;
    startAddress?: string;
    endAddress?: string;
    cidr0_cidrs?: { v4prefix?: string; v6prefix?: string; length?: number }[];
}

/** Extrait une valeur d'un jCard (RFC 7095) : `['vcard', [['fn', {}, 'text', 'ACME Inc'], …]]`. */
function vcardValue(entity: RdapVcardEntity, key: string): string | null {
    const arr = entity.vcardArray;
    if (!Array.isArray(arr) || arr.length < 2 || !Array.isArray(arr[1])) return null;
    for (const entry of arr[1] as unknown[]) {
        if (Array.isArray(entry) && entry[0] === key && typeof entry[3] === 'string') return entry[3];
    }
    return null;
}

function entityWithRole(res: RdapResponse, role: string): RdapVcardEntity | null {
    return res.entities?.find((e) => e.roles?.includes(role)) ?? null;
}

function eventDate(res: RdapResponse, action: string): string | null {
    return res.events?.find((e) => e.eventAction === action)?.eventDate ?? null;
}

/** Les statuts EPP, en clair. Ce sont eux qui disent si un domaine est verrouillé. */
const STATUS_FR: Record<string, string> = {
    'client transfer prohibited': 'transfert bloqué',
    'client delete prohibited': 'suppression bloquée',
    'client update prohibited': 'modification bloquée',
    'server transfer prohibited': 'transfert bloqué (registre)',
    'server delete prohibited': 'suppression bloquée (registre)',
    'pending delete': 'suppression en cours',
    'redemption period': 'période de rachat',
    active: 'actif',
    inactive: 'inactif'
};

export const rdapProbe: OsintProbeAdapter = {
    id: 'rdap',
    appliesTo: ['domain', 'url'],
    ttlMs: 60 * 60 * 1000,
    async run({ target }) {
        const res = await fetchJson<RdapResponse>(`https://rdap.org/domain/${encodeURIComponent(target.value)}`, {
            accept: 'application/rdap+json, application/json'
        });

        const registrar = entityWithRole(res, 'registrar');
        const registrant = entityWithRole(res, 'registrant');
        const abuse = entityWithRole(res, 'abuse');

        const created = eventDate(res, 'registration');
        const expires = eventDate(res, 'expiration');
        const changed = eventDate(res, 'last changed');

        const fields = [];
        if (res.ldhName) fields.push(field('Domaine', res.ldhName, { mono: true }));
        const registrarName = registrar ? vcardValue(registrar, 'fn') : null;
        if (registrarName) fields.push(field("Bureau d'enregistrement", registrarName));
        const registrantName = registrant ? vcardValue(registrant, 'fn') : null;
        if (registrantName) fields.push(field('Titulaire', registrantName));
        const registrantOrg = registrant ? vcardValue(registrant, 'org') : null;
        if (registrantOrg && registrantOrg !== registrantName) fields.push(field('Organisation', registrantOrg));

        const createdHuman = formatDate(created);
        if (createdHuman) fields.push(field('Créé le', createdHuman));
        const expiresHuman = formatDate(expires);
        if (expiresHuman) fields.push(field('Expire le', expiresHuman));
        const changedHuman = formatDate(changed);
        if (changedHuman) fields.push(field('Modifié le', changedHuman));

        if (res.nameservers?.length) {
            fields.push(
                field('Serveurs de noms', res.nameservers.map((n) => n.ldhName ?? '?').join('\n'), { mono: true })
            );
        }

        const abuseMail = abuse ? vcardValue(abuse, 'email') : null;
        if (abuseMail) fields.push(field('Contact abuse', abuseMail, { href: `mailto:${abuseMail}` }));

        if (res.status?.length) {
            fields.push(field('Statuts', res.status.map((s) => STATUS_FR[s.toLowerCase()] ?? s).join(', ')));
        }

        const tags: OsintTag[] = [];
        const remaining = daysUntil(expires);
        if (remaining !== null) {
            // Un domaine qui expire dans moins d'un mois est un signal fort :
            // abandon imminent, ou occasion de récupération pour un tiers.
            if (remaining < 0) tags.push(tag('Expiré', 'bad'));
            else if (remaining < 30) tags.push(tag(`Expire dans ${remaining} j`, 'bad'));
            else if (remaining < 90) tags.push(tag(`Expire dans ${remaining} j`, 'warn'));
        }
        const age = daysUntil(created);
        if (age !== null && age > -90) tags.push(tag('Domaine récent', 'warn'));
        if (res.status?.some((s) => s.toLowerCase().includes('transfer prohibited'))) {
            tags.push(tag('Verrouillé', 'good'));
        }
        if (res.status?.some((s) => s.toLowerCase().includes('pending delete')))
            tags.push(tag('En suppression', 'bad'));

        return {
            summary: registrarName ? `Enregistré chez ${registrarName}.` : 'Enregistrement trouvé.',
            fields,
            tags,
            raw: JSON.stringify(res, null, 2)
        };
    }
};

export const rdapIpProbe: OsintProbeAdapter = {
    id: 'rdapIp',
    appliesTo: ['ip'],
    ttlMs: 24 * 60 * 60 * 1000,
    async run({ target }) {
        const res = await fetchJson<RdapResponse>(`https://rdap.org/ip/${encodeURIComponent(target.value)}`, {
            accept: 'application/rdap+json, application/json'
        });

        const fields = [];
        if (res.name) fields.push(field('Réseau', res.name));
        if (res.handle) fields.push(field('Identifiant', res.handle, { mono: true }));

        const cidr = res.cidr0_cidrs
            ?.map((c) => `${c.v4prefix ?? c.v6prefix ?? '?'}/${c.length ?? '?'}`)
            .filter((s) => !s.startsWith('?'))
            .join(', ');
        if (cidr) fields.push(field('Bloc', cidr, { mono: true }));
        else if (res.startAddress && res.endAddress) {
            fields.push(field('Plage', `${res.startAddress} – ${res.endAddress}`, { mono: true }));
        }

        if (res.country) fields.push(field('Pays', res.country));

        const org = entityWithRole(res, 'registrant') ?? res.entities?.[0] ?? null;
        const orgName = org ? (vcardValue(org, 'fn') ?? vcardValue(org, 'org')) : null;
        if (orgName) fields.push(field('Organisation', orgName));

        const abuse = entityWithRole(res, 'abuse');
        const abuseMail = abuse ? vcardValue(abuse, 'email') : null;
        if (abuseMail) fields.push(field('Contact abuse', abuseMail, { href: `mailto:${abuseMail}` }));

        return {
            summary: orgName ? `Bloc annoncé par ${orgName}.` : 'Bloc réseau trouvé.',
            fields,
            raw: JSON.stringify(res, null, 2)
        };
    }
};
