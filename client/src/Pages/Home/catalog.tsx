import type { ComponentType } from 'react';
import type { HomeFeatureId } from '@deveye/types';

import type { FeatureProps } from '@/Features/types';
import { clientModules } from '@/sdk/registry';

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
 * The catalog of the feature widgets that can live on the home grid. The grid
 * itself is composed from the user's saved layout (see `stores/homeLayout`);
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
     * `holdSecrecy`). Left unset for non-encrypted views (devices, weather).
     */
    holdSecrecy?: boolean;
    /** Carte basse (demi-hauteur), comme les tuiles d'appareil. Déclarée par les modules. */
    compact?: boolean;
}

/**
 * L'adaptateur de vue d'un module : sa `Full` ne reçoit que `closeFeature`,
 * tout le reste passe par les hooks du SDK, comme chez les natives modernes.
 */
function moduleFull(Full: ComponentType<{ closeFeature(): void }>): ComponentType<FeatureProps> {
    return function ModuleFull(props: FeatureProps) {
        return <Full closeFeature={props.closeFeature} />;
    };
}

/**
 * Le catalogue complet : les modules installés, projetés depuis leur manifest
 * + leur entrée client. Plus aucune native depuis le rapatriement des
 * Appareils, la seizième : la grille, le marché d'ajout et l'« À propos »
 * lisent le même contrat pour toutes.
 *
 * PARESSEUX, et c'est vital : figé au premier APPEL (toujours au rendu, donc
 * après l'enregistrement des modules), jamais à l'évaluation du module. Une
 * constante de portée module s'était fait piéger : le graphe d'imports de la
 * glue générée atteignait ce fichier via TopNavbar → usePresence AVANT que
 * `registerClientModules` n'ait tourné, et le catalogue se figeait sans les
 * modules : Météo disparaissait du marché d'ajout sans un bruit.
 */
let MERGED: FeatureCatalogEntry[] | null = null;

export function featureCatalog(): readonly FeatureCatalogEntry[] {
    if (MERGED === null) {
        MERGED = [
            ...clientModules().map(({ manifest, client }): FeatureCatalogEntry => ({
                // Un module est externe par construction (vérifié à
                // l'enregistrement), et un id externe est une tuile d'accueil
                // valide depuis l'élargissement.
                id: manifest.id as HomeFeatureId,
                title: manifest.label,
                icon: manifest.icon,
                description: manifest.description,
                category: manifest.category,
                // Les liaisons déclarées par le manifest : la fiche « À propos »
                // les lit dans les deux sens, comme celles des natives.
                links: manifest.links?.map((link) => ({ to: link.to as HomeFeatureId, what: link.what })),
                WidgetContent: client.Widget,
                FullComponent: moduleFull(client.Full),
                cacheDurationMinutes: client.cacheDurationMinutes,
                preload: client.preload,
                holdSecrecy: client.holdSecrecy,
                compact: manifest.tile?.compact
            }))
        ];
    }
    return MERGED;
}

export function featureCatalogEntry(id: HomeFeatureId): FeatureCatalogEntry | undefined {
    return featureCatalog().find((f) => f.id === id);
}

/**
 * Le contenu d'un dossier, dans l'ordre où il a été rangé.
 *
 * Un identifiant inconnu (disposition écrite par une version plus récente, ou
 * module retiré depuis) est ignoré plutôt que de faire tomber l'écran : un
 * dossier peut donc paraître vide alors qu'il ne l'est pas dans la
 * disposition, le même choix que pour la grille.
 */
export function folderFeatures(items: readonly HomeFeatureId[]): FeatureCatalogEntry[] {
    return items
        .map((id) => featureCatalogEntry(id))
        .filter((entry): entry is FeatureCatalogEntry => entry !== undefined);
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
    for (const source of featureCatalog()) {
        for (const link of source.links ?? []) {
            if (link.to === id) out.push({ entry: source, what: link.what, outgoing: false });
        }
    }
    return out;
}

/** Les entrées d'un rayon, dans l'ordre du catalogue. */
export function featuresInCategory(
    entries: readonly FeatureCatalogEntry[],
    category: FeatureCategory
): FeatureCatalogEntry[] {
    return entries.filter((f) => f.category === category);
}
