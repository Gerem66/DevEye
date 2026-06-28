import { faviconUrl, fmtCount, isValidHttpUrl, openGraphPreview, relativeShort, type TemplateAdapter } from './shared';

/**
 * Twitch has no public REST API without an OAuth app, so we use the same
 * undocumented GraphQL endpoint the web client uses, with its public web
 * Client-Id (read-only public data: follower count, live state, viewers). It's
 * unofficial and could change — on any failure we degrade to Open Graph.
 */
const GQL = 'https://gql.twitch.tv/gql';
const PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

// Routes that aren't a channel login.
const RESERVED = new Set(['directory', 'videos', 'p', 'settings', 'subscriptions', 'downloads', 'jobs', 'turbo']);

interface TwitchGql {
    data?: {
        user?: {
            displayName?: string;
            description?: string | null;
            profileImageURL?: string | null;
            followers?: { totalCount?: number };
            stream?: { viewersCount?: number; type?: string } | null;
            lastBroadcast?: { startedAt?: string | null } | null;
        } | null;
    };
}

export const twitch: TemplateAdapter = {
    async fetch(url) {
        let u: URL;
        try {
            u = new URL(url);
        } catch {
            return openGraphPreview(url);
        }
        const login = u.pathname.split('/').filter(Boolean)[0];
        if (!login || RESERVED.has(login.toLowerCase())) return openGraphPreview(url);

        try {
            const res = await fetch(GQL, {
                method: 'POST',
                signal: AbortSignal.timeout(4500),
                headers: { 'Client-Id': PUBLIC_CLIENT_ID, 'content-type': 'application/json' },
                body: JSON.stringify({
                    query: `query{user(login:"${login.replace(/"/g, '')}"){displayName description profileImageURL(width:300) followers{totalCount} stream{viewersCount type} lastBroadcast{startedAt}}}`
                })
            });
            if (!res.ok) throw new Error(`Twitch ${res.status}`);
            const user = ((await res.json()) as TwitchGql).data?.user;
            if (!user) return openGraphPreview(url);

            const live = user.stream?.type === 'live';
            const stats = [{ label: 'Abonnés', value: fmtCount(user.followers?.totalCount ?? 0) }];
            if (live) {
                // Live/offline itself is shown by the corner status dot; only the
                // extra detail (viewers / last-broadcast age) goes in the stats.
                stats.push({ label: 'en live', value: `🔴 ${fmtCount(user.stream?.viewersCount ?? 0)}` });
            } else {
                const last = user.lastBroadcast?.startedAt ? relativeShort(user.lastBroadcast.startedAt) : null;
                if (last) stats.push({ label: 'Dernier live', value: `il y a ${last}` });
            }

            return {
                ok: true,
                title: user.displayName || login,
                subtitle: user.description || null,
                imageUrl:
                    user.profileImageURL && isValidHttpUrl(user.profileImageURL)
                        ? user.profileImageURL
                        : faviconUrl('twitch.tv'),
                stats,
                status: live ? 'online' : 'offline'
            };
        } catch {
            return openGraphPreview(url);
        }
    }
};
