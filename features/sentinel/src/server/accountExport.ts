import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { SentinelRepo } from './repo';

const OF_DEVICES = 'device_id IN (SELECT id FROM devices WHERE workspace_id = ?)';

/** Les condensés tus ne sont que des clés d'unicité, tirées de la règle et du sujet exportés à côté. */
export const sentinelAccountExport: FeatureAccountExport<SentinelRepo> = {
    tables: {
        device_findings: {
            file: 'constats.json',
            where: OF_DEVICES,
            key: ['id'],
            json: ['evidence'],
            dates: { snapshot_ts: 'ms', first_seen: 'ms', last_seen: 'ms', acked_at: 'ms' },
            omit: ['dedup_hash']
        },
        sentinel_allowlist: {
            file: 'autorisations.json',
            where: 'workspace_id = ?',
            key: ['id'],
            dates: { created: 's' },
            omit: ['subject_hash']
        },
        ft_sentinel_device_config: {
            file: 'reglages-appareils.json',
            where: OF_DEVICES,
            key: ['device_id'],
            dates: { learning_until: 'ms', last_integrity_at: 'ms' }
        },
        device_baseline: {
            skip: 'La ligne de base de chaque appareil est apprise de ce qu’il rapporte, et se réapprend.'
        }
    }
};
