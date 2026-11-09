import { useState, type KeyboardEvent } from 'react';
import { SegmentedControl, TextInput } from 'deveye-sdk-client';

import type { ThumbSize } from '../contracts/prefs';
import { PageBoard, type SelectGesture } from './PageBoard';
import styles from './pdf.module.css';
import { usePrefs } from './prefs';
import { RangeDialog } from './RangeDialog';
import { SelectionBar } from './SelectionBar';
import type { Workshop } from './usePdfWorkshop';

interface PagesTabProps {
    workshop: Workshop;
    /** Le nom du fichier produit, tel que tapé. */
    fileName: string;
    onFileName: (name: string) => void;
    /** Des fichiers déposés sur la grille. */
    onAddFiles: (files: File[]) => void;
    /** Le bouton Ajouter des pages : choisir des fichiers. */
    onAdd: () => void;
    /** Ouvrir Signer et annoter, qui part de la page sélectionnée. */
    onEdit: () => void;
}

/** Fusionner, extraire, réorganiser : les fichiers, la sélection et la grille des pages. */
export function PagesTab({ workshop, fileName, onFileName, onAddFiles, onAdd, onEdit }: PagesTabProps) {
    const { plan, selection, act } = workshop;
    const [rangeOpen, setRangeOpen] = useState(false);
    const { prefs, save } = usePrefs();
    // La taille choisie, tenue ici le temps que le compte l'écrive.
    const [thumbs, setThumbs] = useState<ThumbSize | null>(null);
    const size = thumbs ?? prefs.thumbs;

    const select = (gesture: SelectGesture, id: string): void => {
        if (gesture.shiftKey) act('extend', { id });
        else if (gesture.ctrlKey || gesture.metaKey) act('toggle', { id });
        else act('select', { ids: [id] });
    };

    const open = (id: string): void => {
        act('select', { ids: [id] });
        onEdit();
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
            <div className={styles.pagesHead}>
                <label className={`${styles.headField} ${styles.nameField}`} htmlFor='pdf-file-name'>
                    <span className={styles.inspectorLabel}>Nom du fichier</span>
                    <TextInput
                        id='pdf-file-name'
                        value={fileName}
                        maxLength={200}
                        onChange={(e) => onFileName(e.target.value)}
                    />
                </label>
                <div className={styles.headField}>
                    <span className={styles.inspectorLabel}>Aperçus</span>
                    <SegmentedControl
                        value={size}
                        options={[
                            { value: 'small', label: 'Petits' },
                            { value: 'medium', label: 'Moyens' },
                            { value: 'large', label: 'Grands' }
                        ]}
                        onChange={(next) => {
                            setThumbs(next);
                            save({ thumbs: next });
                        }}
                        aria-label='Taille des aperçus'
                    />
                </div>
            </div>
            <SelectionBar workshop={workshop} onRange={() => setRangeOpen(true)} onAdd={onAdd} />
            <PageBoard
                plan={plan}
                selection={selection}
                onSelect={select}
                onOpen={open}
                onReorder={(order) => act('reorder', { order })}
                onRemove={(id) => act('remove', { ids: [id] })}
                onFiles={onAddFiles}
                thumbs={size}
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
