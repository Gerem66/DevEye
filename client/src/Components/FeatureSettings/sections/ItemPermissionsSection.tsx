import { featureDescriptor } from '@deveye/types';

import type { SettingsScope } from '../scope';
import styles from '../FeatureSettings.module.css';
import ItemGrantsPanel from './ItemGrantsPanel';

/**
 * L'onglet Permissions d'un élément : le panneau de restrictions, pour
 * l'espace **actif**.
 *
 * Tout le contenu vit dans `ItemGrantsPanel`, partagé avec l'onglet Partage du
 * domicile — c'est ce qui garantit que régler une fenêtre depuis chez soi et
 * depuis là-bas est le même écran.
 */

interface Props {
    scope: SettingsScope;
}

export default function ItemPermissionsSection({ scope }: Props) {
    const feature = scope.feature;
    const itemId = scope.kind === 'item' ? scope.itemId : 0;
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
