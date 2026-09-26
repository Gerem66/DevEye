import { createHash } from 'crypto';

// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { safeFetch } from '@/Services/netFetch';
import { field, tag, type OsintField, type OsintLink, type OsintProbeAdapter } from './shared';

/**
 * Le profil public Gravatar : ce que la personne a elle-même rattaché à son
 * adresse (nom, ville, poste, comptes que Gravatar a vérifiés). Indexé par le
 * SHA-256 de l'adresse, ou par le nom de profil pour un pseudo.
 */

interface GravatarAccount {
    service_label?: string;
    url?: string;
    is_hidden?: boolean;
}

interface GravatarProfile {
    display_name?: string;
    profile_url?: string;
    location?: string;
    description?: string;
    job_title?: string;
    company?: string;
    pronouns?: string;
    verified_accounts?: GravatarAccount[];
}

export const gravatarProbe: OsintProbeAdapter = {
    id: 'gravatar',
    appliesTo: ['email', 'username'],
    ttlMs: 6 * 60 * 60 * 1000,
    async run({ target }) {
        const id =
            target.kind === 'email'
                ? createHash('sha256').update(target.value.trim().toLowerCase()).digest('hex')
                : encodeURIComponent(target.value);
        const res = await safeFetch(`https://api.gravatar.com/v3/profiles/${id}`, {
            signal: AbortSignal.timeout(5000),
            headers: { accept: 'application/json', 'user-agent': 'DevEye-OSINT' }
        });
        if (res.status === 404) {
            return { status: 'empty', summary: 'Aucun profil Gravatar public.' };
        }
        if (res.status === 429) throw new Error('Gravatar limite les requêtes, réessayez plus tard.');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const p = (await res.json()) as GravatarProfile;

        const accounts = (p.verified_accounts ?? []).filter((a) => a.url && !a.is_hidden);
        const fields: OsintField[] = [];
        if (p.display_name) fields.push(field('Nom affiché', p.display_name));
        if (p.pronouns) fields.push(field('Pronoms', p.pronouns));
        if (p.location) fields.push(field('Lieu', p.location));
        const job = [p.job_title, p.company].filter(Boolean).join(', ');
        if (job) fields.push(field('Poste', job));
        if (p.description) fields.push(field('Présentation', p.description));
        if (accounts.length) {
            fields.push(
                field(
                    `Comptes vérifiés (${accounts.length})`,
                    accounts.map((a) => `${a.service_label ?? '?'} : ${a.url}`).join('\n'),
                    { mono: true }
                )
            );
        }

        const links: OsintLink[] = [];
        if (p.profile_url) links.push({ label: 'Profil Gravatar', href: p.profile_url });
        for (const a of accounts) links.push({ label: a.service_label ?? a.url!, href: a.url! });
        if (p.display_name?.includes(' ')) {
            links.push({ label: `Personne « ${p.display_name} »`, href: `osint:person/${p.display_name}` });
        }

        return {
            summary: p.display_name
                ? `Profil public de ${p.display_name}${p.location ? `, ${p.location}` : ''}.`
                : 'Profil public sans nom affiché.',
            fields,
            tags: [
                tag('Profil public', 'good'),
                ...(accounts.length ? [tag(`${accounts.length} compte(s) vérifié(s)`, 'good')] : [])
            ],
            links,
            raw: JSON.stringify(p, null, 2)
        };
    }
};
