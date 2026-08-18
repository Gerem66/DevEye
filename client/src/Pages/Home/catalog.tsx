import type { ComponentType } from 'react';
import type { HomeFeatureId, WorkspaceKind } from 'deveye-types';

import { MonitoringWidget } from '@/Features/Monitoring';
import { WeatherWidget } from '@/Features/Weather';
import { NotesWidget } from '@/Features/Notes/NotesWidget';
import { PasswordWidget } from '@/Features/Password/PasswordWidget';
import { CloudSyncWidget } from '@/Features/CloudSync';
import { UptimeWidget } from '@/Features/Uptime/UptimeWidget';
import { SentinelWidget } from '@/Features/Sentinel/SentinelWidget';
import { MailWidget } from '@/Features/Mail/MailWidget';
import { ProjectsWidget } from '@/Features/Projects/ProjectsWidget';
import { GitWidget } from '@/Features/Git/GitWidget';
import { DeployWidget } from '@/Features/Deploy/DeployWidget';
import { DatabaseWidget } from '@/Features/Database/DatabaseWidget';
import { FinanceWidget } from '@/Features/Finance/FinanceWidget';
import { AudienceWidget } from '@/Features/Audience/AudienceWidget';
import { OsintWidget } from '@/Features/Osint/OsintWidget';

import Monitoring from '@/Features/Monitoring';
import Weather from '@/Features/Weather';
import FeaturePassword from '@/Features/Password';
import FeatureNotes from '@/Features/Notes';
import CloudSync from '@/Features/CloudSync';
import Uptime from '@/Features/Uptime';
import Sentinel from '@/Features/Sentinel';
import Mail from '@/Features/Mail';
import FeatureProjects from '@/Features/Projects';
import FeatureGit from '@/Features/Git';
import FeatureDeploy from '@/Features/Deploy';
import FeatureDatabase from '@/Features/Database';
import FeatureFinance from '@/Features/Finance';
import FeatureAudience from '@/Features/Audience';
import FeatureOsint from '@/Features/Osint';

import type { FeatureProps } from '@/Features/types';

/**
 * Le rayon du marché où la fonctionnalité est rangée.
 *
 * Un seul rangement, porté par l'entrée elle-même : c'est ce qui fait que le
 * sélecteur d'ajout et la fiche « À propos » racontent la même chose sans table
 * de correspondance à tenir à jour à côté.
 */
export type FeatureCategory = 'supervision' | 'security' | 'dev' | 'work' | 'daily' | 'analysis';

export const FEATURE_CATEGORY_LABEL: Record<FeatureCategory, string> = {
    supervision: 'Supervision',
    security: 'Sécurité',
    dev: 'Développement',
    work: 'Travail',
    daily: 'Quotidien',
    analysis: 'Analyse'
};

export const FEATURE_CATEGORY_ICON: Record<FeatureCategory, string> = {
    supervision: 'activity',
    security: 'shield',
    dev: 'branch',
    work: 'projects',
    daily: 'notes',
    analysis: 'finance'
};

/** L'ordre des rayons, du plus structurant au plus périphérique. */
export const FEATURE_CATEGORIES: FeatureCategory[] = ['work', 'dev', 'supervision', 'security', 'analysis', 'daily'];

/**
 * Ce qui relie une fonctionnalité à une autre.
 *
 * Une vraie liaison de données, pas un voisinage thématique : un projet pointe
 * ses dépôts, ses bases, ses cibles de déploiement ; un émetteur d'alertes
 * passe par un compte Mail. C'est ce que la fiche « À propos » donne à lire,
 * pour qu'on sache avant d'ajouter une carte ce qu'elle va pouvoir raccrocher.
 */
export interface FeatureLink {
    to: HomeFeatureId;
    /** Ce que la liaison permet, dit du point de vue de la feature qui la porte. */
    what: string;
}

/**
 * Static catalog of the built-in feature widgets that can live on the home grid.
 * The grid itself is composed from the user's saved layout (see `stores/homeLayout`);
 * this is the source of truth for what each feature *is* (its card content, full
 * view, cache policy, rayon, liaisons) and is also what the add "marché" lists.
 */
