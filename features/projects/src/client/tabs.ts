import type { FeatureAccess, FeatureId } from '@deveye/types';
import { HOSTING_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { Project, ProjectLinkCounts } from '../contracts/domain';

/**
 * Les onglets d'un projet : le Tableau, seul obligatoire et seul à ouvrir le
 * projet, la Vue d'ensemble et la Frise que le projet déclare, et six suspendus à
 * leurs liaisons, qui paraissent au premier élément et se replient dans le menu
 * « + » de la barre avec le dernier. L'histoire du projet est dans ses réglages :
 * on l'ouvre rarement, pour une question précise.
 */

/** Les onglets qui ne montrent que des liaisons, donc escamotables. */
export type ProjectFeatureTabId = 'git' | 'database' | 'audience' | 'deploy' | 'uptime' | 'x-hosting';

export type ProjectTabId = 'overview' | 'board' | 'timeline' | ProjectFeatureTabId;

/** La clé du geste d'ajout, qui dit à `AddFeatureDialog` quel dialogue monter. */
export type ProjectTabAddKey = ProjectFeatureTabId;

/** Ce qu'il faut savoir pour proposer un geste d'ajout dans le menu « + ». */
export interface ProjectTabAddAction {
    key: ProjectTabAddKey;
    /** L'intitulé du geste, repris mot pour mot du bouton qui fait la même chose dans l'onglet. */
    label: string;
    /**
     * Le droit d'espace que ce geste réclame en plus de `projects: write` : le
     * dialogue qui s'ouvre travaille dans la feature visée, sans quoi l'entrée
     * mène à un formulaire qu'on ne peut pas remplir.
     */
    requires: { feature: FeatureId; level: FeatureAccess };
    /** Un module privé : le geste n'est offert que si ce contrat client est installé. */
    provider?: string;
}

export interface ProjectTab {
    id: ProjectTabId;
    label: string;
    icon: string;
}

export interface ProjectFeatureTab extends ProjectTab {
    id: ProjectFeatureTabId;
    /** Le geste qui peuple cet onglet. */
    add: ProjectTabAddAction;
}

/** En tête quand le projet l'affiche : ses tuiles ne dépendent d'aucune liaison. */
const OVERVIEW: ProjectTab = { id: 'overview', label: 'Vue d’ensemble', icon: 'activity' };

/** Le seul qu'on ne retire pas : un projet sans tableau n'a plus de travail à montrer. */
const BOARD: ProjectTab = { id: 'board', label: 'Tableau', icon: 'projects' };

const TIMELINE: ProjectTab = { id: 'timeline', label: 'Frise', icon: 'clock' };

export const PROJECT_FEATURE_TABS: ProjectFeatureTab[] = [
    {
        id: 'git',
        label: 'Git',
        icon: 'branch',
        add: { key: 'git', label: 'Ajouter un dépôt', requires: { feature: 'git', level: 'write' } }
    },
    {
        id: 'database',
        label: 'Bases de données',
        icon: 'database',
        add: { key: 'database', label: 'Ajouter une base', requires: { feature: 'database', level: 'write' } }
    },
    {
        id: 'audience',
        label: 'Audience',
        icon: 'eye-open',
        add: { key: 'audience', label: 'Ajouter un site', requires: { feature: 'audience', level: 'write' } }
    },
    {
        id: 'deploy',
        label: 'Déploiements',
        icon: 'rocket',
        add: { key: 'deploy', label: 'Ajouter une cible', requires: { feature: 'deploy', level: 'write' } }
    },
    {
        id: 'uptime',
        label: 'Uptime',
        icon: 'uptime',
        add: { key: 'uptime', label: 'Ajouter un uptime', requires: { feature: 'uptime', level: 'write' } }
    },
    {
        id: 'x-hosting',
        label: 'Dossiers',
        icon: 'folder',
        add: {
            key: 'x-hosting',
            label: 'Ajouter un dossier',
            requires: { feature: 'x-hosting', level: 'write' },
            provider: HOSTING_CLIENT_PROVIDER
        }
    }
];

export const PROJECT_TABS: ProjectTab[] = [OVERVIEW, BOARD, TIMELINE, ...PROJECT_FEATURE_TABS];

export function isProjectFeatureTabId(value: ProjectTabId): value is ProjectFeatureTabId {
    return PROJECT_FEATURE_TABS.some((tab) => tab.id === value);
}

export function isProjectTabId(value: string): value is ProjectTabId {
    return PROJECT_TABS.some((tab) => tab.id === value);
}

/** Le projet s'ouvre sur son tableau, quels que soient ses autres onglets. */
export const LANDING_TAB: ProjectTabId = 'board';

/**
 * `null` = compteurs pas encore connus, on ne montre que ce que le projet
 * déclare. Tout afficher puis retirer ferait bouger la barre sous le curseur au
 * chargement.
 */
export function visibleProjectTabs(counts: ProjectLinkCounts | null, project: Project): ProjectTab[] {
    const leading = [...(project.showOverview ? [OVERVIEW] : []), BOARD, ...(project.showTimeline ? [TIMELINE] : [])];
    if (counts === null) return leading;
    return [...leading, ...PROJECT_FEATURE_TABS.filter((tab) => counts[tab.id] > 0)];
}
