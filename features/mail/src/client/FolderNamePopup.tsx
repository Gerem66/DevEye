import { useState } from 'react';

import { Button, ClosePopup, DialogCancelButton, Popup, TextInput } from 'deveye-sdk-client';

import styles from './style.module.css';

import { MAIL_FOLDER_NAME_MAX_LENGTH } from '../contracts/domain';

export const FOLDER_NAME_POPUP = 'popup-mail-folder-name';

export interface FolderNameInput {
    title: string;
    /** Le nom de départ : celui du dossier à renommer, vide pour en créer un. */
    name: string;
    confirmLabel: string;
}

/** Le nom saisi, sans ses espaces de bord, ou `null` sur annulation. */
export type FolderNameResult = string | null;

const DEFAULT_INPUT: FolderNameInput = { title: '', name: '', confirmLabel: 'Créer' };

/** Le nom d'un dossier à créer ou à renommer sur le serveur de mail. */
export function FolderNamePopup() {
    const [data, setData] = useState<FolderNameInput>(DEFAULT_INPUT);
    const [name, setName] = useState('');

    function close(result: FolderNameResult): void {
        ClosePopup(FOLDER_NAME_POPUP, result);
    }

    function save(): void {
        const trimmed = name.trim();
        if (trimmed !== '') close(trimmed);
    }

    return (
        <Popup<FolderNameInput | null>
            id={FOLDER_NAME_POPUP}
            title={data.title}
            width={420}
            onInputChange={(input) => {
                setData(input ?? DEFAULT_INPUT);
                setName(input?.name ?? '');
            }}
            onClosePopup={() => close(null)}
            onSubmit={save}
        >
            <TextInput
                placeholder='Nom du dossier'
                aria-label='Nom du dossier'
                value={name}
                maxLength={MAIL_FOLDER_NAME_MAX_LENGTH}
                onChange={(e) => setName(e.target.value)}
            />
            <div className={styles.popupActions}>
                <div className={styles.popupActionsLeft}>
                    <DialogCancelButton>Annuler</DialogCancelButton>
                </div>
                <Button onClick={save} disabled={name.trim() === ''}>
                    {data.confirmLabel}
                </Button>
            </div>
        </Popup>
    );
}

export default FolderNamePopup;
