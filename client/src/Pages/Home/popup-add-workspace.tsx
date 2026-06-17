import { useState } from 'react';

import { ws, WsError } from '@/api/ws';
import { useAuth } from '@/auth/AuthProvider';
import Popup, { ClosePopup } from '@/Components/Popup';
import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';
import styles from './style.module.css';

import type { Workspace } from 'deveye-types';

interface AddWorkspacePopupProps {
    onCreated?: (workspace: Workspace) => void;
}

function AddWorkspacePopup({ onCreated }: AddWorkspacePopupProps) {
    const { setWorkspaces } = useAuth();
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const close = () => {
        setName('');
        setError('');
        ClosePopup('popup-add-workspace');
    };

    const submit = async () => {
        const trimmed = name.trim();
        if (trimmed === '') {
            setError("Le nom de l'entreprise ne peut pas être vide");
            return;
        }
        if (submitting) return;
        setSubmitting(true);
        setError('');
        try {
            const res = await ws.send('workspace.add', { name: trimmed });
            setWorkspaces((prev) => [...prev, res.workspace]);
            onCreated?.(res.workspace);
            setName('');
            ClosePopup('popup-add-workspace');
        } catch (e) {
            setError(e instanceof WsError ? e.message : "Erreur lors de l'ajout de l'entreprise");
        } finally {
            setSubmitting(false);
        }
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') void submit();
    };

    return (
        <Popup id='popup-add-workspace' title='Ajouter une entreprise' onClosePopup={close}>
            <p className={styles.popupHint}>Quel est le nom de la nouvelle entreprise ?</p>

            <TextInput
                placeholder='Entreprise X'
                value={name}
                error={error}
                onChange={(e) => {
                    setName(e.target.value);
                    setError('');
                }}
                onKeyDown={onKeyDown}
            />

            <div className={styles.popupActions}>
                <Button variant='secondary' onClick={close}>
                    Fermer
                </Button>
                <Button onClick={submit} disabled={submitting}>
                    {submitting ? '…' : 'Créer'}
                </Button>
            </div>
        </Popup>
    );
}

export default AddWorkspacePopup;
