import { fetchJson } from '../netFetch';
import { field, skipped, tag, type OsintProbeAdapter, type OsintLink } from './shared';

/**
 * Registre du commerce français, via Pappers.
 *
 * La seule sonde de la famille « personne » qui rende de la donnée *structurée*
 * plutôt que des liens : à partir d'un nom et d'un prénom, elle liste les
 * mandats de dirigeant et les entreprises rattachées. C'est de l'information
 * légalement publique — le RCS est ouvert par construction — et c'est
 * généralement le point de départ le plus productif sur une personne en France.
 *
 * Sans clé, la carte rend `skipped` avec le lien d'inscription : jamais une
 * erreur, puisque ne pas avoir de clé n'est pas une panne.
 */

interface PappersDirigeant {
    nom?: string;
    prenom?: string;
    nom_complet?: string;
    date_de_naissance?: string;
    qualite?: string;
    entreprise?: {
        nom_entreprise?: string;
        siren?: string;
        siege?: { ville?: string; code_postal?: string };
        date_creation?: string;
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

export const pappersProbe: OsintProbeAdapter = {
    id: 'pappers',
    appliesTo: ['person'],
    provider: 'pappers',
    requiresKey: true,
    ttlMs: 6 * 60 * 60 * 1000,
    async run({ target, key }) {
        if (!key) {
            return skipped(
                'Aucune clé Pappers enregistrée. Le registre du commerce français reste consultable à la main par les liens de la carte « Pivots ».',
                [{ label: 'Obtenir une clé Pappers (offre gratuite)', href: 'https://www.pappers.fr/api' }]
            );
        }

        // Le nom complet suffit : l'API découpe elle-même prénom et nom, et
        // deviner lequel est lequel se tromperait sur les noms composés.
        const params = new URLSearchParams({
            api_token: key,
            q: target.value,
            precision: 'standard',
            bases: 'dirigeants',
            par_page: '20'
        });

        const data = await fetchJson<PappersResponse>(
            `https://api.pappers.fr/v2/recherche-dirigeants?${params.toString()}`
        );

        if (data.error) {
            return { status: 'error', summary: data.message ?? data.error };
        }

        const hits = data.resultats ?? [];
        if (hits.length === 0) {
            return {
                status: 'empty',
                summary: `Aucun mandat de dirigeant au nom de « ${target.value} ».`
            };
        }

        const fields = [];
        const links: OsintLink[] = [];
        let active = 0;

        for (const d of hits.slice(0, 12)) {
            const e = d.entreprise;
            if (!e) continue;
            const cessee = e.entreprise_cessee === true;
            if (!cessee) active++;

            const who = d.nom_complet ?? [d.prenom, d.nom].filter(Boolean).join(' ');
            const where = [e.siege?.code_postal, e.siege?.ville].filter(Boolean).join(' ');
            const parts = [
                d.qualite,
                where ? `— ${where}` : null,
                e.libelle_code_naf ? `(${e.libelle_code_naf})` : null,
                cessee ? '— CESSÉE' : null
            ].filter(Boolean);

            fields.push(field(e.nom_entreprise ?? e.siren ?? '?', `${who} : ${parts.join(' ')}`.trim()));
            if (e.siren) {
                links.push({
                    label: `${e.nom_entreprise ?? e.siren} (SIREN ${e.siren})`,
                    href: `https://www.pappers.fr/entreprise/${e.siren}`
                });
            }
        }

        const total = data.total ?? hits.length;

        return {
            summary: `${total} mandat(s) trouvé(s), dont ${active} sur une entreprise en activité.`,
            fields,
            tags: [
                tag(`${total} mandat(s)`, 'neutral'),
                ...(active > 0 ? [tag(`${active} en activité`, 'good')] : [tag('Aucun mandat actif', 'warn')])
            ],
            links,
            raw: JSON.stringify(data, null, 2)
        };
    }
};
