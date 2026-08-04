import { Dialog } from '@/Components/Dialog';
import { addSection } from '@/stores/homeLayout';
import { PickerList, type PickerEntry } from './PickerList';
import { SECTION_KINDS, SECTION_KIND_DESC, SECTION_KIND_ICON, SECTION_KIND_LABEL } from './sectionKinds';

export interface AddSectionDialogProps {
    open: boolean;
    onClose: () => void;
}

/**
 * Picks the kind of a new grid section. Nothing is filtered out: several
 * sections of the same kind are allowed (e.g. work vs. personal shortcuts).
 */
export function AddSectionDialog({ open, onClose }: AddSectionDialogProps) {
    const entries: PickerEntry[] = SECTION_KINDS.map((kind) => ({
        key: kind,
        icon: SECTION_KIND_ICON[kind],
        label: SECTION_KIND_LABEL[kind],
        sub: SECTION_KIND_DESC[kind],
        onPick: () => {
            addSection(kind);
            onClose();
        }
    }));

    return (
        <Dialog open={open} onClose={onClose} title='Ajouter une section' width={520}>
            <PickerList entries={entries} empty='' />
        </Dialog>
    );
}

export default AddSectionDialog;
