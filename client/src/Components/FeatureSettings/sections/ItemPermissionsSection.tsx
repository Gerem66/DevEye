import { featureDescriptor } from '@deveye/types';

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
    const noun = featureDescriptor(scope.feature).itemNoun ?? 'élément';

    return (
        <div className={styles.section}>
            <p className={styles.sectionHint}>
                Ce que chaque rôle voit de ce {noun}, ici. On ne peut qu’abaisser : un rôle sans accès à{' '}
                {featureDescriptor(scope.feature).label} ne peut pas le recevoir par ce biais.
            </p>
            <ItemGrantsPanel feature={feature} itemId={itemId} />
        </div>
    );
}
