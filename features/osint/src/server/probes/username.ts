// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { BROWSER_UA } from '@/Services/netFetch';
import { field, mapLimit, tag, type OsintProbeAdapter, type OsintLink } from './shared';

/**
 * Existence d'un pseudo sur une liste courte de sites vérifiés : l'approche
 * « Sherlock » (des centaines de sites) rend surtout du bruit. « Trouvé » veut
 * dire que l'identifiant est pris, pas que c'est la même personne.
 */

const SITE_TIMEOUT_MS = 5000;
const CONCURRENCY = 6;

interface SiteCheck {
    name: string;
    /** `{}` est remplacé par le pseudo. */
    url: string;
    /**
     * Comment le site dit « ce compte n'existe pas ».
     *  - `status`  : un 404 (le cas normal) ;
     *  - `content` : un 200 qui contient un marqueur d'absence.
     */
    absent?: { kind: 'content'; marker: string };
}

const SITES: SiteCheck[] = [
    { name: 'GitHub', url: 'https://github.com/{}' },
    { name: 'GitLab', url: 'https://gitlab.com/{}' },
    { name: 'Reddit', url: 'https://www.reddit.com/user/{}/about.json' },
    { name: 'Instagram', url: 'https://www.instagram.com/{}/' },
    { name: 'TikTok', url: 'https://www.tiktok.com/@{}' },
    { name: 'Twitch', url: 'https://www.twitch.tv/{}' },
    { name: 'Telegram', url: 'https://t.me/{}', absent: { kind: 'content', marker: 'tgme_page_title' } },
    { name: 'Keybase', url: 'https://keybase.io/{}' },
    { name: 'npm', url: 'https://www.npmjs.com/~{}' },
    { name: 'PyPI', url: 'https://pypi.org/user/{}/' },
    { name: 'Docker Hub', url: 'https://hub.docker.com/v2/users/{}/' },
    {
        name: 'Hacker News',
        url: 'https://news.ycombinator.com/user?id={}',
        absent: { kind: 'content', marker: 'No such user' }
    },
    { name: 'Medium', url: 'https://medium.com/@{}' },
    { name: 'SoundCloud', url: 'https://soundcloud.com/{}' },
    { name: 'Vimeo', url: 'https://vimeo.com/{}' },
    { name: 'Flickr', url: 'https://www.flickr.com/people/{}/' },
    { name: 'Behance', url: 'https://www.behance.net/{}' },
    { name: 'Dribbble', url: 'https://dribbble.com/{}' },
    { name: 'about.me', url: 'https://about.me/{}' },
    { name: 'Pinterest', url: 'https://www.pinterest.com/{}/' },
    {
        name: 'Steam',
        url: 'https://steamcommunity.com/id/{}',
        absent: { kind: 'content', marker: 'The specified profile could not be found' }
    },
    { name: 'Last.fm', url: 'https://www.last.fm/user/{}' },
    { name: 'Bandcamp', url: 'https://bandcamp.com/{}' },
    { name: 'Mastodon (mastodon.social)', url: 'https://mastodon.social/@{}' },
    { name: 'Codeberg', url: 'https://codeberg.org/{}' },
    { name: 'Replit', url: 'https://replit.com/@{}' },
    { name: 'Kaggle', url: 'https://www.kaggle.com/{}' },
    { name: 'Chess.com', url: 'https://www.chess.com/member/{}' }
];

type Verdict = 'found' | 'absent' | 'unknown';

async function check(site: SiteCheck, username: string): Promise<{ site: SiteCheck; verdict: Verdict; url: string }> {
    const url = site.url.replace('{}', encodeURIComponent(username));
    try {
        const res = await fetch(url, {
            // `GET` et non `HEAD` : trop de sites répondent 405 ou mentent sur
            // HEAD. Le corps n'est lu que si un marqueur doit y être cherché.
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(SITE_TIMEOUT_MS),
            headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/json' }
        });

        if (res.status === 404 || res.status === 410) return { site, verdict: 'absent', url };
        // 429 / 403 : le site nous bloque, il ne dit rien du pseudo. Le compter
        // comme « trouvé » serait le mensonge le plus courant de ce genre d'outil.
        if (res.status === 429 || res.status === 403) return { site, verdict: 'unknown', url };
        if (!res.ok) return { site, verdict: 'unknown', url };

        if (site.absent) {
            const body = (await res.text()).slice(0, 200_000);
            const present = body.includes(site.absent.marker);
            // Telegram : le marqueur signale la *présence*. Les autres l'absence.
            const marksPresence = site.name === 'Telegram';
            const found = marksPresence ? present : !present;
            return { site, verdict: found ? 'found' : 'absent', url };
        }
        return { site, verdict: 'found', url };
    } catch {
        return { site, verdict: 'unknown', url };
    }
}

export const usernameProbe: OsintProbeAdapter = {
    id: 'username',
    appliesTo: ['username'],
    ttlMs: 60 * 60 * 1000,
    async run({ target }) {
        const username = target.value;
        if (!/^[a-z0-9][a-z0-9._-]{1,38}$/i.test(username)) {
            return { status: 'empty', summary: 'Identifiant non conforme aux formats courants.' };
        }

        const results = await mapLimit(SITES, CONCURRENCY, (s) => check(s, username));

        const found = results.filter((r) => r.verdict === 'found');
        const unknown = results.filter((r) => r.verdict === 'unknown');

        if (found.length === 0) {
            return {
                status: 'empty',
                summary: `« ${username} » n'a été trouvé sur aucun des ${SITES.length} sites vérifiés.`,
                fields: unknown.length ? [field('Indéterminés', unknown.map((r) => r.site.name).join(', '))] : []
            };
        }

        const links: OsintLink[] = found.map((r) => ({ label: r.site.name, href: r.url }));

        const fields = [field(`Trouvé sur (${found.length})`, found.map((r) => r.site.name).join('\n'))];
        if (unknown.length) {
            fields.push(
                field(
                    `Indéterminés (${unknown.length})`,
                    `${unknown.map((r) => r.site.name).join(', ')}\n— site injoignable ou limitant les requêtes, pas une réponse.`
                )
            );
        }
        fields.push(field('Vérifiés', `${SITES.length} sites`));

        return {
            summary: `Identifiant pris sur ${found.length} des ${SITES.length} sites vérifiés. Un même pseudo peut appartenir à des personnes différentes.`,
            fields,
            tags: [
                tag(`${found.length} profil(s)`, found.length > 0 ? 'good' : 'neutral'),
                ...(unknown.length ? [tag(`${unknown.length} indéterminé(s)`, 'warn')] : [])
            ],
            links
        };
    }
};