export interface FeatureCatalogEntry {
    id: HomeFeatureId;
    title: string;
    icon: string;
    /** Une phrase : ce que la fonctionnalité fait. Sert le marché et l'« À propos ». */
    description: string;
    /** Son rayon dans le marché d'ajout. */
    category: FeatureCategory;
    /** Ce qu'elle relie ailleurs dans DevEye, quand elle relie quelque chose. */
    links?: readonly FeatureLink[];
    /** Compact card body shown on the grid. */
    WidgetContent: ComponentType;
    /** Full view opened in the popup. */
    FullComponent: ComponentType<FeatureProps>;
    /** Minutes the view stays mounted after its popup closes (see Home). */
    cacheDurationMinutes?: number;
    /** Warm this view at idle after load so the first open is instant. */
    preload?: boolean;
    /**
     * Reads/writes password-encrypted data: hold the DEK alive while the view is
     * open so a long edit never trips the re-validation prompt (see WidgetPopup's
     * `holdSecrecy`). Left unset for non-encrypted views (monitoring, weather).
     */
    holdSecrecy?: boolean;
    /**
     * Réservée à l'administrateur global, et à son espace **personnel** seul.
     *
     * Pas un droit d'espace : aucun rôle ne l'accorde et aucun espace partagé ne
     * la propose. La carte porte alors le bouclier des entrées d'administration
     * de la topbar, pour que la restriction se voie sans avoir à cliquer.
     */
    adminOnly?: true;
}

