import { mapLimit } from '@deveye/types/sdk/server';

// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { safeFetch } from '@/Services/netFetch';
import {
    coversName,
    field,
    formatDate,
    nameTokens,
    skipped,
    tag,
    type OsintField,
    type OsintLink,
    type OsintProbeAdapter,
    type OsintProbeDraft
} from './shared';

/**
 * GitHub, trois questions selon la cible : la fiche d'un pseudo, les comptes
 * qui portent un nom, les commits publics signés d'une adresse. Sans jeton,
 * l'API tolère quelques recherches par heure pour tout le serveur : la limite
 * atteinte rend `skipped` avec le lien pour en créer un, jamais une erreur.
 */

const TOKEN_LINK: OsintLink = {
    label: 'Créer un jeton GitHub (gratuit, sans droit)',
    href: 'https://github.com/settings/personal-access-tokens/new'
};

class RateLimited extends Error {}

async function gh<T>(path: string, key: string | null): Promise<T | null> {
    const res = await safeFetch(`https://api.github.com${path}`, {
        signal: AbortSignal.timeout(6000),
        headers: {
            accept: 'application/vnd.github+json',
            'user-agent': 'DevEye-OSINT',
            'x-github-api-version': '2022-11-28',
            ...(key ? { authorization: `Bearer ${key}` } : {})
        }
    });
    if (res.status === 404 || res.status === 422) return null;
    if (res.status === 401) throw new Error('Jeton GitHub refusé : vérifiez-le dans les réglages.');
    // La limite secondaire répond 403 sans toucher à `x-ratelimit-remaining` :
    // seul le corps la nomme.
    if (res.status === 429 || res.status === 403) {
        const body = await res.text();
        if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(body)) {
            throw new RateLimited();
        }
        throw new Error(`HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
}

interface GhUser {
    login: string;
    type?: string;
    html_url: string;
    name?: string | null;
    company?: string | null;
    blog?: string | null;
    location?: string | null;
    email?: string | null;
    bio?: string | null;
    twitter_username?: string | null;
    public_repos?: number;
    followers?: number;
    created_at?: string;
}

interface GhCommitItem {
    html_url: string;
    commit: { author?: { name?: string; email?: string; date?: string } };
    author?: { login: string; html_url: string } | null;
    repository?: { full_name: string; html_url: string };
}

/** Les rebonds qu'une fiche offre : son site, son compte X, son adresse publique. */
function profilePivots(u: GhUser): OsintLink[] {
    const links: OsintLink[] = [];
    if (u.blog) {
        const site = /^https?:\/\//i.test(u.blog) ? u.blog : `https://${u.blog}`;
        links.push({ label: 'Site', href: site }, { label: 'Analyser le site', href: `osint:url/${site}` });
    }
    if (u.twitter_username) {
        links.push({ label: `Pseudo « ${u.twitter_username} »`, href: `osint:username/${u.twitter_username}` });
    }
    if (u.email) links.push({ label: u.email, href: `osint:email/${u.email}` });
    return links;
}

function profileLines(u: GhUser): string {
    return [
        u.name,
        u.bio,
        [u.company, u.location].filter(Boolean).join(', '),
        u.created_at ? `Inscrit le ${formatDate(u.created_at)}` : null
    ]
        .filter(Boolean)
        .join('\n');
}

async function byUsername(login: string, key: string | null): Promise<OsintProbeDraft> {
    const u = await gh<GhUser>(`/users/${encodeURIComponent(login)}`, key);
    if (!u) return { status: 'empty', summary: `Aucun compte GitHub « ${login} ».` };

    const fields: OsintField[] = [field('Compte', u.login, { mono: true, href: u.html_url })];
    if (u.name) fields.push(field('Nom affiché', u.name));
    if (u.bio) fields.push(field('Bio', u.bio));
    if (u.company) fields.push(field('Société', u.company));
    if (u.location) fields.push(field('Lieu', u.location));
    if (u.blog) fields.push(field('Site', u.blog, { mono: true }));
    if (u.email) fields.push(field('Adresse publique', u.email, { mono: true }));
    if (u.twitter_username) fields.push(field('X', `@${u.twitter_username}`, { mono: true }));
    if (u.created_at) fields.push(field('Inscrit le', formatDate(u.created_at) ?? u.created_at));
    fields.push(field('Activité', `${u.public_repos ?? 0} dépôt(s) public(s), ${u.followers ?? 0} abonné(s)`));

    const pivots = profilePivots(u);
    if (u.name && u.name.includes(' ')) {
        pivots.push({ label: `Personne « ${u.name} »`, href: `osint:person/${u.name}` });
    }

    return {
        summary: u.name ? `${u.name}${u.location ? `, ${u.location}` : ''}.` : 'Compte sans nom affiché.',
        fields,
        tags: [
            tag(u.type === 'Organization' ? 'Organisation' : 'Compte personnel', 'neutral'),
            ...(u.name ? [tag('Nom déclaré', 'good')] : [])
        ],
        links: [{ label: 'Profil GitHub', href: u.html_url }, ...pivots],
        raw: JSON.stringify(u, null, 2)
    };
}

