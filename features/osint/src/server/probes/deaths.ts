// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { fetchJson } from '@/Services/netFetch';
import { coversName, field, nameTokens, tag, type OsintField, type OsintProbeAdapter } from './shared';

/**
 * Le fichier des personnes décédées de l'INSEE (depuis 1970), par l'API de
 * matchID. Sa recherche est floue : on ne garde que les fiches qui portent
 * tous les mots saisis, sans quoi « Dupont » ramènerait les « Dupond ».
 */

const PAGE_SIZE = 100;
const SHOWN = 10;

interface MatchIdPlace {
    city?: string | string[];
    departmentCode?: string;
    country?: string;
}

interface MatchIdPerson {
    id: string;
    name?: { first?: string[] | string; last?: string };
    sex?: string;
    birth?: { date?: string; location?: MatchIdPlace };
    death?: { date?: string; age?: number; location?: MatchIdPlace };
}

interface MatchIdResponse {
    response?: { total?: number; persons?: MatchIdPerson[] };
}

/** `19670825` → `25/08/1967`. Les jours ou mois inconnus valent `00`. */
function frDate(raw: string | undefined): string {
    const m = raw?.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return '?';
    return [m[3], m[2], m[1]].filter((p) => p !== '00').join('/');
}

function place(p: MatchIdPlace | undefined): string {
    const city = Array.isArray(p?.city) ? p.city[0] : p?.city;
    if (!city) return p?.country ?? '?';
    if (p?.country && p.country !== 'France') return `${city} (${p.country})`;
    return p?.departmentCode ? `${city} (${p.departmentCode})` : city;
}

function fullName(p: MatchIdPerson): string {
    const first = Array.isArray(p.name?.first) ? p.name.first.join(' ') : (p.name?.first ?? '');
    return `${first} ${p.name?.last ?? ''}`.trim();
}

export const deathsProbe: OsintProbeAdapter = {
    id: 'deaths',
    appliesTo: ['person'],
    ttlMs: 24 * 60 * 60 * 1000,
    async run({ target }) {
        const params = new URLSearchParams({ q: target.value, size: String(PAGE_SIZE) });
        const data = await fetchJson<MatchIdResponse>(
            `https://deces.matchid.io/deces/api/v1/search?${params.toString()}`,
            {},
            8000
        );

        const wanted = nameTokens(target.value);
        const persons = data.response?.persons ?? [];
        const exact = persons.filter((p) => coversName(wanted, fullName(p)));
        const more = persons.length === PAGE_SIZE && (data.response?.total ?? 0) > PAGE_SIZE;
        const lookalikes = persons.length - exact.length;

        if (exact.length === 0) {
            return {
                status: 'empty',
                summary: `Aucun décès enregistré depuis 1970 au nom exact de « ${target.value} ».`,
                fields: lookalikes ? [field('Noms voisins', `${lookalikes} fiche(s) écartée(s)`)] : []
            };
        }

        const fields: OsintField[] = exact
            .slice(0, SHOWN)
            .map((p) =>
                field(
                    fullName(p),
                    [
                        `Né(e) le ${frDate(p.birth?.date)} à ${place(p.birth?.location)}`,
                        `Décédé(e) le ${frDate(p.death?.date)} à ${place(p.death?.location)}${p.death?.age != null ? `, à ${p.death.age} ans` : ''}`
                    ].join('\n')
                )
            );
        if (exact.length > SHOWN) fields.push(field('Autres', `${exact.length - SHOWN} fiche(s) non affichée(s)`));

        const count = `${more ? 'au moins ' : ''}${exact.length}`;
        return {
            summary: `${count} personne(s) décédée(s) portant ce nom. Un homonyme n'est pas la personne cherchée : comparer dates et lieux.`,
            fields,
            tags: [tag(`${count} fiche(s)`, 'neutral')],
            links: [
                {
                    label: 'Rechercher sur matchID',
                    href: `https://deces.matchid.io/search?q=${encodeURIComponent(target.value)}`
                }
            ],
            raw: JSON.stringify(exact, null, 2)
        };
    }
};
