import type { HomeFeatureId, HomeLayout } from '@deveye/types';

import { placedFeatureIds } from '@/stores/homeLayout';
import { catalogEntries, type FeatureCatalogEntry } from './catalog';

/**
 * La curation de l'accueil : ce qu'on met en avant, et les modèles proposés sur
 * un accueil vide. Elle appartient à l'app et non au manifeste d'un module, qui
 * se recommanderait lui-même. Un seul fichier à toucher quand le catalogue
 * bouge ; un id dont le module n'est pas installé disparaît de lui-même.
 */

/** Ce dont un indépendant qui a des clients se sert au quotidien. */
export const RECOMMENDED_FEATURE_IDS: readonly HomeFeatureId[] = [
    'devices',
    'uptime',
    'projects',
    'invoicing',
    'mail',
    'notes',
    'password'
];

/** Un modèle d'accueil : une section toute posée, nommée d'un usage. */
export interface HomeStarter {
    id: string;
    /** Sert aussi de titre à la section posée (plafond du schéma : 40). */
    label: string;
    icon: string;
    features: readonly HomeFeatureId[];
}

/**
 * Les quatre groupes du site vitrine (`features.groups` de DevEye-Site), pour
 * que l'accueil tienne la promesse lue avant l'inscription.
 */
export const HOME_STARTERS: readonly HomeStarter[] = [
    {
        id: 'work',
        label: 'Travailler',
        icon: 'projects',
        features: ['projects', 'invoicing', 'finance', 'x-rdv', 'mail', 'notes', 'password']
    },
    {
        id: 'supervise',
        label: 'Superviser',
        icon: 'activity',
        features: ['devices', 'uptime', 'audience']
    },
    {
        id: 'ship',
        label: 'Livrer',
        icon: 'rocket',
        features: ['git', 'deploy', 'database', 'backup']
    },
    {
        id: 'secure',
        label: 'Sécuriser',
        icon: 'shield',
        features: ['sentinel', 'cve', 'x-audit', 'osint']
    }
];

/** Les fonctionnalités d'un modèle, réduites à celles qui sont installées. */
export function starterFeatures(starter: HomeStarter): FeatureCatalogEntry[] {
    return catalogEntries(starter.features);
}

/** Le rayon « Recommandé » du marché, réduit de même. */
export function recommendedFeatures(): FeatureCatalogEntry[] {
    return catalogEntries(RECOMMENDED_FEATURE_IDS);
}

/**
 * Tout le rayon est-il déjà posé ? Le marché ouvre alors sur « Tout » plutôt
 * que sur un rayon entièrement éteint. Un rayon vide compte comme épuisé.
 */
export function allRecommendedPlaced(layout: HomeLayout): boolean {
    const placed = new Set<string>(placedFeatureIds(layout));
    return recommendedFeatures().every((entry) => placed.has(entry.id));
}
