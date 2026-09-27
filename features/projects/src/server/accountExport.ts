import type { FeatureAccountExport } from '@deveye/types/sdk/server';

import type { ProjectsRepo } from './repo';

const OF_PROJECTS = 'project_id IN (SELECT id FROM projects WHERE workspace_id = ?)';

export const projectsAccountExport: FeatureAccountExport<ProjectsRepo> = {
    tables: {
        projects: {
            file: 'projets.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { start_date: 's', due_date: 's', archived_at: 's', created: 's', updated: 's' }
        },
        project_columns: {
            file: 'colonnes.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created: 's' }
        },
        project_milestones: {
            file: 'jalons.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { due_date: 's', reached_at: 's', created: 's' }
        },
        project_cards: {
            file: 'cartes.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: {
                start_date: 's',
                due_date: 's',
                archived_at: 's',
                last_message_at: 's',
                created: 's',
                updated: 's'
            }
        },
        project_card_deps: {
            file: 'dependances.json',
            where: OF_PROJECTS,
            key: ['card_id', 'blocked_by_card_id'],
            dates: { created: 's' }
        },
        project_card_reads: {
            skip: 'Le point de lecture de chacun dans les discussions des cartes ne sert qu’à l’affichage des messages non lus.'
        },
        project_messages: {
            file: 'messages.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content', 'mentions'],
            dates: { created: 's', edited: 's' }
        },
        project_events: {
            file: 'historique.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { created: 's' }
        },
        ft_projects_dashboard_tiles: {
            file: 'tableau-de-bord.json',
            where: 'workspace_id = ?',
            key: ['id'],
            sealed: ['content'],
            json: ['content'],
            dates: { last_check_at: 's', created: 's' }
        },
        // Le lien public tiré au hasard ouvre la page à qui le connaît.
        ft_projects_public: {
            file: 'pages-publiques.json',
            where: OF_PROJECTS,
            key: ['project_id'],
            dates: { published_at: 's', domain_at: 's', created: 's' },
            omit: ['public_ref']
        },
        project_repo_links: {
            file: 'liens-depots.json',
            where: 'workspace_id = ?',
            key: ['project_id'],
            dates: { created: 's' }
        },
        project_database_links: {
            file: 'liens-bases.json',
            where: 'workspace_id = ?',
            key: ['project_id', 'database_id'],
            dates: { created: 's' }
        },
        project_deploy_links: {
            file: 'liens-deploiements.json',
            where: 'workspace_id = ?',
            key: ['project_id', 'target_id'],
            dates: { created: 's' }
        },
        project_audience_links: {
            file: 'liens-audience.json',
            where: 'workspace_id = ?',
            key: ['project_id', 'site_id'],
            dates: { created: 's' }
        },
        project_uptime_links: {
            file: 'liens-uptime.json',
            where: 'workspace_id = ?',
            key: ['project_id', 'service_id'],
            dates: { created: 's' }
        }
    }
};
