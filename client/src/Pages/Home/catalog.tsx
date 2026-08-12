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
import { DatabaseWidget } from '@/Features/Database/DatabaseWidget';
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
import FeatureDatabase from '@/Features/Database';
import FeatureOsint from '@/Features/Osint';

import type { FeatureProps } from '@/Features/types';

/**
 * Static catalog of the built-in feature widgets that can live on the home grid.
 * The grid itself is composed from the user's saved layout (see `stores/homeLayout`);
 * this is the source of truth for what each feature *is* (its card content, full
 * view, cache policy) and is also what the "add tile" picker lists.
 */
export interface FeatureCatalogEntry {
    id: HomeFeatureId;
    title: string;
    icon: string;
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
        WidgetContent: WeatherWidget,
        FullComponent: Weather,
        cacheDurationMinutes: 60,
        preload: true
    },
    {
        id: 'password',
        title: 'Mot de passe',
        icon: 'lock',
        WidgetContent: PasswordWidget,
        FullComponent: FeaturePassword,
        cacheDurationMinutes: 0,
        holdSecrecy: true
    },
    {
        id: 'notes',
        title: 'Notes',
        icon: 'notes',
        WidgetContent: NotesWidget,
        FullComponent: FeatureNotes,
        cacheDurationMinutes: 0,
        holdSecrecy: true
    },
    {
        id: 'uptime',
        title: 'Uptime',
        icon: 'uptime',
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
        WidgetContent: CloudSyncWidget,
        FullComponent: CloudSync,
        cacheDurationMinutes: 5
    },
    {
        id: 'projects',
        title: 'Projets',
        icon: 'projects',
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
        WidgetContent: GitWidget,
        FullComponent: FeatureGit,
        // Démonté dès la fermeture : la vue d'un dépôt sonde l'avancement d'une
        // synchronisation en cours, et une instance en cache continuerait de
        // sonder sans être vue. Pas de `holdSecrecy` : rien n'y est chiffré à
        // l'étage gardé, donc rien ne peut déclencher l'invite.
        cacheDurationMinutes: 0
    },
    {
        id: 'database',
        title: 'Bases de données',
        icon: 'database',
        WidgetContent: DatabaseWidget,
        FullComponent: FeatureDatabase,
        // Démonté dès la fermeture, comme Git : l'explorateur de tables tient
        // des résultats lus chez un serveur tiers, qui n'ont aucune raison de
        // survivre à la fermeture de l'écran. Pas de `holdSecrecy` : rien n'y
        // est chiffré à l'étage gardé.
        cacheDurationMinutes: 0
    },
    {
        id: 'osint',
        title: 'OSINT',
        icon: 'search',
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

/** Qui regarde, et depuis quel genre d'espace. */
export interface FeatureAudience {
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
export function availableFeatures({ kind, isAdmin }: FeatureAudience): FeatureCatalogEntry[] {
    return FEATURE_CATALOG.filter((f) => featureAllowed(f, { kind, isAdmin }));
}

/** La même règle, appliquée à une entrée déjà connue. */
export function featureAllowed(entry: FeatureCatalogEntry, { kind, isAdmin }: FeatureAudience): boolean {
    return !entry.adminOnly || (isAdmin && kind === 'personal');
}

/** La même règle encore, appliquée à des identifiants déjà épinglés (disposition héritée). */
export function usableFeatureIds(ids: readonly HomeFeatureId[], audience: FeatureAudience): HomeFeatureId[] {
    const allowed = new Set(availableFeatures(audience).map((f) => f.id));
    return ids.filter((id) => allowed.has(id));
}

/**
 * Ce widget est-il ouvrable ici ? Réponse par identifiant, pour les appelants
 * qui n'ont qu'une vue (`allowedToOpen`, la garde unique de navigation).
 */
export function featureIdAllowed(id: string, audience: FeatureAudience): boolean {
    const entry = FEATURE_CATALOG.find((f) => f.id === id);
    return !entry || featureAllowed(entry, audience);
}
