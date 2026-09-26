// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { fetchJson } from '@/Services/netFetch';
import { field, formatDate, tag, type OsintField, type OsintLink, type OsintProbeAdapter } from './shared';

/**
 * Keybase : les comptes qu'une personne a prouvé détenir, par une signature
 * publiée sur chacun. Là où la carte « Profils » dit « ce pseudo est pris »,
 * celle-ci dit « ces comptes sont à la même personne ».
 */

interface KeybaseProof {
    proof_type?: string;
    nametag?: string;
    state?: number;
    service_url?: string;
}

interface KeybaseUser {
    basics?: { username?: string; ctime?: number };
    profile?: { full_name?: string | null; location?: string | null; bio?: string | null } | null;
    proofs_summary?: { all?: KeybaseProof[] };
}

interface KeybaseLookup {
    status?: { code?: number; desc?: string };
    them?: (KeybaseUser | null)[];
}

/** Les preuves dont le `nametag` est un pseudo, qui vaut donc un rebond. */
const HANDLE_PROOFS = new Set(['twitter', 'github', 'reddit', 'hackernews', 'mastodon', 'facebook']);
/** Les preuves dont le `nametag` est un domaine. */
const DOMAIN_PROOFS = new Set(['dns', 'generic_web_site']);

export const keybaseProbe: OsintProbeAdapter = {
    id: 'keybase',
    appliesTo: ['username'],
    ttlMs: 6 * 60 * 60 * 1000,
    async run({ target }) {
        // Sans ce filtre, Keybase répond 200 avec une erreur de saisie en corps.
        if (!/^[a-z0-9_]{2,16}$/.test(target.value)) {
            return { status: 'empty', summary: 'Pseudo hors du format Keybase (lettres, chiffres et _, 16 au plus).' };
        }
        const params = new URLSearchParams({ usernames: target.value, fields: 'basics,profile,proofs_summary' });
        const data = await fetchJson<KeybaseLookup>(
            `https://keybase.io/_/api/1.0/user/lookup.json?${params.toString()}`
        );
        const user = data.them?.[0];
        if (!user?.basics?.username) {
            return { status: 'empty', summary: `Aucun compte Keybase « ${target.value} ».` };
        }

        // `state` 1 : preuve vérifiée. Les autres sont révoquées ou cassées,
        // et ne prouvent plus rien.
        const proofs = (user.proofs_summary?.all ?? []).filter((p) => p.state === 1 && p.nametag && p.proof_type);
        const fields: OsintField[] = [];
        const name = user.profile?.full_name;
        if (name) fields.push(field('Nom', name));
        if (user.profile?.location) fields.push(field('Lieu', user.profile.location));
        if (user.profile?.bio) fields.push(field('Bio', user.profile.bio));
        if (user.basics.ctime) {
            fields.push(field('Inscrit le', formatDate(new Date(user.basics.ctime * 1000).toISOString()) ?? '?'));
        }
        if (proofs.length) {
            fields.push(
                field(
                    `Identités prouvées (${proofs.length})`,
                    proofs.map((p) => `${p.proof_type} : ${p.nametag}`).join('\n'),
                    { mono: true }
                )
            );
        }

        const links: OsintLink[] = [
            { label: 'Profil Keybase', href: `https://keybase.io/${encodeURIComponent(user.basics.username)}` }
        ];
        for (const p of proofs) {
            if (p.service_url) links.push({ label: `${p.proof_type} : ${p.nametag}`, href: p.service_url });
            if (HANDLE_PROOFS.has(p.proof_type!) && p.nametag!.toLowerCase() !== target.value) {
                links.push({ label: `Pseudo « ${p.nametag} »`, href: `osint:username/${p.nametag}` });
            }
            if (DOMAIN_PROOFS.has(p.proof_type!)) {
                links.push({ label: `Domaine ${p.nametag}`, href: `osint:domain/${p.nametag}` });
            }
        }
        if (name?.includes(' ')) links.push({ label: `Personne « ${name} »`, href: `osint:person/${name}` });

        return {
            summary: proofs.length
                ? `${proofs.length} compte(s) prouvé(s) appartenir à ${name ?? user.basics.username}.`
                : 'Compte Keybase sans preuve d’identité active.',
            fields,
            tags: proofs.length ? [tag(`${proofs.length} preuve(s)`, 'good')] : [tag('Aucune preuve', 'neutral')],
            links,
            raw: JSON.stringify(user, null, 2)
        };
    }
};
