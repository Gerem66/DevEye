import { Dialog } from '@/Components/Dialog';
import { useAuth } from '@/auth/AuthProvider';
import { useDevices } from '@/stores/devices';
import { useActiveWorkspace } from '@/stores/workspace';
import { addDevice, addFeature, placedDeviceIds, placedFeatureIds, useHomeLayout } from '@/stores/homeLayout';
import type { HomeSection, ShortcutItem } from 'deveye-types';
import { availableFeatures } from '../catalog';
import { PickerList, type PickerEntry } from './PickerList';
import { ADD_TILE_TITLE } from './sectionKinds';
import { ShortcutForm } from './ShortcutForm';
import styles from './organize.module.css';

/** Picker for built-in features not yet on the grid. A feature can only live in
 *  one section, so the filter spans every feature section, not just the target. */
function FeaturePicker({ sectionId, onAdded }: { sectionId: string; onAdded: () => void }) {
    const layout = useHomeLayout();
    const { user } = useAuth();
    const workspace = useActiveWorkspace();
    const used = new Set(placedFeatureIds(layout));
    // Un widget qu'on n'a pas le droit d'ouvrir ici n'est pas non plus
    // *proposé* : le montrer dans le sélecteur reviendrait à laisser poser une
    // tuile que la grille refuserait ensuite de rendre.
    const catalog = availableFeatures({ kind: workspace?.kind, isAdmin: user?.role === 'admin' });
    const entries: PickerEntry[] = catalog
        .filter((f) => !used.has(f.id))
        .map((f) => ({
            key: f.id,
            icon: f.icon,
            label: f.title,
            onPick: () => {
                addFeature(sectionId, f.id);
                onAdded();
            }
        }));
    return <PickerList entries={entries} empty='Toutes les fonctionnalités sont déjà affichées.' />;
}

/** Picker for connected devices not yet on the grid (archived ones excluded). */
function DevicePicker({ sectionId, onAdded }: { sectionId: string; onAdded: () => void }) {
    const layout = useHomeLayout();
    const { devices } = useDevices();
    const used = new Set<string>(placedDeviceIds(layout));
    const entries: PickerEntry[] = devices
        .filter((d) => d.status !== 'archived' && !used.has(d.id))
        .map((d) => ({
            key: d.id,
            icon: 'server',
            label: d.name,
            sub: d.platform,
            trailing: <span className={`${styles.addDot} ${d.online ? styles.online : styles.offline}`} />,
            onPick: () => {
                addDevice(sectionId, d.id);
                onAdded();
            }
        }));
    return (
        <PickerList
            entries={entries}
            empty={devices.length === 0 ? 'Aucun appareil connecté.' : 'Tous vos appareils sont déjà affichés.'}
        />
    );
}

export interface AddTileDialogProps {
    /** Section to add a tile to, or null when not adding. */
    section: HomeSection | null;
    /** When set, edits this shortcut of `section` instead of showing a picker. */
    editShortcut?: ShortcutItem | null;
    onClose: () => void;
}

/**
 * Per-section add dialog: a focused picker (devices / features), the shortcut
 * creation form, or — when `editShortcut` is set — the shortcut edit form. Each
 * add closes the dialog, so the three kinds behave consistently.
 */
export function AddTileDialog({ section, editShortcut, onClose }: AddTileDialogProps) {
    const open = section !== null;
    const title = !section ? '' : editShortcut ? 'Modifier le raccourci' : ADD_TILE_TITLE[section.kind];
    return (
        <Dialog open={open} onClose={onClose} title={title} width={520}>
            {section && editShortcut ? (
                <ShortcutForm sectionId={section.id} initial={editShortcut} onDone={onClose} />
            ) : (
                section && (
                    <>
                        {/* Devices, features & shortcuts are all added one at a time and
                            close the dialog on success — consistent across the three. */}
                        {section.kind === 'device' && <DevicePicker sectionId={section.id} onAdded={onClose} />}
                        {section.kind === 'feature' && <FeaturePicker sectionId={section.id} onAdded={onClose} />}
                        {section.kind === 'shortcut' && <ShortcutForm sectionId={section.id} onDone={onClose} />}
                    </>
                )
            )}
        </Dialog>
    );
}

export default AddTileDialog;
