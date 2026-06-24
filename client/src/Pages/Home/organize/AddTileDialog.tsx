import { Dialog } from '@/Components/Dialog';
import { useDevices } from '@/stores/devices';
import { addDevice, addFeature, findCategory, useHomeLayout } from '@/stores/homeLayout';
import type { HomeCategoryKind, ShortcutItem } from 'deveye-types';
import { FEATURE_CATALOG } from '../catalog';
import { ShortcutForm } from './ShortcutForm';
import styles from './organize.module.css';

const TITLE: Record<HomeCategoryKind, string> = {
    device: 'Ajouter un appareil',
    feature: 'Ajouter une fonctionnalité',
    shortcut: 'Nouveau raccourci'
};

/** Picker for built-in features not yet on the grid. */
function FeaturePicker({ onAdded }: { onAdded: () => void }) {
    const layout = useHomeLayout();
    const used = new Set(findCategory(layout, 'feature')?.items ?? []);
    const available = FEATURE_CATALOG.filter((f) => !used.has(f.id));

    if (available.length === 0) {
        return <p className={styles.addEmpty}>Toutes les fonctionnalités sont déjà affichées.</p>;
    }
    return (
        <div className={styles.addList}>
            {available.map((f) => (
                <button
                    key={f.id}
                    className={styles.addItem}
                    onClick={() => {
                        addFeature(f.id);
                        onAdded();
                    }}
                >
                    <span className={`icon icon-${f.icon} ${styles.addItemIcon}`} />
                    <span className={styles.addItemLabel}>{f.title}</span>
                    <span className={`icon icon-plus ${styles.addItemPlus}`} />
                </button>
            ))}
        </div>
    );
}

/** Picker for connected devices not yet on the grid (archived ones excluded). */
function DevicePicker({ onAdded }: { onAdded: () => void }) {
    const layout = useHomeLayout();
    const { devices } = useDevices();
    const used = new Set(findCategory(layout, 'device')?.items ?? []);
    const available = devices.filter((d) => d.status !== 'archived' && !used.has(d.id));

    if (available.length === 0) {
        return (
            <p className={styles.addEmpty}>
                {devices.length === 0 ? 'Aucun appareil connecté.' : 'Tous vos appareils sont déjà affichés.'}
            </p>
        );
    }
    return (
        <div className={styles.addList}>
            {available.map((d) => (
                <button
                    key={d.id}
                    className={styles.addItem}
                    onClick={() => {
                        addDevice(d.id);
                        onAdded();
                    }}
                >
                    <span className={`icon icon-server ${styles.addItemIcon}`} />
                    <span className={styles.addItemLabel}>
                        {d.name}
                        <span className={styles.addItemSub}>{d.platform}</span>
                    </span>
                    <span className={`${styles.addDot} ${d.online ? styles.online : styles.offline}`} />
                    <span className={`icon icon-plus ${styles.addItemPlus}`} />
                </button>
            ))}
        </div>
    );
}

export interface AddTileDialogProps {
    /** Which category's picker to show (create), or null when not creating. */
    kind: HomeCategoryKind | null;
    /** When set, edits this shortcut instead of showing a picker. */
    editShortcut?: ShortcutItem | null;
    onClose: () => void;
}

/**
 * Per-category add dialog: a focused picker (devices / features), the shortcut
 * creation form, or — when `editShortcut` is set — the shortcut edit form. Each
 * add closes the dialog, so the three kinds behave consistently.
 */
export function AddTileDialog({ kind, editShortcut, onClose }: AddTileDialogProps) {
    const open = kind !== null || !!editShortcut;
    const title = editShortcut ? 'Modifier le raccourci' : kind ? TITLE[kind] : '';
    return (
        <Dialog open={open} onClose={onClose} title={title} width={520}>
            {editShortcut ? (
                <ShortcutForm initial={editShortcut} onDone={onClose} />
            ) : (
                <>
                    {/* Devices, features & shortcuts are all added one at a time and
                        close the dialog on success — consistent across the three. */}
                    {kind === 'device' && <DevicePicker onAdded={onClose} />}
                    {kind === 'feature' && <FeaturePicker onAdded={onClose} />}
                    {kind === 'shortcut' && <ShortcutForm onDone={onClose} />}
                </>
            )}
        </Dialog>
    );
}

export default AddTileDialog;
