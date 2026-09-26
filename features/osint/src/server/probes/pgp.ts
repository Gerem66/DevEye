// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { safeFetch } from '@/Services/netFetch';
import { field, tag, type OsintField, type OsintLink, type OsintProbeAdapter } from './shared';

/**
 * Les clés PGP publiées pour une adresse. Deux serveurs, deux garanties :
 * keyserver.ubuntu.com accepte n'importe quelle clé (l'identité y est
 * déclarée, pas prouvée), keys.openpgp.org ne sert une adresse qu'après que
 * son détenteur a cliqué le lien reçu dans la boîte.
 */

export interface PgpKey {
    fingerprint: string;
    created: number | null;
    revoked: boolean;
    uids: string[];
}

/** Le format « machine-readable » de HKP : des lignes `pub:` suivies de leurs `uid:`. */
export function parseKeyIndex(text: string): PgpKey[] {
    const keys: PgpKey[] = [];
    for (const line of text.split('\n')) {
        const parts = line.trim().split(':');
        if (parts[0] === 'pub') {
            const created = Number(parts[4]);
            keys.push({
                fingerprint: parts[1],
                created: Number.isFinite(created) && created > 0 ? created : null,
                revoked: (parts[6] ?? '').includes('r'),
                uids: []
            });
        } else if (parts[0] === 'uid' && keys.length > 0) {
            // L'uid est échappé en %XX par la norme, mais pas par tous les
            // serveurs : un deux-points en clair le couperait, d'où le recollage.
            let uid = parts.slice(1, Math.max(2, parts.length - 3)).join(':');
            try {
                uid = decodeURIComponent(uid);
            } catch {
                // Un `%` littéral : l'uid était déjà en clair.
            }
            if (uid) keys[keys.length - 1].uids.push(uid);
        }
    }
    return keys;
}

async function ubuntuKeys(email: string): Promise<PgpKey[]> {
    const params = new URLSearchParams({ op: 'index', search: email, options: 'mr', exact: 'on' });
    const res = await safeFetch(`https://keyserver.ubuntu.com/pks/lookup?${params.toString()}`, {
        signal: AbortSignal.timeout(6000),
        headers: { 'user-agent': 'DevEye-OSINT' }
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return parseKeyIndex(await res.text());
}

async function verifiedByOpenpgp(email: string): Promise<boolean> {
    const res = await safeFetch(`https://keys.openpgp.org/vks/v1/by-email/${encodeURIComponent(email)}`, {
        signal: AbortSignal.timeout(6000),
        headers: { 'user-agent': 'DevEye-OSINT' }
    });
    await res.body?.cancel();
    return res.ok;
}

export const pgpProbe: OsintProbeAdapter = {
    id: 'pgp',
    appliesTo: ['email'],
    ttlMs: 6 * 60 * 60 * 1000,
    async run({ target }) {
        const [keys, verified] = await Promise.all([ubuntuKeys(target.value), verifiedByOpenpgp(target.value)]);

        if (keys.length === 0 && !verified) {
            return { status: 'empty', summary: 'Aucune clé PGP publiée pour cette adresse.' };
        }

        const fields: OsintField[] = keys
            .slice(0, 6)
            .map((k) =>
                field(
                    `${k.fingerprint.slice(-16)}${k.revoked ? ' (révoquée)' : ''}`,
                    [...k.uids, k.created ? `Créée le ${new Date(k.created * 1000).toLocaleDateString('fr-FR')}` : null]
                        .filter(Boolean)
                        .join('\n'),
                    { mono: true }
                )
            );
        fields.push(
            field('keys.openpgp.org', verified ? 'Adresse confirmée par son détenteur' : 'Aucune clé confirmée')
        );

        // Les autres adresses et les noms des uids sont les vrais rebonds.
        const others = new Set<string>();
        const names = new Set<string>();
        for (const uid of keys.flatMap((k) => k.uids)) {
            const mail = uid.match(/<([^>\s]+@[^>\s]+)>/)?.[1]?.toLowerCase();
            if (mail && mail !== target.value) others.add(mail);
            const name = uid.replace(/<[^>]*>|\([^)]*\)/g, '').trim();
            if (name.includes(' ') && !name.includes('@')) names.add(name);
        }
        const links: OsintLink[] = [
            ...[...others].slice(0, 5).map((m) => ({ label: m, href: `osint:email/${m}` })),
            ...[...names].slice(0, 3).map((n) => ({ label: `Personne « ${n} »`, href: `osint:person/${n}` })),
            {
                label: 'keyserver.ubuntu.com',
                href: `https://keyserver.ubuntu.com/pks/lookup?op=index&search=${encodeURIComponent(target.value)}`
            }
        ];

        return {
            summary:
                keys.length === 0
                    ? 'Une clé confirmée sur keys.openpgp.org, absente de keyserver.ubuntu.com.'
                    : `${keys.length} clé(s) publiée(s)${names.size ? ` au nom de ${[...names].slice(0, 2).join(', ')}` : ''}. Sur keyserver.ubuntu.com, l'identité est déclarée, pas vérifiée.`,
            fields,
            tags: [
                tag(`${keys.length} clé(s)`, 'neutral'),
                ...(verified ? [tag('Confirmée', 'good')] : []),
                ...(others.size ? [tag(`${others.size} autre(s) adresse(s)`, 'good')] : [])
            ],
            links
        };
    }
};
