import { mapLimit } from '@deveye/types/sdk/server';

// Le garde SSRF est celui de l'app, partagé, pas propre au module.
import { fetchJson } from '@/Services/netFetch';
import {
    coversName,
    field,
    nameTokens,
    tag,
    type OsintField,
    type OsintLink,
    type OsintProbeAdapter,
    type OsintProbeDraft
} from './shared';

/**
 * Mandats de dirigeant à partir d'un nom : l'annuaire public des entreprises
 * (data.gouv, sans clé) par défaut, Pappers quand l'espace a posé sa clé.
 */

const MAX_COMPANIES = 12;

/* ------------------------- Annuaire des entreprises ------------------------ */

interface GouvDirigeant {
    nom?: string | null;
    prenoms?: string | null;
    date_de_naissance?: string | null;
    qualite?: string | null;
    type_dirigeant?: string;
}

interface GouvCompany {
    siren: string;
    nom_complet?: string | null;
    etat_administratif?: string;
    date_creation?: string | null;
    siege?: { code_postal?: string | null; libelle_commune?: string | null };
    dirigeants?: GouvDirigeant[];
}

interface GouvResponse {
    results?: GouvCompany[];
    total_results?: number;
}

/**
 * Les découpages prénom / nom à essayer. L'annuaire cherche sur des champs
 * séparés, et « Jean Pierre Dupont » comme « DUPONT Jean » sont des saisies
 * courantes : deviner une seule coupe manquerait l'une ou l'autre.
 */
export function nameSplits(name: string): { first: string; last: string }[] {
    const t = name.split(' ').filter(Boolean);
    if (t.length < 2) return [];
    const splits = [
        { first: t.slice(0, 1), last: t.slice(1) },
        { first: t.slice(0, -1), last: t.slice(-1) },
        { first: t.slice(1), last: t.slice(0, 1) },
        { first: t.slice(-1), last: t.slice(0, -1) }
    ].map((s) => ({ first: s.first.join(' '), last: s.last.join(' ') }));
    return [...new Map(splits.map((s) => [`${s.first}|${s.last}`, s])).values()];
}

/** `1967-08` → `08/1967`. L'annuaire ne publie jamais le jour. */
function birthMonth(iso: string | null | undefined): string | null {
    const m = iso?.match(/^(\d{4})-(\d{2})/);
    return m ? `${m[2]}/${m[1]}` : null;
}

async function fromAnnuaire(name: string): Promise<OsintProbeDraft> {
    const splits = nameSplits(name);
    if (splits.length === 0) {
        return { status: 'empty', summary: 'Il faut au moins un prénom et un nom.' };
    }

    const pages = await mapLimit(splits, 2, (s) => {
        const params = new URLSearchParams({
            nom_personne: s.last,
            prenoms_personne: s.first,
            type_personne: 'dirigeant',
            per_page: '25'
        });
        return fetchJson<GouvResponse>(`https://recherche-entreprises.api.gouv.fr/search?${params.toString()}`);
    });

    const companies = new Map<string, GouvCompany>();
    for (const page of pages) for (const c of page.results ?? []) companies.set(c.siren, c);
    const truncated = pages.some((p) => (p.total_results ?? 0) > (p.results?.length ?? 0));

    if (companies.size === 0) {
        return { status: 'empty', summary: `Aucun mandat de dirigeant au nom de « ${name} ».` };
    }

    const wanted = nameTokens(name);
    const fields: OsintField[] = [];
    const links: OsintLink[] = [];
    // Deux homonymes se distinguent par leur mois de naissance : c'est la
    // seule donnée publique qui sépare les personnes derrière un même nom.
    const people = new Set<string>();
    let active = 0;

    const sorted = [...companies.values()].sort(
        (a, b) => Number(b.etat_administratif === 'A') - Number(a.etat_administratif === 'A')
    );
    for (const c of sorted) {
        const open = c.etat_administratif === 'A';
        if (open) active++;
        const mandates = (c.dirigeants ?? []).filter(
            (d) => d.type_dirigeant === 'personne physique' && coversName(wanted, `${d.nom ?? ''} ${d.prenoms ?? ''}`)
        );
        for (const d of mandates) people.add(birthMonth(d.date_de_naissance) ?? '?');

        if (fields.length >= MAX_COMPANIES) continue;
        const roles = mandates.map((d) => {
            const born = birthMonth(d.date_de_naissance);
            return [d.qualite ?? 'Dirigeant', born ? `né(e) en ${born}` : null].filter(Boolean).join(', ');
        });
        const where = [c.siege?.code_postal, c.siege?.libelle_commune].filter(Boolean).join(' ');
        const state = open ? (c.date_creation ? `active depuis ${c.date_creation.slice(0, 4)}` : 'active') : 'cessée';
        fields.push(field(c.nom_complet ?? c.siren, [...roles, [where, state].filter(Boolean).join(', ')].join('\n')));
        links.push({
            label: `${c.nom_complet ?? c.siren} (SIREN ${c.siren})`,
            href: `https://annuaire-entreprises.data.gouv.fr/entreprise/${c.siren}`
        });
    }

    // Au-delà d'une page, le total annoncé par l'annuaire est une borne basse
    // (les découpages se recouvrent), et l'activité n'est comptée que sur ce qui a été lu.
    const reported = Math.max(companies.size, ...pages.map((p) => p.total_results ?? 0));
    const count = `${truncated ? 'au moins ' : ''}${reported}`;
    const distinct = [...people].filter((p) => p !== '?').length;

    return {
        summary: truncated
            ? `${count} entreprise(s) dirigée(s) par une personne de ce nom. Sur les ${companies.size} lues, ${active} en activité.`
            : `${count} entreprise(s) dirigée(s) par une personne de ce nom, dont ${active} en activité.`,
        fields,
        tags: [
            tag(`${count} entreprise(s)`, 'neutral'),
            ...(active > 0 ? [tag(`${active} en activité`, 'good')] : [tag('Aucune en activité', 'warn')]),
            ...(distinct > 1 ? [tag(`${distinct} dates de naissance`, 'warn')] : [])
        ],
        links: [
            ...links,
            {
                label: 'Annuaire des entreprises',
                href: `https://annuaire-entreprises.data.gouv.fr/rechercher?terme=${encodeURIComponent(name)}`
            }
        ],
        raw: JSON.stringify(pages, null, 2)
    };
}

