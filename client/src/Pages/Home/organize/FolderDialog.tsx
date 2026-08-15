import type { HomeFeatureId } from 'deveye-types';

import { Dialog } from '@/Components/Dialog';
import TextInput from '@/Components/TextInput';
import { useAuth } from '@/auth/AuthProvider';
import { useActiveWorkspace } from '@/stores/workspace';
import {
    addFeatureToFolder,
    findFolder,
    foldedFeatureIds,
    placedFeatureIds,
    removeFeatureFromFolder,
    renameFolder,
    useHomeLayout
} from '@/stores/homeLayout';
import { availableFeatures, featureCatalogEntry } from '../catalog';
import { PickerList, type PickerEntry } from './PickerList';
import styles from './organize.module.css';

export interface FolderDialogProps {
    /** Le dossier en cours d'édition, ou `null` quand la fiche est fermée. */
    folderId: string | null;
    onClose: () => void;
}

/**
 * La fiche d'un dossier : son nom, ce qu'il contient, ce qu'on peut y ranger.
 *
 * Les ajouts **ne referment pas** la fiche, à la différence des autres
 * sélecteurs de l'accueil : remplir un dossier est un geste répété, et chaque
 * fonctionnalité rangée quitte la liste du bas pour rejoindre celle du haut, ce
 * qui donne à voir l'avancement. Rouvrir la fiche entre chaque aurait fait de la
 * cohérence de façade au prix du seul geste qui compte ici.
 *
 * Rien n'est mis en attente : chaque bouton écrit dans la disposition, qui est
 * déjà synchronisée en différé vers le serveur. Il n'y a donc ni « enregistrer »
 * ni état intermédiaire à perdre.
 */
export function FolderDialog({ folderId, onClose }: FolderDialogProps) {
    const layout = useHomeLayout();
    const { user } = useAuth();
    const workspace = useActiveWorkspace();

    // Relu à chaque rendu : un dossier supprimé (par un autre membre de
    // l'espace, ou par le bouton de retrait juste derrière) referme la fiche au
    // lieu de laisser éditer un objet qui n'existe plus.
    const found = folderId === null ? null : findFolder(layout, folderId);
    const folder = found?.folder ?? null;
    const sectionId = found?.section.id ?? null;

    // Trois états possibles pour une fonctionnalité, et la fiche en propose deux :
    // libre (nulle part), posée sur la grille (elle peut descendre ici, sa tuile
    // s'en va au passage), ou déjà dans un dossier (celui-ci ou un autre, et on
    // n'y touche pas depuis ici).
    const folded = new Set<string>(foldedFeatureIds(layout));
    const onGrid = new Set<string>(placedFeatureIds(layout).filter((id) => !folded.has(id)));
    const catalog = availableFeatures({ kind: workspace?.kind, isAdmin: user?.role === 'admin' });

    const pick =
        (id: HomeFeatureId): (() => void) =>
        () => {
            if (sectionId !== null && folder !== null) addFeatureToFolder(sectionId, folder.id, id);
        };
    const free: PickerEntry[] = catalog
        .filter((f) => !folded.has(f.id) && !onGrid.has(f.id))
        .map((f) => ({ key: f.id, icon: f.icon, label: f.title, onPick: pick(f.id) }));
    const movable: PickerEntry[] = catalog
        .filter((f) => onGrid.has(f.id))
        .map((f) => ({
            key: f.id,
            icon: f.icon,
            label: f.title,
            sub: 'Sa tuile quittera la grille',
            onPick: pick(f.id)
        }));

    return (
        <Dialog open={folder !== null} onClose={onClose} title='Dossier' width={520}>
            {folder !== null && sectionId !== null && (
                <div className={styles.folderForm}>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Nom</span>
                        <TextInput
                            value={folder.title}
                            onChange={(e) => renameFolder(sectionId, folder.id, e.target.value)}
                            placeholder='Ressources, Supervision…'
                            maxLength={40}
                        />
                    </label>

                    <div className={styles.folderGroup}>
                        <span className={styles.folderGroupTitle}>Dans ce dossier</span>
                        {folder.items.length === 0 ? (
                            <p className={styles.addEmpty}>Ce dossier est vide.</p>
                        ) : (
                            <div className={styles.folderList}>
                                {folder.items.map((id) => (
                                    <FolderRow
                                        key={id}
                                        id={id}
                                        onRemove={() => removeFeatureFromFolder(sectionId, folder.id, id)}
                                    />
                                ))}
                            </div>
                        )}
                    </div>

                    <div className={styles.folderGroup}>
                        <span className={styles.folderGroupTitle}>À ranger</span>
                        <PickerList entries={free} empty='Toutes les fonctionnalités sont déjà sur l’accueil.' />
                    </div>

                    {/* Séparées, parce que le geste n'est pas le même : celles-ci
                        sont déjà sur l'accueil, les ranger ici les déplace. Les
                        mêler aux libres aurait fait retirer une tuile de la
                        grille sans que le clic l'annonce. */}
                    {movable.length > 0 && (
                        <div className={styles.folderGroup}>
                            <span className={styles.folderGroupTitle}>Déplacer depuis la grille</span>
                            <PickerList entries={movable} empty='' />
                        </div>
                    )}
                </div>
            )}
        </Dialog>
    );
}

/**
 * Une fonctionnalité rangée dans le dossier. La sortir la retire de l'accueil :
 * elle réapparaît aussitôt dans la liste du dessous, et la reposer sur la grille
 * est un ajout ordinaire.
 */
function FolderRow({ id, onRemove }: { id: HomeFeatureId; onRemove: () => void }) {
    const entry = featureCatalogEntry(id);
    return (
        <div className={styles.folderItem}>
            <span className={`icon icon-${entry?.icon ?? 'other'} ${styles.addItemIcon}`} />
            <span className={styles.addItemLabel}>{entry?.title ?? id}</span>
            <button
                className={`${styles.tileAction} ${styles.tileRemove}`}
                onClick={onRemove}
                title='Sortir du dossier'
                aria-label='Sortir du dossier'
            >
                <span className={`icon icon-x ${styles.actionIconRemove}`} />
            </button>
        </div>
    );
}

export default FolderDialog;
