import { featureDescriptor, type FeatureId } from '@deveye/types';

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
// `FeatureId` et non l'enum natif : la coquille sert AUSSI les modules
// installés (elle lit leur manifest pour les onglets et les panneaux), et le
// bouton commun doit pouvoir s'ouvrir sur `x-<slug>`. Le type disait natif
// alors que l'exécution servait déjà les modules — attrapé par check:sdk.
export type SettingsScope =
    | { kind: 'feature'; feature: FeatureId }
    | {
          kind: 'item';
          feature: FeatureId;
          /** Un nombre pour toute feature à lignes, un texte pour un appareil (UUID). */
          itemId: number | string;
          itemLabel: string;
          /**
           * `false` quand le serveur refuserait de projeter cet élément (un
           * palier gardé par mot de passe) : l'onglet Partage n'est pas
           * proposé, plutôt qu'ouvert sur un refus. Les permissions par
           * élément, elles, restent réglables.
           */
          shareable?: boolean;
      };

/** Les sections que la coquille sait rendre, dans leur ordre d'affichage. */
export type SettingsSectionId =
    | 'general'
    | 'sources'
    | 'notifications'
    | 'sync'
    | 'encryption'
    | 'sharing'
    | 'permissions'
    // Les onglets personnalisés d'un module (manifest.settings, CustomTabRef) :
    // la coquille ne connaît pas leurs ids à l'avance, le panneau vient du
    // module. L'intersection garde l'autocomplétion des sept natifs.
    | (string & {});

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

/**
 * L'identifiant NUMÉRIQUE d'un élément, pour les sections que la coquille rend
 * elle-même (partage, permissions, notifications) : leurs tables sont à clé
 * numérique, et une feature dont les éléments sont des textes (les appareils)
 * n'y est jamais branchée. `null` pour une portée de feature ou un id texte.
 */
export function numericItemId(scope: SettingsScope): number | null {
    return scope.kind === 'item' && typeof scope.itemId === 'number' ? scope.itemId : null;
}
