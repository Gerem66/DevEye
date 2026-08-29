import { useState } from 'react';

import styles from './style.module.css';

import { Button, ClosePopup, Popup, TextInput } from 'deveye-sdk-client';

import { NOTE_FOLDER_MAX_LENGTH } from '../contracts/domain';

export const FOLDER_NAME_POPUP = 'popup-folder-name';

export type FolderNameInput = { name: string; mode: 'add' | 'rename' } | null;
/** The trimmed name to save, or null on cancel. */
export type FolderNameResult = string | null;

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
