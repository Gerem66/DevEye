// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { fetchJson } from '@/Services/netFetch';
import { field, tag, type OsintField, type OsintLink, type OsintProbeAdapter } from './shared';

/**
 * Les personnes notoires (élus, dirigeants, artistes, chercheurs) : Wikidata
 * rend leur état civil public et, surtout, leurs comptes déclarés, qui
 * deviennent des rebonds vers la recherche par pseudo.
 */

const API = 'https://www.wikidata.org/w/api.php';
/** Wikimedia exige un agent identifiable, sous peine de refus. */
const HEADERS = { 'user-agent': 'DevEye-OSINT (https://deveye.fr)' };
const MAX_PEOPLE = 3;

interface Snak {
    datavalue?: { value?: unknown };
}
interface Claim {
    mainsnak?: Snak;
}
interface Entity {
    id: string;
    labels?: Record<string, { value: string }>;
    descriptions?: Record<string, { value: string }>;
    claims?: Record<string, Claim[]>;
    sitelinks?: Record<string, { url?: string }>;
}
interface EntitiesResponse {
    entities?: Record<string, Entity>;
}
interface SearchResponse {
    search?: { id: string }[];
}

/** Un compte déclaré : où il mène, et s'il vaut un rebond vers la recherche par pseudo. */
const ACCOUNTS: { prop: string; label: string; url: (v: string) => string; pivot?: true }[] = [
    { prop: 'P2002', label: 'X', url: (v) => `https://x.com/${v}`, pivot: true },
    { prop: 'P2003', label: 'Instagram', url: (v) => `https://www.instagram.com/${v}/`, pivot: true },
    { prop: 'P7085', label: 'TikTok', url: (v) => `https://www.tiktok.com/@${v}`, pivot: true },
    { prop: 'P2037', label: 'GitHub', url: (v) => `https://github.com/${v}`, pivot: true },
    { prop: 'P2013', label: 'Facebook', url: (v) => `https://www.facebook.com/${v}` },
    { prop: 'P6634', label: 'LinkedIn', url: (v) => `https://www.linkedin.com/in/${v}` },
    { prop: 'P2397', label: 'YouTube', url: (v) => `https://www.youtube.com/channel/${v}` },
    { prop: 'P12361', label: 'Bluesky', url: (v) => `https://bsky.app/profile/${v}` },
    {
        prop: 'P4033',
        label: 'Mastodon',
        url: (v) => {
            const [user, host] = v.replace(/^@/, '').split('@');
            return host ? `https://${host}/@${user}` : `https://mastodon.social/@${user}`;
        }
    }
];

/** Les propriétés dont la valeur est un autre élément, à traduire en libellé. */
const ITEM_PROPS: { prop: string; label: string }[] = [
    { prop: 'P27', label: 'Nationalité' },
    { prop: 'P106', label: 'Occupation' },
    { prop: 'P108', label: 'Employeur' },
    { prop: 'P39', label: 'Fonction' }
];

function values(e: Entity, prop: string): unknown[] {
    return (e.claims?.[prop] ?? []).map((c) => c.mainsnak?.datavalue?.value).filter((v) => v !== undefined);
}

/** Les valeurs texte d'une propriété, sans doublon de casse (`Pseudo`, `pseudo`). */
function strings(e: Entity, prop: string): string[] {
    const texts = values(e, prop).filter((v): v is string => typeof v === 'string');
    return [...new Map(texts.map((t) => [t.toLowerCase(), t])).values()];
}

function itemIds(e: Entity, prop: string): string[] {
    return values(e, prop)
        .map((v) => (v as { id?: string }).id)
        .filter((id): id is string => typeof id === 'string');
}

function labelOf(e: Entity | undefined): string | null {
    return e?.labels?.fr?.value ?? e?.labels?.en?.value ?? null;
}

/** `+1967-08-25T00:00:00Z` à la précision donnée : 9 l'année, 10 le mois, 11 le jour. */
function wikiDate(e: Entity, prop: string): string | null {
    const v = values(e, prop)[0] as { time?: string; precision?: number } | undefined;
    const m = v?.time?.match(/^[+-](\d+)-(\d{2})-(\d{2})/);
    if (!m) return null;
    if ((v?.precision ?? 11) <= 9) return m[1];
    if (v?.precision === 10) return `${m[2]}/${m[1]}`;
    return `${m[3]}/${m[2]}/${m[1]}`;
}