export const FEATURE_CATALOG: FeatureCatalogEntry[] = [
    {
        id: 'monitoring',
        title: 'Monitoring',
        icon: 'activity',
        description: 'Supervision en direct de vos machines : charge, mémoire, disques, journaux, terminal.',
        category: 'supervision',
        WidgetContent: MonitoringWidget,
        FullComponent: Monitoring,
        cacheDurationMinutes: 5,
        preload: true,
        adminOnly: true
    },
    {
        id: 'weather',
        title: 'Météo',
        icon: 'cloud',
        description: 'Conditions et prévisions des villes que vous suivez.',
        category: 'daily',
        WidgetContent: WeatherWidget,
        FullComponent: Weather,
        cacheDurationMinutes: 60,
        preload: true
    },
    {
        id: 'password',
        title: 'Mot de passe',
        icon: 'lock',
        description: 'Coffre de mots de passe, chiffré par votre mot de passe maître.',
        category: 'security',
        WidgetContent: PasswordWidget,
        FullComponent: FeaturePassword,
        cacheDurationMinutes: 0,
        holdSecrecy: true
    },
    {
        id: 'notes',
        title: 'Notes',
        icon: 'notes',
        description: 'Notes et documents chiffrés, rangés en dossiers.',
        category: 'daily',
        WidgetContent: NotesWidget,
        FullComponent: FeatureNotes,
        cacheDurationMinutes: 0,
        holdSecrecy: true
    },
    {
        id: 'uptime',
        title: 'Uptime',
        icon: 'uptime',
        description: 'Disponibilité de vos services : sondes, incidents, historique.',
        category: 'supervision',
        links: [{ to: 'mail', what: 'envoie ses alertes par un compte Mail' }],
        WidgetContent: UptimeWidget,
        FullComponent: Uptime,
        // Unmounted as soon as it closes: the panel polls while it lives, and a
        // cached (or preloaded) instance would keep querying unseen. The home
        // card and navbar widget stay live through the shared count store.
        cacheDurationMinutes: 0
    },
    {
        id: 'sentinel',
        title: 'Sentinelle',
        icon: 'shield',
        description: "Détection d'anomalies sur vos appareils : constats, posture, acquittement.",
        category: 'security',
        links: [{ to: 'mail', what: 'envoie ses alertes par un compte Mail' }],
        WidgetContent: SentinelWidget,
        FullComponent: Sentinel,
        // Démontée à la fermeture : la vue relit constats et posture à
        // l'ouverture, et une instance en cache resterait branchée sur le sujet
        // `sentinel` sans que personne la regarde. La carte de l'accueil reste
        // vivante par le compteur partagé, comme celle d'Uptime.
        cacheDurationMinutes: 0
    },
    {
        id: 'cloudsync',
        title: 'CloudSync',
        icon: 'cloud',
        description: 'Synchronisation de dossiers entre vos appareils et votre espace.',
        category: 'work',
        WidgetContent: CloudSyncWidget,
        FullComponent: CloudSync,
        cacheDurationMinutes: 5
    },
    {
        id: 'projects',
        title: 'Projets',
        icon: 'projects',
        description: "Pilotage du travail : tableau, jalons, tâches, discussions. C'est là que le reste se raccroche.",
        category: 'work',
        links: [
            { to: 'git', what: 'suit les dépôts du projet' },
            { to: 'deploy', what: 'suit ses cibles de mise en production' },
            { to: 'database', what: "suit les bases qu'il utilise" },
            { to: 'audience', what: "suit les sites qu'il produit" },
            { to: 'uptime', what: "suit les services qu'il fait tourner" }
        ],
        WidgetContent: ProjectsWidget,
        FullComponent: FeatureProjects,
        // Démonté dès la fermeture, comme Mail et Uptime : le portefeuille, les
        // fils de discussion et la présence vivent en direct, une instance en
        // cache continuerait de travailler sans être vue.
        cacheDurationMinutes: 0,
        holdSecrecy: true
    },
    {
        id: 'git',
        title: 'Git',
        icon: 'branch',
        description: 'Vos dépôts : branches, commits, pull requests, releases.',
        category: 'dev',
        WidgetContent: GitWidget,
        FullComponent: FeatureGit,
        // Démonté dès la fermeture : la vue d'un dépôt sonde l'avancement d'une
        // synchronisation en cours, et une instance en cache continuerait de
        // sonder sans être vue. Pas de `holdSecrecy` : rien n'y est chiffré à
        // l'étage gardé, donc rien ne peut déclencher l'invite.
        cacheDurationMinutes: 0
    },
    {
        id: 'deploy',
        title: 'Déploiements',
        icon: 'rocket',
        description: 'Cibles de déploiement et mises en production, avec leur historique.',
        category: 'dev',
        links: [{ to: 'mail', what: 'envoie ses alertes par un compte Mail' }],
        WidgetContent: DeployWidget,
        FullComponent: FeatureDeploy,
        // Démonté dès la fermeture, comme Git : la fiche d'une cible suit l'état
        // d'un déploiement en vol, et une instance en cache continuerait de le
        // suivre sans être vue. Pas de `holdSecrecy` : rien n'y est chiffré à
        // l'étage gardé, donc rien ne peut déclencher l'invite.
        cacheDurationMinutes: 0
    },
    {
        id: 'database',
        title: 'Bases de données',
        icon: 'database',
        description: 'Exploration et supervision de vos bases de données.',
        category: 'dev',
        links: [{ to: 'mail', what: 'envoie ses alertes par un compte Mail' }],
        WidgetContent: DatabaseWidget,
        FullComponent: FeatureDatabase,
        // Démonté dès la fermeture, comme Git : l'explorateur de tables tient
        // des résultats lus chez un serveur tiers, qui n'ont aucune raison de
        // survivre à la fermeture de l'écran. Pas de `holdSecrecy` : rien n'y
        // est chiffré à l'étage gardé.
        cacheDurationMinutes: 0
    },
    {
        id: 'finance',
        title: 'Finances',
        icon: 'finance',
        description: "Le grand livre de l'espace : comptes, opérations, budgets, échéances.",
        category: 'analysis',
        WidgetContent: FinanceWidget,
        FullComponent: FeatureFinance,
        // Démonté dès la fermeture, comme le journal des bases : le journal des
        // opérations tient une page bornée par une période et des filtres qui
        // n'ont aucune raison de survivre à la fermeture de l'écran, et les
        // soldes d'une instance en cache auraient vieilli en silence. Pas de
        // `holdSecrecy` : rien n'y est chiffré à l'étage gardé, donc rien ne
        // peut déclencher l'invite de mot de passe.
        cacheDurationMinutes: 0
    },
    {
        id: 'audience',
        title: 'Audience',
        // `eye-open` et non `activity` : ce dernier appartient déjà à
        // Monitoring, et deux tuiles voisines qui portent le même pictogramme
        // ne se distinguent plus au coup d'œil — ce qui est précisément ce
        // qu'on demande à une grille d'icônes. L'œil dit « des vues », là où la
        // courbe d'activité dit « une machine qui tourne ».
        icon: 'eye-open',
        description: 'Usage des sites que vous livrez : visites, parcours, conversions.',
        category: 'analysis',
        WidgetContent: AudienceWidget,
        FullComponent: FeatureAudience,
        // Démonté dès la fermeture, comme Git et les bases : la fiche tient des
        // agrégats bornés par une fenêtre de temps, qui auraient vieilli en
        // silence dans une instance mise en cache. Pas de `holdSecrecy` : rien
        // n'y est chiffré à l'étage gardé, donc rien ne peut ouvrir l'invite.
        cacheDurationMinutes: 0
    },
    {
        id: 'osint',
        title: 'OSINT',
        icon: 'search',
        description: 'Recherche en sources ouvertes, avec un historique chiffré.',
        category: 'security',
        WidgetContent: OsintWidget,
        FullComponent: FeatureOsint,
        // Démonté dès la fermeture, comme Git et Database : les cartes tiennent
        // des résultats lus chez des tiers, qui n'ont aucune raison de survivre
        // à la fermeture de l'écran — le cache TTL du serveur les resert de
        // toute façon instantanément si on rouvre.
        cacheDurationMinutes: 0,
        // L'historique est chiffré par mot de passe : garder la DEK vivante
        // pendant que l'écran est ouvert évite l'invite au milieu d'une session
        // de recherche.
        holdSecrecy: true
    },
    {
        id: 'mail',
        title: 'Mail',
        icon: 'mail',
        description: 'Vos boîtes de réception, et le canal par lequel les autres fonctionnalités alertent.',
        category: 'work',
        WidgetContent: MailWidget,
        FullComponent: Mail,
        // Unmounted as soon as it closes, like Uptime: folders/messages are
        // fetched live and would go stale sitting in a cached instance.
        cacheDurationMinutes: 0,
        holdSecrecy: true
    }
];

