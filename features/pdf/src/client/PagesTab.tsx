import { useState, type KeyboardEvent } from 'react';

import { PageBoard, type SelectGesture } from './PageBoard';
import styles from './pdf.module.css';
import { RangeDialog } from './RangeDialog';
import { SelectionBar } from './SelectionBar';
import { SourceStrip } from './SourceStrip';
import type { Workshop } from './usePdfWorkshop';

interface PagesTabProps {
    workshop: Workshop;
    /** Des fichiers déposés sur la grille. */
    onAddFiles: (files: File[]) => void;
    /** Le bouton Importer : choisir des fichiers. */
    onImport: () => void;
}

/** Fusionner, extraire, réorganiser : les fichiers, la sélection et la grille des pages. */
export function PagesTab({ workshop, onAddFiles, onImport }: PagesTabProps) {
    const { plan, selection, act } = workshop;
    const [rangeOpen, setRangeOpen] = useState(false);

    const select = (gesture: SelectGesture, id: string): void => {
        if (gesture.shiftKey) act('extend', { id });
        else if (gesture.ctrlKey || gesture.metaKey) act('toggle', { id });
        else act('select', { ids: [id] });
    };

    // Les raccourcis valent quand le clavier est dans la grille : un dialogue ouvert par-dessus ne les reçoit pas.
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
        const modifier = e.ctrlKey || e.metaKey;
        const key = e.key.toLowerCase();
        if (modifier && key === 'a') {
            e.preventDefault();
            act('select', { ids: plan.pages.map((p) => p.id), anchor: null });
        } else if (modifier && key === 'z') {
            e.preventDefault();
            if (e.shiftKey) workshop.redo();
            else workshop.undo();
        } else if (modifier && key === 'y') {
            e.preventDefault();
            workshop.redo();
        } else if ((e.key === 'Delete' || e.key === 'Backspace') && selection.length > 0) {
            e.preventDefault();
            act('remove', { ids: selection });
        }
    };

    return (
        <div className={styles.body} onKeyDown={onKeyDown}>
            <SourceStrip
                plan={plan}
                onRemove={(id) => act('removeSource', { id })}
                onReorder={(order) => act('reorderSources', { order })}
            />
            <SelectionBar workshop={workshop} onRange={() => setRangeOpen(true)} onImport={onImport} />
            <PageBoard
                plan={plan}
                selection={selection}
                onSelect={select}
                onReorder={(order) => act('reorder', { order })}
                onRemove={(id) => act('remove', { ids: [id] })}
                onFiles={onAddFiles}
            />
            <RangeDialog
                open={rangeOpen}
                count={plan.pages.length}
                onClose={() => setRangeOpen(false)}
                onPick={(indices) => act('select', { ids: indices.map((i) => plan.pages[i].id), anchor: null })}
            />
        </div>
    );
}
