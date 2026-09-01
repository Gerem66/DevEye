import { featureDescriptor, itemNounForms } from '@deveye/types';

import { type SettingsScope } from '../scope';
import styles from '../FeatureSettings.module.css';
import ItemGrantsPanel from './ItemGrantsPanel';

/**
 * L'onglet Permissions d'un élément, pour l'espace actif. Tout le contenu vit
 * dans `ItemGrantsPanel`, partagé avec l'onglet Partage du domicile.
 */

interface Props {
    scope: SettingsScope;
}

export default function ItemPermissionsSection({ scope }: Props) {
    const feature = scope.feature;
    const itemId = scope.kind === 'item' ? scope.itemId : '';
    const { dem } = itemNounForms(scope.feature);

    return (
        <div className={styles.section}>
            <p className={styles.sectionHint}>
                Ce que chaque rôle peut faire de {dem}, ici. Ce que {featureDescriptor(scope.feature).label} accorde
                n’est qu’un défaut : {dem} le surcharge dans les deux sens. Un rôle sans aucun accès à{' '}
                {featureDescriptor(scope.feature).label} reste hors de portée, cela se règle sur le rôle.
            </p>
            <ItemGrantsPanel feature={feature} itemId={itemId} />
        </div>
    );
}
