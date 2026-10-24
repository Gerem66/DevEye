import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import { openHit } from './_shared';
import type { ModerationRepo } from './repo';

/**
 * Les détections du compte (ce que la modération automatique a arrêté de ses
 * envois), ouvertes ici parce que leur contenu est scellé par la clé du
 * serveur sous un contexte que l'hôte ne connaît pas. Les règles sont celles
 * du service, pas d'un compte.
 */
export const moderationAccountExport: FeatureAccountExport<ModerationRepo> = {
    tables: {
        ft_moderation_rules: {
            skip: 'Les règles de la modération automatique (empreintes et noms interdits) sont celles du service, pas d’un compte.'
        },
        ft_moderation_hits: 'custom',
        ft_moderation_meta: { skip: 'L’état de la liste externe d’empreintes n’appartient à aucun compte.' }
    },
    async account(ctx) {
        const rows = await ctx.repo.listHitsOfUser(ctx.userId);
        if (rows.length === 0) return;
        await ctx.out.json(
            'detections.json',
            rows.map((row) => {
                const content = openHit(ctx.keys, row);
                return {
                    id: row.id,
                    feature: row.feature,
                    kind: row.kind,
                    reason: row.reason,
                    label: row.label,
                    name: content?.name ?? null,
                    context: content?.context ?? null,
                    sha256: row.sha256,
                    size: row.size === null ? null : Number(row.size),
                    workspace_id: row.workspace_id,
                    count: Number(row.count),
                    first_seen: new Date(Number(row.first_seen) * 1000).toISOString(),
                    last_seen: new Date(Number(row.last_seen) * 1000).toISOString()
                };
            })
        );
    }
};
