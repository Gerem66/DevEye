import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { AudienceRepo } from './repo';

const OF_SITES = 'site_id IN (SELECT id FROM audience_sites WHERE workspace_id = ?)';
const OF_FORMS =
    'form_id IN (SELECT f.id FROM ft_audience_forms f JOIN audience_sites s ON s.id = f.site_id WHERE s.workspace_id = ?)';

export const audienceAccountExport: FeatureAccountExport<AudienceRepo> = {
    tables: {
        audience_sites: {
            file: 'sites.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { last_event_at: 's', created: 's' }
        },
        audience_labels: {
            file: 'libelles.json',
            where: OF_SITES,
            key: ['id'],
            sealed: ['content']
        },
        audience_sessions: {
            file: 'visites.json',
            where: OF_SITES,
            key: ['id'],
            dates: { started_at: 's', last_at: 's' }
        },
        audience_events: {
            file: 'evenements.json',
            where: OF_SITES,
            key: ['id'],
            dates: { ts: 's' }
        },
        audience_daily: {
            file: 'bilans-quotidiens.json',
            where: OF_SITES,
            key: ['site_id', 'day']
        },
        audience_funnels: {
            file: 'entonnoirs.json',
            where: OF_SITES,
            key: ['id'],
            sealed: ['content'],
            dates: { created: 's' }
        },
        audience_funnel_steps: {
            file: 'entonnoirs-etapes.json',
            where: OF_SITES,
            key: ['id'],
            sealed: ['content']
        },
        ft_audience_forms: {
            file: 'formulaires.json',
            where: OF_SITES,
            key: ['id'],
            sealed: ['content', 'form_schema'],
            json: ['form_schema'],
            dates: { closed_at: 's', last_at: 's', created: 's' }
        },
        ft_audience_form_labels: {
            file: 'libelles-formulaires.json',
            where: OF_FORMS,
            key: ['id'],
            sealed: ['content']
        },
        // `ip_ref` n'est que le condensé du jour qui borne les envois d'une même adresse.
        ft_audience_submissions: {
            file: 'reponses.json',
            where: OF_SITES,
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { ts: 's' },
            omit: ['ip_ref']
        },
        ft_audience_answers: {
            file: 'reponses-comptees.json',
            where: OF_FORMS,
            key: ['form_id', 'field_id', 'value_id']
        },
        ft_audience_usage: {
            file: 'consommation-mensuelle.json',
            where: 'workspace_id = ?',
            key: ['workspace_id', 'month']
        },
        ft_audience_bans: {
            skip: 'Les provenances écartées après une rafale de réponses sont une protection du service, qui expire d’elle-même.'
        }
    }
};
