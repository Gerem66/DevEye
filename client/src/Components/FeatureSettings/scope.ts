import {
    featureDescriptor,
    type FeatureId,
    featureNotifiesItself,
    itemNounForms,
    SYSTEM_NOTIFICATION_INFO,
    SYSTEM_NOTIFICATION_TARGET,
    type SystemNotificationTarget
} from '@deveye/types';

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
      }
    | {
          /**
           * Une fiche de la feature qui n'est pas un élément (une facture, dont
           * le client est l'élément) : ses onglets sont ceux du manifest
           * (`settings.record`), sans partage, permissions ni notifications,
           * qui appartiennent aux éléments.
           */
          kind: 'record';
          feature: FeatureId;
          recordId: string;
          recordLabel: string;
          description: string;
      };

/**
 * La cible système : les alertes de l'instance, réservées aux admins. Hors du
 * registre, elle n'a que l'onglet Notifications ; seules les entrées de la
 * coquille l'acceptent, jamais les sections propres aux fonctionnalités.
 */
export type SystemScope = { kind: 'feature'; feature: SystemNotificationTarget };

/** Ce qu'ouvre la coquille : une fonctionnalité, un élément, ou la cible système. */
export type ShellScope = SettingsScope | SystemScope;

export function isSystemScope(scope: ShellScope): scope is SystemScope {
    return scope.feature === SYSTEM_NOTIFICATION_TARGET;
}

/** Les sections que la coquille sait rendre, dans leur ordre d'affichage. */
export type SettingsSectionId =
    | 'general'
    | 'sources'
    | 'domains'
    | 'notifications'
    | 'sync'
    | 'encryption'
    | 'projects'
    | 'sharing'
    | 'permissions'
    // Les onglets personnalisés d'un module (manifest.settings, CustomTabRef) :
    // la coquille ne connaît pas leurs ids à l'avance, le panneau vient du
    // module. L'intersection garde l'autocomplétion des neuf natifs.
    | (string & {});

/**
 * Ce que la coquille lit d'une cible : le descripteur d'une fonctionnalité, ou
 * l'équivalent de la cible système, qui n'est pas au registre.
 */
export function targetInfo(feature: FeatureId | SystemNotificationTarget): {
    label: string;
    hasItems: boolean;
    notifies: boolean;
    notificationsHint: string | null;
    /** La fonctionnalité prévient-elle en son nom propre (route `item_id = 0`) ? Sans éléments, ou sans rien par élément. */
    featureRoute: boolean;
    itemNoun: string | null;
} {
    if (feature === SYSTEM_NOTIFICATION_TARGET) {
        return {
            label: SYSTEM_NOTIFICATION_INFO.label,
            hasItems: false,
            notifies: true,
            notificationsHint: SYSTEM_NOTIFICATION_INFO.hint,
            featureRoute: true,
            itemNoun: null
        };
    }
    const descriptor = featureDescriptor(feature);
    return {
        label: descriptor.label,
        hasItems: descriptor.hasItems,
        notifies: descriptor.notifies,
        notificationsHint: descriptor.notifications?.hint ?? null,
        featureRoute: featureNotifiesItself(descriptor),
        itemNoun: descriptor.itemNoun ?? null
    };
}

/** Le titre du dialogue : le nom de l'élément ou de la fiche, ou celui de la fonctionnalité. */
export function scopeTitle(scope: ShellScope): string {
    if (scope.kind === 'item') return scope.itemLabel;
    if (scope.kind === 'record') return scope.recordLabel;
    return targetInfo(scope.feature).label;
}

/**
 * La phrase sous le titre dit sur quoi les réglages portent : sans elle, la
 * coquille d'un élément et celle de sa fonctionnalité se ressemblent trop.
 */
export function scopeDescription(scope: ShellScope): string {
    if (isSystemScope(scope)) return 'Où partent les alertes de cette instance DevEye.';
    if (scope.kind === 'record') return scope.description;
    const feature = targetInfo(scope.feature);
    if (scope.kind === 'feature') {
        // Le libellé tel quel : « Uptime », « OSINT » sont des noms propres, en
        // minuscules ils se lisent comme une faute.
        return feature.hasItems
            ? `Réglages généraux de ${feature.label} : ils valent pour tout ce qu’elle contient, sauf là où un élément règle le sien.`
            : `Réglages généraux de ${feature.label}.`;
    }
    // Le même mot, « réglages généraux », aux deux échelles : c'est lui qui rend
    // lisible qu'un élément hérite de sa fonctionnalité et peut s'en écarter.
    return `Réglages propres à ${itemNounForms(scope.feature).dem}. Ce qui n’est pas réglé ici suit les réglages généraux de ${feature.label}.`;
}

/**
 * Ce que la coquille ouverte pose dans le chemin live, et ce que le bouton
 * consulte pour s'entourer. Une seule fonction pour les deux : deux chaînes
 * écrites séparément se sépareraient un jour, et le halo cesserait sans bruit.
 *
 * L'élément n'entre pas dans la valeur : le niveau qui le porte est déjà dans
 * le chemin, et deux personnes sur deux éléments différents divergent avant
 * d'arriver ici.
 */
export function liveSettingsValue(scope: ShellScope): string {
    return `${scope.kind}:${scope.feature}`;
}

/**
 * L'id d'un élément pour les routes de notification, seules à garder une clé
 * numérique. `null` pour une portée de feature, comme pour une feature dont les
 * éléments ont un identifiant texte : elle n'a pas de route.
 */
export function routeItemId(scope: ShellScope): number | null {
    if (scope.kind !== 'item') return null;
    const id = Number(scope.itemId);
    return Number.isInteger(id) ? id : null;
}
