import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { UptimeRepo } from './repo';

const OF_SERVICES = 'service_id IN (SELECT id FROM uptime_services WHERE workspace_id = ?)';

export const uptimeAccountExport: FeatureAccountExport<UptimeRepo> = {
    tables: {
        uptime_services: {
            file: 'services.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content', 'last_error', 'baseline_enc'],
            json: ['content', 'baseline_enc'],
            dates: { last_checked_at: 's', created: 's' }
        },
        uptime_checks: {
            file: 'controles.json',
            where: OF_SERVICES,
            key: ['id'],
            sealed: ['error'],
            dates: { checked_at: 's' }
        },
        uptime_daily: {
            file: 'bilans-quotidiens.json',
            where: OF_SERVICES,
            key: ['service_id', 'day'],
            dates: { day: 's' }
        },
        uptime_incidents: {
            file: 'incidents.json',
            where: OF_SERVICES,
            key: ['id'],
            sealed: ['error'],
            dates: { started_at: 's', ended_at: 's' }
        },
        // Le lien public tiré au hasard ouvre la page à qui le connaît.
        ft_uptime_pages: {
            file: 'pages-de-statut.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created: 's' },
            omit: ['public_ref']
        },
        ft_uptime_page_services: {
            file: 'pages-de-statut-services.json',
            where: 'page_id IN (SELECT id FROM ft_uptime_pages WHERE workspace_id = ?)',
            key: ['page_id', 'service_id'],
            sealed: ['label']
        }
    }
};
