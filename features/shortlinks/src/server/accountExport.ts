import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { ShortlinksRepo } from './repo';

const OF_LINKS = 'link_id IN (SELECT id FROM ft_shortlinks_links WHERE workspace_id = ?)';

/**
 * Les liens, leurs réglages et leurs chiffres, sans mot de passe. Les
 * empreintes du jour ne sortent pas, et les signalements restent au service :
 * ils portent l'identité de tiers.
 */
export const shortlinksAccountExport: FeatureAccountExport<ShortlinksRepo> = {
    tables: {
        ft_shortlinks_links: {
            file: 'liens.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: {
                expires_at: 's',
                blocked_at: 's',
                checked_at: 's',
                check_due: 's',
                created: 's',
                updated: 's'
            },
            omit: ['password_hash']
        },
        ft_shortlinks_daily: { file: 'chiffres-par-jour.json', where: OF_LINKS, key: ['link_id', 'day'] },
        ft_shortlinks_dims: {
            file: 'provenance-par-jour.json',
            where: OF_LINKS,
            key: ['link_id', 'day', 'kind', 'value']
        },
        ft_shortlinks_labels: {
            file: 'sites-d-origine.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            omit: ['label_ref']
        },
        ft_shortlinks_usage: {
            file: 'visites-par-mois.json',
            where: 'workspace_id = ?',
            key: ['workspace_id', 'month']
        },
        ft_shortlinks_seen: {
            skip: 'Les empreintes du jour qui servent à compter chaque personne une fois ne durent qu’une journée : elles ne disent rien d’utile une fois sorties.'
        },
        ft_shortlinks_reports: {
            skip: 'Les signalements reçus sur vos liens relèvent de la modération du service : ils portent l’identité des personnes qui les ont faits.'
        }
    }
};
