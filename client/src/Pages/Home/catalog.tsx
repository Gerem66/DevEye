import type { ComponentType } from 'react';
import type { HomeFeatureId } from '@deveye/types';

import type { FeatureProps } from '@/Features/types';
import { cardModules } from '@/sdk/registry';
import { isFeatureHidden } from '@/stores/maintenance';

/** Le rayon du marché, porté par l'entrée elle-même : le marché et l'« À
 *  propos » racontent la même chose sans table à côté. */
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
 * Une vraie liaison de données (un projet pointe ses dépôts, un émetteur passe
 * par Mail), pas un voisinage thématique ; lue par la fiche « À propos ».
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
    /**
     * La vignette qu'un module dessine lui-même : `FeatureArt` ne connaît que
     * les ids natifs, et un id externe n'y trouverait qu'un cadre vide.
     */
    Art?: ComponentType;
}

/** L'adaptateur de vue d'un module : sa `Full` ne reçoit que `closeFeature`,
 *  le reste passe par les hooks du SDK. */
function moduleFull(Full: ComponentType<{ closeFeature(): void }>): ComponentType<FeatureProps> {
    return function ModuleFull(props: FeatureProps) {
        return <Full closeFeature={props.closeFeature} />;
    };
}

/**
 * Le catalogue complet, projeté depuis le manifest et l'entrée client des
 * modules installés. PARESSEUX : figé au premier appel (au rendu, après
 * l'enregistrement des modules), jamais à l'évaluation du module ; le graphe
 * d'imports atteint ce fichier avant `registerClientModules`, et une constante
 * de portée module se figerait sans les modules.
 */
let MERGED: FeatureCatalogEntry[] | null = null;

export function featureCatalog(): readonly FeatureCatalogEntry[] {
    if (MERGED === null) {
        MERGED = [
            ...cardModules().map(({ manifest, client }): FeatureCatalogEntry => ({
                // Un module est externe par construction (vérifié à
                // l'enregistrement), et un id externe est une tuile d'accueil valide.
                id: manifest.id as HomeFeatureId,
                title: manifest.label,
                icon: manifest.icon,
                description: manifest.description,
                category: manifest.category,
                // Les liaisons du manifest, lues dans les deux sens par l'« À propos ».
                links: manifest.links?.map((link) => ({ to: link.to as HomeFeatureId, what: link.what })),
                // Garantis par l'enregistrement pour tout module à carte.
                WidgetContent: client.Widget!,
                FullComponent: moduleFull(client.Full!),
                cacheDurationMinutes: client.cacheDurationMinutes,
                preload: client.preload,
                holdSecrecy: client.holdSecrecy,
                compact: manifest.tile?.compact,
                Art: client.Art
            }))
        ];
    }
    return MERGED;
}

/**
 * Le catalogue tel que le voit le compte courant : sans les features en
 * préversion qui ne lui sont pas ouvertes. {@link featureCatalog} reste entier
 * pour les vues, qu'un administrateur ouvre.
 */
export function visibleFeatureCatalog(): FeatureCatalogEntry[] {
    return featureCatalog().filter((f) => !isFeatureHidden(f.id));
}

/** `undefined` pour un id inconnu, et pour une feature que le compte courant ne voit pas. */
export function featureCatalogEntry(id: HomeFeatureId): FeatureCatalogEntry | undefined {
    if (isFeatureHidden(id)) return undefined;
    return featureCatalog().find((f) => f.id === id);
}

/**
 * Ces ids, dans cet ordre. Un id inconnu (disposition plus récente, module
 * retiré) est ignoré plutôt que de faire tomber l'écran.
 */
export function catalogEntries(items: readonly HomeFeatureId[]): FeatureCatalogEntry[] {
    return items
        .map((id) => featureCatalogEntry(id))
        .filter((entry): entry is FeatureCatalogEntry => entry !== undefined);
}

/**
 * Une liaison d'une fonctionnalité, dans un sens ou dans l'autre : elle n'est
 * déclarée que du côté qui la porte, mais la fiche la lit des deux bouts.
 * `outgoing` dit lequel, la phrase ne se lisant pas pareil.
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
    for (const source of visibleFeatureCatalog()) {
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