async function entities(ids: string[], props: string): Promise<Record<string, Entity>> {
    if (ids.length === 0) return {};
    const params = new URLSearchParams({
        action: 'wbgetentities',
        ids: ids.join('|'),
        props,
        languages: 'fr|en',
        sitefilter: 'frwiki|enwiki',
        format: 'json'
    });
    const data = await fetchJson<EntitiesResponse>(`${API}?${params.toString()}`, HEADERS);
    return data.entities ?? {};
}

export const wikidataProbe: OsintProbeAdapter = {
    id: 'wikidata',
    appliesTo: ['person'],
    ttlMs: 24 * 60 * 60 * 1000,
    async run({ target }) {
        const search = new URLSearchParams({
            action: 'wbsearchentities',
            search: target.value,
            language: 'fr',
            uselang: 'fr',
            type: 'item',
            limit: '10',
            format: 'json'
        });
        const found = await fetchJson<SearchResponse>(`${API}?${search.toString()}`, HEADERS);
        const ids = (found.search ?? []).map((s) => s.id);
        const candidates = await entities(ids, 'labels|descriptions|claims|sitelinks/urls');

        // P31 = Q5 : « nature de l'élément : être humain ». Sans ce filtre, un
        // nom rend aussi les rues, les écoles et les navires qui le portent.
        const people = ids
            .map((id) => candidates[id])
            .filter((e): e is Entity => e !== undefined && itemIds(e, 'P31').includes('Q5'))
            .slice(0, MAX_PEOPLE);

        if (people.length === 0) {
            return {
                status: 'empty',
                summary: `Aucune personne notoire nommée « ${target.value} ». Normal pour un particulier.`
            };
        }

        const refs = [
            ...new Set(
                people.flatMap((p) => [...ITEM_PROPS.map((i) => i.prop), 'P19'].flatMap((prop) => itemIds(p, prop)))
            )
        ];
        const named = await entities(refs.slice(0, 50), 'labels');
        const names = (ids: string[]): string =>
            ids
                .map((id) => labelOf(named[id]))
                .filter(Boolean)
                .slice(0, 4)
                .join(', ');

        const fields: OsintField[] = [];
        const links: OsintLink[] = [];

        for (const p of people) {
            const lines: string[] = [];
            const description = p.descriptions?.fr?.value ?? p.descriptions?.en?.value;
            if (description) lines.push(description);
            const born = wikiDate(p, 'P569');
            const birthplace = names(itemIds(p, 'P19'));
            if (born || birthplace) {
                lines.push(`Né(e)${born ? ` le ${born}` : ''}${birthplace ? ` à ${birthplace}` : ''}`);
            }
            const died = wikiDate(p, 'P570');
            if (died) lines.push(`Décédé(e) le ${died}`);
            for (const { prop, label } of ITEM_PROPS) {
                const v = names(itemIds(p, prop));
                if (v) lines.push(`${label} : ${v}`);
            }
            const accounts = ACCOUNTS.flatMap((a) => strings(p, a.prop).map((v) => `${a.label} : ${v}`));
            if (accounts.length) lines.push(accounts.join('\n'));

            fields.push(field(`${labelOf(p) ?? p.id} (${p.id})`, lines.join('\n')));

            const wiki = p.sitelinks?.frwiki?.url ?? p.sitelinks?.enwiki?.url;
            if (wiki) links.push({ label: `Wikipédia : ${labelOf(p) ?? p.id}`, href: wiki });
            links.push({ label: `Wikidata ${p.id}`, href: `https://www.wikidata.org/wiki/${p.id}` });
            for (const a of ACCOUNTS) {
                for (const v of strings(p, a.prop)) {
                    links.push({ label: `${a.label} : ${v}`, href: a.url(v) });
                    if (a.pivot) links.push({ label: `Pseudo « ${v} »`, href: `osint:username/${v}` });
                }
            }
            for (const site of strings(p, 'P856').slice(0, 2)) {
                links.push({ label: 'Site officiel', href: site });
                links.push({ label: 'Analyser le site', href: `osint:url/${site}` });
            }
        }

        return {
            summary: `${people.length} personne(s) notoire(s) de ce nom. Les comptes listés sont ceux que Wikidata leur attribue.`,
            fields,
            tags: [tag(`${people.length} fiche(s)`, 'neutral')],
            links
        };
    }
};
