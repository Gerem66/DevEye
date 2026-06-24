import {
    EMPTY,
    faviconUrl,
    fetchJson,
    fmtCount,
    openGraphPreview,
    relativeShort,
    type TemplateAdapter
} from './shared';

/** Routes that aren't a user/org or repo, so they fall back to Open Graph. */
const RESERVED = new Set([
    'orgs',
    'features',
    'about',
    'pricing',
    'marketplace',
    'sponsors',
    'settings',
    'topics',
    'trending',
    'collections',
    'explore'
]);

interface GhUser {
    name: string | null;
    login: string;
    bio: string | null;
    avatar_url: string | null;
    public_repos: number;
    followers: number;
}
interface GhRepo {
    full_name: string;
    description: string | null;
    stargazers_count: number;
    forks_count: number;
    /** Last push to any branch — a good "is this active?" signal. */
    pushed_at: string;
    owner: { avatar_url: string | null } | null;
}

const ghHeaders = { accept: 'application/vnd.github+json' };

/**
 * GitHub preview via the public API: a repository (owner/repo) shows stars,
 * forks and language; a profile (owner) shows repos and followers.
 */
export const github: TemplateAdapter = {
    async fetch(url) {
        let u: URL;
        try {
            u = new URL(url);
        } catch {
            return EMPTY;
        }
        const seg = u.pathname.split('/').filter(Boolean);
        const owner = seg[0];
        if (!owner || RESERVED.has(owner.toLowerCase())) return openGraphPreview(url);

        if (seg.length >= 2) {
            const data = await fetchJson<GhRepo>(
                `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(seg[1])}`,
                ghHeaders
            );
            const stats = [
                { label: 'Stars', value: fmtCount(data.stargazers_count) },
                { label: 'Forks', value: fmtCount(data.forks_count) }
            ];
            const updated = relativeShort(data.pushed_at);
            if (updated) stats.push({ label: 'maj', value: updated });
            return {
                ok: true,
                title: data.full_name,
                subtitle: data.description ?? `@${owner}`,
                imageUrl: data.owner?.avatar_url ?? faviconUrl('github.com'),
                stats
            };
        }

        const data = await fetchJson<GhUser>(`https://api.github.com/users/${encodeURIComponent(owner)}`, ghHeaders);
        return {
            ok: true,
            title: data.name || data.login,
            subtitle: data.bio || `@${data.login}`,
            imageUrl: data.avatar_url ?? faviconUrl('github.com'),
            stats: [
                { label: 'Repos', value: fmtCount(data.public_repos) },
                { label: 'Abonnés', value: fmtCount(data.followers) }
            ]
        };
    }
};
