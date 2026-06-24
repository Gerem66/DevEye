import { useState } from 'react';

import styles from './style.module.css';

import Popup, { ClosePopup } from '@/Components/Popup';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';

import { NOTE_FOLDER_MAX_LENGTH } from 'deveye-types';

export const FOLDER_NAME_POPUP = 'popup-folder-name';

/** Input: an existing name to rename, or '' to create a new folder. */
export type FolderNameInput = { name: string; mode: 'add' | 'rename' } | null;
/** Result: the trimmed name to save, or null on cancel. */
export type FolderNameResult = string | null;

/**
 * A minimal name prompt shared by "Nouveau dossier" and folder rename. Kept
 * separate from the note editor so folder management stays out of the note form.
 */
export default function FolderNamePopup() {
    const [mode, setMode] = useState<'add' | 'rename'>('add');
    const [name, setName] = useState('');

    function handleOpen(input: FolderNameInput) {
        setMode(input?.mode ?? 'add');
        setName(input?.name ?? '');
    }

    function close(result: FolderNameResult) {
        ClosePopup(FOLDER_NAME_POPUP, result);
    }

    function save() {
        const trimmed = name.trim();
        if (trimmed === '') {
            close(null);
            return;
        }
        close(trimmed);
    }

    return (
        <Popup<FolderNameInput>
            id={FOLDER_NAME_POPUP}
            title={mode === 'add' ? 'Nouveau dossier' : 'Renommer le dossier'}
            width={420}
            onInputChange={handleOpen}
            onClosePopup={() => close(null)}
            onSubmit={save}
        >
            <TextInput
                placeholder='Nom du dossier'
                value={name}
                maxLength={NOTE_FOLDER_MAX_LENGTH}
                onChange={(e) => setName(e.target.value)}
            />
            <div className={styles.editorFooter} style={{ marginTop: 'var(--space-md)' }}>
                <span />
                <div className={styles.footerRight}>
                    <Button variant='secondary' onClick={() => close(null)}>
                        Annuler
                    </Button>
                    <Button onClick={save}>{mode === 'add' ? 'Créer' : 'Renommer'}</Button>
                </div>
            </div>
        </Popup>
    );
}
