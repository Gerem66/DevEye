import { useState } from 'react';
import Button from '@/Components/Button';
import Popup, { ClosePopup } from '@/Components/Popup';
import TextInput from '@/Components/TextInput';
import styles from './style.module.css';

export const CREATE_WORKSPACE_POPUP = 'popup-create-workspace';

/** Longueur retenue côté contrat (`workspace.add`). */
const NAME_MAX = 120;

/**
 * Création d'un espace de travail. Se résout avec le nom saisi, ou `null` si
 * l'utilisateur annule ; l'appelant se charge de l'appel serveur et de la
 * bascule.
 */
export default function CreateWorkspacePopup() {
    const [name, setName] = useState('');

    const close = (value: string | null): void => {
        setName('');
        ClosePopup(CREATE_WORKSPACE_POPUP, value);
    };

    const trimmed = name.trim();
    const submit = (): void => {
        if (!trimmed) return;
        close(trimmed);
    };

    return (
        <Popup
            id={CREATE_WORKSPACE_POPUP}
            title='Nouvel espace'
            width={420}
            onClosePopup={() => close(null)}
            onSubmit={submit}
        >
            <p className={styles.popupHint}>
                Un espace regroupe ses propres notes, mots de passe et réglages. Vous en êtes le propriétaire et pourrez
                y inviter d’autres personnes.
            </p>
            <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={NAME_MAX}
                placeholder='Nom de l’espace'
                aria-label='Nom de l’espace'
            />
            <div className={styles.popupActions}>
                <Button variant='secondary' onClick={() => close(null)}>
                    Annuler
                </Button>
                <Button onClick={submit} disabled={!trimmed}>
                    Créer
                </Button>
            </div>
        </Popup>
    );
}
