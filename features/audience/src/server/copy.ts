import type { FeatureItemsCopy, ItemTree } from '@deveye/types/sdk/server';

import type { AudienceRepo } from './repo';
import { generatePublicKey } from './_shared';

/**
 * Ce dont un site suivi est fait : sa ligne, ses entonnoirs, ses formulaires, et
 * ce que la collecte a amassé. C'est la liste que le déplacement rescelle et que
 * la copie emporte.
 *
 * ⚠️ À tenir à jour : toute nouvelle colonne chiffrée suspendue à un site doit y
 * figurer (`sealed`), sinon un déplacement la laisse sous l'ancienne clé, où
 * elle devient illisible, et une copie l'emporte sous une clé que la destination
 * n'a pas. Rien ne peut le détecter, un blob chiffré est indistinguable d'un
 * autre.
 */
export const audienceTree: ItemTree = [
    {
        table: 'audience_sites',
        idColumn: 'id',
        ownerColumn: 'id',
        workspaceColumn: 'workspace_id',
        orderColumn: 'sort_order',
        unique: { column: 'name_ref', message: 'Un site du même nom existe déjà dans cet espace.' },
        sealed: ['content'],
        omit: ['last_event_at', 'created']
    },
    { table: 'audience_funnels', idColumn: 'id', ownerColumn: 'site_id', sealed: ['content'], omit: ['created'] },
    {
        table: 'audience_funnel_steps',
        idColumn: 'id',
        ownerColumn: 'site_id',
        refs: { funnel_id: 'audience_funnels' },
        sealed: ['content']
    },
    {
        table: 'ft_audience_forms',
        idColumn: 'id',
        ownerColumn: 'site_id',
        // `form_schema` porte les questions déclarées, chiffrées : sans lui dans
        // `sealed`, un déplacement les laisse sous l'ancienne clé et le formulaire
        // strict refuse alors tout envoi, sans rien signaler.
        sealed: ['content', 'form_schema'],
        // Ce que le formulaire a reçu reste avec les réponses, là où elles sont.
        omit: ['submissions', 'last_at', 'created']
    },
    // Ce que la collecte a amassé ne se copie pas : la copie est un autre site,
    // qui aura ses propres visiteurs.
    { table: 'audience_labels', idColumn: 'id', ownerColumn: 'site_id', sealed: ['content'], cache: true },
    { table: 'ft_audience_submissions', idColumn: 'id', ownerColumn: 'site_id', sealed: ['content'], cache: true },
    // Les libellés d'un formulaire pendent au formulaire et non au site : c'est le
    // seul niveau où le propriétaire n'est pas la colonne `site_id`.
    {
        table: 'ft_audience_form_labels',
        idColumn: 'id',
        ownerColumn: 'form_id',
        ownerScope: 'SELECT id FROM ft_audience_forms WHERE site_id = ?',
        sealed: ['content'],
        cache: true
    }
];

export const audienceCopy: FeatureItemsCopy<AudienceRepo> = {
    tree: audienceTree,
    async plan() {
        return {
            blockers: [],
            drops: [
                'Ses visites, ses réponses de formulaires et ses statistiques',
                'Sa clé de suivi : la copie en reçoit une neuve, à poser sur le site qu’elle suivra'
            ]
        };
    },
    async admit({ repo, quota, rows }) {
        await quota.assert('sites', async (owned) => (await repo.countInWorkspaces(owned)) + 1);
        // La clé publique désigne UN site, partout : deux sites sous la même
        // mêleraient leurs visites.
        for (const site of rows.audience_sites ?? []) site.public_key = generatePublicKey();
    }
};
