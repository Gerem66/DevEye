import type { FeatureAccess, WorkspaceFeatureId } from '@deveye/types';
import type { ProjectLinkCounts } from '../contracts/domain';

/**
 * Les onglets d'un projet : quatre permanents (vue d'ensemble, tableau, frise,
 * historique) et cinq suspendus à leurs liaisons, qui paraissent au premier
 * élément et se replient dans le menu « + » de la barre avec le dernier.
 */

/** Les onglets qui ne montrent que des liaisons, donc escamotables. */
export type ProjectFeatureTabId = 'git' | 'database' | 'audience' | 'deploy' | 'uptime';

export type ProjectTabId = 'overview' | 'board' | 'timeline' | ProjectFeatureTabId | 'history';

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
    requires: { feature: WorkspaceFeatureId; level: FeatureAccess };
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

const LEADING: ProjectTab[] = [
    // En tête et jamais escamotable : c'est l'onglet d'arrivée, et ses tuiles de
    // tâches ne dépendent d'aucune liaison.
    { id: 'overview', label: 'Vue d’ensemble', icon: 'activity' },
    { id: 'board', label: 'Tableau', icon: 'projects' },
    { id: 'timeline', label: 'Frise', icon: 'clock' }
];

const TRAILING: ProjectTab[] = [{ id: 'history', label: 'Historique', icon: 'archive' }];

/**
 * Les cinq onglets suspendus à leur contenu. Tous exigent l'écriture sur la
 * feature visée : leurs dialogues peuvent créer l'objet en plus de le relier.
 */
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
    }
];

export const PROJECT_TABS: ProjectTab[] = [...LEADING, ...PROJECT_FEATURE_TABS, ...TRAILING];

export function isProjectTabId(value: string): value is ProjectTabId {
    return PROJECT_TABS.some((tab) => tab.id === value);
}

/**
 * `null` = compteurs pas encore connus, on ne montre que les permanents. Tout
 * afficher puis retirer ferait bouger la barre sous le curseur au chargement.
 */
export function visibleProjectTabs(counts: ProjectLinkCounts | null): ProjectTab[] {
    if (counts === null) return [...LEADING, ...TRAILING];
    return [...LEADING, ...PROJECT_FEATURE_TABS.filter((tab) => counts[tab.id] > 0), ...TRAILING];
}
