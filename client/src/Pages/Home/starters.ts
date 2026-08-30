import type { HomeFeatureId, HomeLayout } from '@deveye/types';

import { placedFeatureIds } from '@/stores/homeLayout';
import { catalogEntries, type FeatureCatalogEntry } from './catalog';

/**
 * La curation de l'accueil : ce qu'on met en avant, et les modèles proposés sur
 * un accueil vide. Elle appartient à l'app et non au manifeste d'un module, qui
 * se recommanderait lui-même. Un seul fichier à toucher quand le catalogue
 * bouge ; un id dont le module n'est pas installé disparaît de lui-même.
 */

/** Ce dont un utilisateur se sert au quotidien, sans supposer son métier. */
export const RECOMMENDED_FEATURE_IDS: readonly HomeFeatureId[] = [
    'devices',
    'uptime',
    'mail',
    'notes',
    'password',
    'weather',
    'projects'
];

/** Un modèle d'accueil : une section toute posée, nommée d'un usage. */
export interface HomeStarter {
    id: string;
    /** Sert aussi de titre à la section posée (plafond du schéma : 40). */
    label: string;
    icon: string;
    features: readonly HomeFeatureId[];
}

export const HOME_STARTERS: readonly HomeStarter[] = [
    {
        id: 'dev',
        label: 'Développeur',
        icon: 'branch',
        features: ['projects', 'git', 'audience', 'notes']
    },
    {
        id: 'devops',
        label: 'DevOps',
        icon: 'rocket',
        features: ['database', 'deploy', 'uptime', 'devices', 'backup']
    },
    {
        id: 'perso',
        label: 'Perso',
        icon: 'home',
        features: ['weather', 'mail', 'notes', 'password', 'finance']
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