async function byName(name: string, key: string | null): Promise<OsintProbeDraft> {
    const q = encodeURIComponent(`fullname:"${name}"`);
    const found = await gh<{ items?: { login: string }[] }>(`/search/users?q=${q}&per_page=6`, key);
    const logins = (found?.items ?? []).map((i) => i.login);
    const wanted = nameTokens(name);
    const profiles = (await mapLimit(logins, 3, (l) => gh<GhUser>(`/users/${encodeURIComponent(l)}`, key))).filter(
        (u): u is GhUser => u !== null && coversName(wanted, u.name ?? '')
    );

    if (profiles.length === 0) {
        return { status: 'empty', summary: `Aucun compte GitHub au nom de « ${name} ».` };
    }

    return {
        summary: `${profiles.length} compte(s) GitHub au nom de « ${name} ». Lieu et société aident à départager les homonymes.`,
        fields: profiles.map((u) => field(u.login, profileLines(u), { href: u.html_url })),
        tags: [tag(`${profiles.length} compte(s)`, 'neutral')],
        links: profiles.flatMap((u) => [
            { label: `Pseudo « ${u.login} »`, href: `osint:username/${u.login}` },
            ...profilePivots(u)
        ])
    };
}

async function byEmail(email: string, key: string | null): Promise<OsintProbeDraft> {
    const q = encodeURIComponent(`author-email:${email}`);
    const found = await gh<{ items?: GhCommitItem[] }>(`/search/commits?q=${q}&per_page=50`, key);
    // L'adresse et le nom d'auteur d'un commit se déclarent, ils ne se prouvent
    // pas : on trouve des commits signés d'adresses célèbres et datés de 2099.
    // Seul le compte que GitHub y rattache fait foi, car il a dû vérifier l'adresse.
    const now = Date.now();
    const commits = (found?.items ?? []).filter(
        (c) => c.commit.author?.email?.toLowerCase() === email && !(Date.parse(c.commit.author.date ?? '') > now)
    );

    if (commits.length === 0) {
        return { status: 'empty', summary: 'Aucun commit public signé de cette adresse sur GitHub.' };
    }

    const accounts = new Map<string, string>();
    const repos = new Set<string>();
    const declared = new Set<string>();
    const vouched = new Set<string>();
    for (const c of commits) {
        const name = c.commit.author?.name;
        if (name) declared.add(name);
        if (c.author) {
            accounts.set(c.author.login, c.author.html_url);
            if (name) vouched.add(name);
        }
        if (c.repository) repos.add(c.repository.full_name);
    }
    const logins = [...accounts.keys()];

    const fields: OsintField[] = [
        field('Compte rattaché', logins.length ? logins.join('\n') : 'Aucun parmi les commits trouvés', {
            mono: logins.length > 0
        }),
        field('Noms déclarés', [...declared].slice(0, 6).join('\n')),
        field(`Dépôts (${repos.size})`, [...repos].slice(0, 8).join('\n'), { mono: true })
    ];

    return {
        summary: logins.length
            ? `Adresse vérifiée par le compte GitHub ${logins[0]}${logins.length > 1 ? ` (et ${logins.length - 1} autre(s))` : ''}.`
            : `${commits.length} commit(s) public(s) portent cette adresse, mais aucun compte GitHub ne l'a vérifiée : le nom d'auteur d'un commit est déclaratif.`,
        fields,
        tags: [
            logins.length ? tag('Compte vérifié', 'good') : tag('Aucun compte vérifié', 'warn'),
            tag(`${commits.length} commit(s)`, 'neutral')
        ],
        links: [
            ...[...accounts.entries()].flatMap(([login, url]) => [
                { label: `Profil ${login}`, href: url },
                { label: `Pseudo « ${login} »`, href: `osint:username/${login}` }
            ]),
            // Un nom ne vaut un rebond que porté par un commit que GitHub a
            // rattaché à un compte : les autres, n'importe qui a pu les écrire.
            ...[...vouched]
                .filter((n) => n.includes(' '))
                .slice(0, 3)
                .map((n) => ({ label: `Personne « ${n} »`, href: `osint:person/${n}` }))
        ]
    };
}

export const githubProbe: OsintProbeAdapter = {
    id: 'github',
    appliesTo: ['username', 'person', 'email'],
    ttlMs: 6 * 60 * 60 * 1000,
    async run({ target, key }) {
        try {
            if (target.kind === 'email') return await byEmail(target.value, key);
            if (target.kind === 'person') return await byName(target.value, key);
            return await byUsername(target.value, key);
        } catch (e) {
            if (!(e instanceof RateLimited)) throw e;
            if (key) return { status: 'error', summary: 'Limite de GitHub atteinte, réessayez dans quelques minutes.' };
            return skipped(
                'Limite de GitHub atteinte : sans jeton, le serveur n’a droit qu’à quelques recherches par heure. Un jeton personnel, gratuit et sans aucun droit, la lève.',
                [TOKEN_LINK]
            );
        }
    }
};
