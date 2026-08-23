import { featureDescriptor, type WorkspaceFeatureId } from 'deveye-types';

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
    // Rendue seulement derrière la garde `SHARE_WIRED_FEATURES` (natives) :
    // les contrats `share.*` sont typés sur l'enum natif tant que le partage
    // des éléments de modules n'est pas branché (dettes n°2 et 3 de la
    // refonte). Ce rétrécissement tombera avec elles.
    const feature = scope.feature as WorkspaceFeatureId;
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
