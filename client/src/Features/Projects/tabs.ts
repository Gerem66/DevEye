import type { FeatureAccess, ProjectLinkCounts, WorkspaceFeatureId } from 'deveye-types';

/**
 * Les onglets d'un projet, et la règle qui décide lesquels s'affichent.
 *
 * **Trois onglets permanents, quatre à la demande.** Le tableau, la frise et
 * l'historique parlent du travail : ils existent dès le premier jour et n'ont
 * rien à attendre. Les quatre autres ne montrent que des *liaisons* vers des
 * objets d'espace (voir PROJECTS.md) ; tant qu'un projet n'en a aucune, ils
 * n'affichaient qu'une phrase disant qu'il n'y a rien — quatre fois de suite.
 * Ils ne paraissent donc qu'à partir du premier élément, et se replient dans le
 * menu « + » de la barre dès que le dernier est retiré.
 *
 * L'ordre ne se choisit pas onglet par onglet : les features s'insèrent en bloc
 * entre la frise et l'historique, ce dernier restant en bout de barre — on
 * l'ouvre rarement, et pour une question précise.
 */

/** Les onglets qui ne montrent que des liaisons, donc escamotables. */
export type ProjectFeatureTabId = 'git' | 'database' | 'audience' | 'deploy';

export type ProjectTabId = 'board' | 'timeline' | ProjectFeatureTabId | 'history';

/**
 * Une clé par geste d'ajout, unique sur l'ensemble des onglets — pas une par
 * onglet : Déploiement en porte deux (une cible, un uptime), les trois autres
 * n'en portent qu'un, mais tous se distinguent par la même sorte de clé. C'est
 * elle qui dit à `AddFeatureDialog` quel dialogue monter.
 */
export type ProjectTabAddKey = 'git' | 'database' | 'audience' | 'deploy' | 'uptime';

/** Ce qu'il faut savoir pour proposer un geste d'ajout dans le menu « + ». */
export interface ProjectTabAddAction {
    key: ProjectTabAddKey;
    /**
     * L'intitulé du geste, repris mot pour mot du bouton qui fait la même
     * chose dans l'onglet : le menu ne fait rien d'autre que l'appuyer à sa
     * place, et deux formulations pour un même geste laisseraient croire à
     * deux gestes.
     */
    label: string;
    /** L'icône de la ligne, quand elle diffère de celle de l'onglet — le cas
     *  d'un onglet à plusieurs gestes, où l'icône est ce qui les distingue au
     *  premier coup d'œil. */
    icon?: string;
    /**
     * Le droit d'espace que ce geste réclame **en plus** de `projects: write`.
     *
     * Ajouter une liaison touche au projet, mais le dialogue qui s'ouvre lit —
     * et parfois écrit — dans la feature visée. Sans ce droit-là, l'entrée mène
     * à un formulaire qu'on ne peut pas remplir : autant ne pas la proposer.
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
    /**
     * Les gestes qui peuplent cet onglet. Presque toujours un seul ; le
     * Déploiement en porte deux, car il montre deux choses (voir
     * `UptimeLinks`) et le menu « + » n'a rien d'autre pour les proposer tant
     * que l'onglet lui-même n'existe pas encore.
     */
    add: ProjectTabAddAction[];
}

/** Avant les features : le travail lui-même. */
const LEADING: ProjectTab[] = [
    { id: 'board', label: 'Tableau', icon: 'projects' },
    { id: 'timeline', label: 'Frise', icon: 'clock' }
];

/** Après elles, et dernier : discret, on l'ouvre pour une question précise. */
const TRAILING: ProjectTab[] = [{ id: 'history', label: 'Historique', icon: 'archive' }];

/**
 * Les quatre onglets suspendus à leur contenu.
 *
 * `requires` suit ce que le dialogue d'ajout fait vraiment, et tous exigent
 * l'**écriture** sur la feature visée : les dialogues peuvent créer l'objet en
 * plus de le relier, et pas seulement le choisir.
 *
 * Le déploiement a longtemps fait exception, en réclamant `git: read` — le temps
 * où la clé Dokploy vivait dans la feature Git, faute de module pour
 * l'accueillir. Il a le sien depuis la migration 080, et l'anomalie est partie
 * avec sa cause.
 */
export const PROJECT_FEATURE_TABS: ProjectFeatureTab[] = [
    {
        id: 'git',
        label: 'Git',
        icon: 'branch',
        add: [{ key: 'git', label: 'Ajouter un dépôt', requires: { feature: 'git', level: 'write' } }]
    },
    {
        id: 'database',
        label: 'Bases de données',
        icon: 'database',
        add: [{ key: 'database', label: 'Ajouter une base', requires: { feature: 'database', level: 'write' } }]
    },
    {
        id: 'audience',
        label: 'Audience',
        icon: 'eye-open',
        add: [{ key: 'audience', label: 'Ajouter un site', requires: { feature: 'audience', level: 'write' } }]
    },
    {
        id: 'deploy',
        label: 'Déploiement',
        icon: 'rocket',
        // Deux gestes, car l'onglet montre deux choses : les cibles de
        // déploiement et les services surveillés (voir `UptimeLinks`). Il
        // paraît dès que l'un des deux existe (project.linkCounts en somme
        // déjà les deux) ; tant qu'aucun n'existe, le « + » doit donc pouvoir
        // lancer l'un ou l'autre.
        add: [
            { key: 'deploy', label: 'Ajouter une cible', requires: { feature: 'deploy', level: 'write' } },
            {
                key: 'uptime',
                label: 'Ajouter un uptime',
                icon: 'uptime',
                requires: { feature: 'uptime', level: 'write' }
            }
        ]
    }
];

/** Tous les onglets existants, dans leur ordre d'affichage. */
export const PROJECT_TABS: ProjectTab[] = [...LEADING, ...PROJECT_FEATURE_TABS, ...TRAILING];

export function isProjectTabId(value: string): value is ProjectTabId {
    return PROJECT_TABS.some((tab) => tab.id === value);
}

/**
 * La barre telle qu'elle doit se dessiner pour ces compteurs.
 *
 * `null` = compteurs pas encore connus : on ne montre que les permanents. Faire
 * l'inverse — tout afficher puis retirer — donnerait une barre qui bouge sous le
 * curseur au chargement de chaque projet.
 */
export function visibleProjectTabs(counts: ProjectLinkCounts | null): ProjectTab[] {
    if (counts === null) return [...LEADING, ...TRAILING];
    return [...LEADING, ...PROJECT_FEATURE_TABS.filter((tab) => counts[tab.id] > 0), ...TRAILING];
}
