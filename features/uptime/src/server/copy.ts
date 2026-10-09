import type { FeatureItemsCopy, ItemTree } from '@deveye/types/sdk/server';

import type { UptimeRepo } from './repo';

/**
 * Ce dont un service est fait : sa ligne, et l'historique qui pend à lui. C'est
 * la liste que le déplacement rescelle et que la copie emporte.
 *
 * ⚠️ À tenir à jour : toute nouvelle colonne chiffrée suspendue à un service
 * doit y figurer (`sealed`), sinon un déplacement la laisse sous l'ancienne clé,
 * où elle devient illisible. Rien ne peut le détecter, un blob chiffré est
 * indistinguable d'un autre. `uptime_daily` n'y est pas : elle n'agrège que des
 * nombres. `ft_uptime_page_services.label` non plus : il appartient à la page,
 * qui reste dans son espace, et le déplacement retire le service de ses pages.
 */
export const uptimeTree: ItemTree = [
    {
        table: 'uptime_services',
        idColumn: 'id',
        ownerColumn: 'id',
        workspaceColumn: 'workspace_id',
        userColumn: 'user_id',
        orderColumn: 'sort_order',
        sealed: ['content', 'last_error', 'baseline_enc', 'integrity_verdict', 'deploy_hook_enc'],
        // L'état appartient à ce que CE serveur a mesuré : la copie repart
        // de zéro et se fait sa propre idée. L'adresse d'appel est celle de
        // l'original : deux services ne partagent pas un jeton.
        omit: [
            'status',
            'consecutive_failures',
            'last_checked_at',
            'last_response_ms',
            'last_http_status',
            'last_error',
            'integrity_checked_at',
            'integrity_failures',
            'integrity_verdict',
            'integrity_pending_since',
            'deploy_hook_hash',
            'deploy_hook_enc',
            'deploy_hook_at',
            'created'
        ]
    },
    { table: 'uptime_checks', idColumn: 'id', ownerColumn: 'service_id', sealed: ['error'], cache: true },
    { table: 'uptime_incidents', idColumn: 'id', ownerColumn: 'service_id', sealed: ['error'], cache: true },
    {
        table: 'ft_uptime_integrity_readings',
        idColumn: 'id',
        ownerColumn: 'service_id',
        sealed: ['detail'],
        cache: true
    }
];

export const uptimeCopy: FeatureItemsCopy<UptimeRepo> = {
    tree: uptimeTree,
    async plan() {
        return {
            blockers: [],
            drops: [
                'Son historique de contrôles, d’incidents et de lectures des fichiers : la copie repart de zéro',
                'Ses sources de déploiement et son adresse d’appel : elles se choisissent de nouveau sur la copie'
            ]
        };
    },
    async admit({ repo, quota }) {
        await quota.assert('monitors', async (owned) => (await repo.services.countInWorkspaces(owned)) + 1);
    }
};