/* --------------------------------- Pappers -------------------------------- */

interface PappersDirigeant {
    nom?: string;
    prenom?: string;
    nom_complet?: string;
    qualite?: string;
    entreprise?: {
        nom_entreprise?: string;
        siren?: string;
        siege?: { ville?: string; code_postal?: string };
        entreprise_cessee?: boolean;
        libelle_code_naf?: string;
    };
}

interface PappersResponse {
    resultats?: PappersDirigeant[];
    total?: number;
    error?: string;
    message?: string;
}

async function fromPappers(name: string, key: string): Promise<OsintProbeDraft> {
    // Le nom complet suffit : l'API découpe elle-même prénom et nom.
    const params = new URLSearchParams({
        api_token: key,
        q: name,
        precision: 'standard',
        bases: 'dirigeants',
        par_page: '20'
    });
    const data = await fetchJson<PappersResponse>(
        `https://api.pappers.fr/v2/recherche-dirigeants?${params.toString()}`
    );
    if (data.error) return { status: 'error', summary: data.message ?? data.error };

    const hits = data.resultats ?? [];
    if (hits.length === 0) {
        return { status: 'empty', summary: `Aucun mandat de dirigeant au nom de « ${name} » (Pappers).` };
    }

    const fields: OsintField[] = [];
    const links: OsintLink[] = [];
    let active = 0;

    for (const d of hits.slice(0, MAX_COMPANIES)) {
        const e = d.entreprise;
        if (!e) continue;
        const cessee = e.entreprise_cessee === true;
        if (!cessee) active++;

        const who = d.nom_complet ?? [d.prenom, d.nom].filter(Boolean).join(' ');
        const where = [e.siege?.code_postal, e.siege?.ville].filter(Boolean).join(' ');
        const parts = [d.qualite, where, e.libelle_code_naf, cessee ? 'cessée' : null].filter(Boolean);

        fields.push(field(e.nom_entreprise ?? e.siren ?? '?', `${who} : ${parts.join(', ')}`));
        if (e.siren) {
            links.push({
                label: `${e.nom_entreprise ?? e.siren} (SIREN ${e.siren})`,
                href: `https://www.pappers.fr/entreprise/${e.siren}`
            });
        }
    }

    const total = data.total ?? hits.length;
    return {
        summary: `${total} mandat(s) trouvé(s) par Pappers, dont ${active} sur une entreprise en activité.`,
        fields,
        tags: [
            tag(`${total} mandat(s)`, 'neutral'),
            ...(active > 0 ? [tag(`${active} en activité`, 'good')] : [tag('Aucun mandat actif', 'warn')])
        ],
        links,
        raw: JSON.stringify(data, null, 2)
    };
}

export const registryProbe: OsintProbeAdapter = {
    id: 'registry',
    appliesTo: ['person'],
    ttlMs: 6 * 60 * 60 * 1000,
    run({ target, key }) {
        return key ? fromPappers(target.value, key) : fromAnnuaire(target.value);
    }
};