export function featureCatalogEntry(id: HomeFeatureId): FeatureCatalogEntry | undefined {
    return FEATURE_CATALOG.find((f) => f.id === id);
}

/**
 * Qui regarde, et depuis quel genre d'espace.
 *
 * ⚠️ **`HomeAudience`, et non `Audience`** : depuis la feature du même nom, ce
 * mot désigne ailleurs dans le dépôt les visiteurs d'un site suivi. Deux sens à
 * quelques lignes d'écart — `FEATURE_CATALOG` porte les deux — sont le genre de
 * collision que rien ne signale et qu'on paye six mois plus tard.
 */
export interface HomeAudience {
    kind: WorkspaceKind | undefined;
    isAdmin: boolean;
}

/**
 * Les widgets offerts à ce contexte.
 *
 * Une seule définition de la règle, sur le modèle de `availableTopbarWidgets` :
 * elle sert le rendu de la grille, le sélecteur d'ajout, la garde de navigation
 * et le préchargement. En avoir plusieurs, c'est en oublier une — et une seule
 * suffit à rouvrir la porte.
 */
export function availableFeatures({ kind, isAdmin }: HomeAudience): FeatureCatalogEntry[] {
    return FEATURE_CATALOG.filter((f) => featureAllowed(f, { kind, isAdmin }));
}

/**
 * Le contenu visible d'un dossier, dans l'ordre où il a été rangé.
 *
 * La même règle que la grille, appliquée derrière une tuile : un widget que ce
 * contexte n'a pas le droit d'ouvrir n'est pas déployé non plus. Un identifiant
 * inconnu (disposition écrite par une version plus récente) est ignoré plutôt
 * que de faire tomber l'écran.
 *
 * Un dossier peut donc paraître vide alors qu'il ne l'est pas dans la
 * disposition : c'est voulu, et c'est le même choix que pour la grille, où une
 * tuile réservée à l'administration disparaît au lieu de se griser.
 */
export function folderFeatures(items: readonly HomeFeatureId[], audience: HomeAudience): FeatureCatalogEntry[] {
    return items
        .map((id) => featureCatalogEntry(id))
        .filter((entry): entry is FeatureCatalogEntry => entry !== undefined && featureAllowed(entry, audience));
}

/** La même règle, appliquée à une entrée déjà connue. */
export function featureAllowed(entry: FeatureCatalogEntry, { kind, isAdmin }: HomeAudience): boolean {
    return !entry.adminOnly || (isAdmin && kind === 'personal');
}

/** La même règle encore, appliquée à des identifiants déjà épinglés (disposition héritée). */
export function usableFeatureIds(ids: readonly HomeFeatureId[], audience: HomeAudience): HomeFeatureId[] {
    const allowed = new Set(availableFeatures(audience).map((f) => f.id));
    return ids.filter((id) => allowed.has(id));
}

/**
 * Ce widget est-il ouvrable ici ? Réponse par identifiant, pour les appelants
 * qui n'ont qu'une vue (`allowedToOpen`, la garde unique de navigation).
 */
export function featureIdAllowed(id: string, audience: HomeAudience): boolean {
    const entry = FEATURE_CATALOG.find((f) => f.id === id);
    return !entry || featureAllowed(entry, audience);
}

/**
 * Les liaisons d'une fonctionnalité, **dans les deux sens**.
 *
 * Une liaison n'est déclarée qu'une fois, du côté qui la porte (un projet
 * pointe ses dépôts, pas l'inverse). La lire dans les deux sens est pourtant ce
 * qu'on attend d'une fiche : posté sur Git, on veut savoir que les projets s'y
 * raccrochent, sans avoir à parcourir toutes les autres entrées pour s'en
 * assurer. `outgoing` distingue les deux, parce que la phrase ne se lit pas
 * pareil selon le bout où l'on se trouve.
 */
export interface FeatureRelation {
    entry: FeatureCatalogEntry;
    what: string;
    outgoing: boolean;
}

export function featureRelations(id: HomeFeatureId): FeatureRelation[] {
    const out: FeatureRelation[] = [];
    for (const link of featureCatalogEntry(id)?.links ?? []) {
        const entry = featureCatalogEntry(link.to);
        if (entry) out.push({ entry, what: link.what, outgoing: true });
    }
    for (const source of FEATURE_CATALOG) {
        for (const link of source.links ?? []) {
            if (link.to === id) out.push({ entry: source, what: link.what, outgoing: false });
        }
    }
    return out;
}

/** Les entrées d'un rayon, dans l'ordre du catalogue. */
export function featuresInCategory(entries: FeatureCatalogEntry[], category: FeatureCategory): FeatureCatalogEntry[] {
    return entries.filter((f) => f.category === category);
}
