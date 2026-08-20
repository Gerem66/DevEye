import { featureDescriptor, type WorkspaceFeatureId } from 'deveye-types';

/**
 * Ce que règle une coquille de réglages : une fonctionnalité, ou un de ses
 * éléments.
 *
 * **Une seule coquille pour les deux échelles**, et c'est le point du chantier.
 * Les sections sont les mêmes (où partent les alertes, qui a le droit, où la
 * donnée est visible) ; seule leur portée change. En faire deux composants
 * aurait garanti qu'une section ajoutée n'arrive que dans l'un des deux — c'est
 * exactement ce qui était arrivé aux cinq dialogues de notifications avant leur
 * unification, dont l'un avait perdu en chemin l'avertissement « aucun compte
 * expéditeur valide ».
 */
export type SettingsScope =
    | { kind: 'feature'; feature: WorkspaceFeatureId }
    | { kind: 'item'; feature: WorkspaceFeatureId; itemId: number; itemLabel: string };

/** Les sections que la coquille sait rendre. */
export type SettingsSectionId = 'notifications' | 'permissions' | 'sharing';

/** Le titre du dialogue : le nom de l'élément, ou celui de la fonctionnalité. */
export function scopeTitle(scope: SettingsScope): string {
    return scope.kind === 'item' ? scope.itemLabel : featureDescriptor(scope.feature).label;
}

/**
 * La phrase sous le titre : elle dit **sur quoi** les réglages portent.
 *
 * Sans elle, la coquille d'un élément et celle de sa fonctionnalité se
 * ressemblent trop : on croit régler une base et on règle toutes les bases. Le
 * même défaut que les cinq dialogues d'avant, où l'on croyait régler Sentinelle
 * en réglant Uptime.
 */
export function scopeDescription(scope: SettingsScope): string {
    const feature = featureDescriptor(scope.feature);
    if (scope.kind === 'feature') {
        // Le libellé **tel quel** : « Uptime », « CloudSync », « OSINT » sont des
        // noms propres, et les passer en minuscules les fait lire comme des mots
        // ordinaires — « réglages communs à uptime » sonne comme une faute.
        return `Réglages communs à ${feature.label} — ils s’appliquent à tout ce que la fonctionnalité contient.`;
    }
    const noun = feature.itemNoun ?? 'élément';
    return `Réglages propres à ce ${noun}. Ce qui n’est pas réglé ici suit ${feature.label}.`;
}
