import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, humanizeError } from 'deveye-sdk-client';
import type { GitCredential } from '../contracts/domain';

import { api } from './api';
import { RepoPicker, type RepoTarget } from './RepoPicker';
import styles from './style.module.css';

interface RepoDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: (repoId: number) => void;
}

/**
 * Ajouter un dépôt à l'espace. Rien d'autre : une fois ajouté, un dépôt se règle
 * dans l'onglet Général de sa fiche, comme tout élément.
 *
 * Il charge lui-même les jetons de l'espace, ce qui permet de l'ouvrir aussi bien
 * depuis la feature que depuis un projet. Ils se choisissent ici mais ne s'y
 * créent pas : ce sont les sources de la feature, gérées dans Réglages → Sources.
 */
export function RepoDialog({ open, onClose, onSaved }: RepoDialogProps) {
    const [credentials, setCredentials] = useState<GitCredential[] | null>(null);
    const [target, setTarget] = useState<RepoTarget>({ owner: '', repo: '', credentialId: null });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /**
     * Les jetons connus au moment d'ouvrir les réglages : celui qui apparaît
     * ensuite vient d'y être créé pour ce dépôt, et se sélectionne tout seul.
     */
    const knownIds = useRef<Set<number> | null>(null);

    const reloadCredentials = useCallback(async (): Promise<GitCredential[]> => {
        try {
            const res = await api.send('git.credentialList', {});
            setCredentials(res.credentials);
            return res.credentials;
        } catch (e) {
            setCredentials([]);
            setError(humanizeError(e, 'Impossible de charger les jetons de l’espace.'));
            return [];
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        knownIds.current = null;
        setTarget({ owner: '', repo: '', credentialId: null });
        setError(null);
        void reloadCredentials();
    }, [open, reloadCredentials]);

    /**
     * À l'ouverture on photographie les jetons connus, à la fermeture on relit et
     * on adopte le nouveau venu. `knownIds` n'est posé qu'à l'ouverture, donc le
     * `false` que le bouton émet au montage et au démontage ne relit rien.
     */
    const onSettingsOpenChange = (opened: boolean) => {
        if (opened) {
            knownIds.current = new Set((credentials ?? []).map((c) => c.id));
            return;
        }
        if (knownIds.current === null) return;
        void reloadCredentials().then((list) => {
            const fresh = list.find((c) => !knownIds.current?.has(c.id));
            knownIds.current = null;
            if (fresh) setTarget((prev) => ({ ...prev, credentialId: fresh.id }));
        });
    };

    const canSubmit = target.owner.trim() !== '' && target.repo.trim() !== '';

    const submit = async () => {
        if (busy || !canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('git.repoAdd', {
                provider: 'github',
                owner: target.owner.trim(),
                repo: target.repo.trim(),
                credentialId: target.credentialId
            });
            onSaved(res.repo.id);
        } catch (e) {
            setError(humanizeError(e, 'L’enregistrement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Ajouter un dépôt'
            width={560}
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || !canSubmit}>
                        {busy ? 'Enregistrement…' : 'Ajouter'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <RepoPicker
                    credentials={credentials ?? []}
                    value={target}
                    onChange={setTarget}
                    onSettingsOpenChange={onSettingsOpenChange}
                    autoFocus
                />
                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default RepoDialog;
