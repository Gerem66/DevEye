import { featureDescriptor, type FeatureId } from '@deveye/types';

/**
 * Ce que règle une coquille de réglages : une fonctionnalité, ou un de ses
 * éléments. Une seule coquille pour les deux échelles : les sections sont les
 * mêmes, seule leur portée change. `FeatureId` et non l'enum natif : la
 * coquille sert aussi les modules installés (`x-<slug>`).
 */
export type SettingsScope =
    | { kind: 'feature'; feature: FeatureId }
    | {
          kind: 'item';
          feature: FeatureId;
          /** Texte : la clé de la table de la feature, entière ou non (un appareil est un UUID). */
          itemId: string;
          itemLabel: string;
          /**
           * `false` quand le serveur refuserait de projeter cet élément (palier
           * gardé par mot de passe) : l'onglet Partage n'est pas proposé. Les
           * permissions par élément restent réglables.
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
 * La phrase sous le titre dit sur quoi les réglages portent : sans elle, la
 * coquille d'un élément et celle de sa fonctionnalité se ressemblent trop.
 */
export function scopeDescription(scope: SettingsScope): string {
    const feature = featureDescriptor(scope.feature);
    if (scope.kind === 'feature') {
        // Le libellé tel quel : « Uptime », « OSINT » sont des noms propres, en
        // minuscules ils se lisent comme une faute.
        return `Réglages communs à ${feature.label} — ils s’appliquent à tout ce que la fonctionnalité contient.`;
    }
    const noun = feature.itemNoun ?? 'élément';
    return `Réglages propres à ce ${noun}. Ce qui n’est pas réglé ici suit ${feature.label}.`;
}

/**
 * L'id d'un élément pour les routes de notification, seules à garder une clé
 * numérique. `null` pour une portée de feature, comme pour une feature dont les
 * éléments ont un identifiant texte : elle n'a pas de route.
 */
export function routeItemId(scope: SettingsScope): number | null {
    if (scope.kind !== 'item') return null;
    const id = Number(scope.itemId);
    return Number.isInteger(id) ? id : null;
}
