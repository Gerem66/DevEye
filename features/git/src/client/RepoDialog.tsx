import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, ErrorNote, errorNote, invalidate, type ErrorNoteInput } from 'deveye-sdk-client';
import type { GitCredential } from '../contracts/domain';

import { api } from './api';
import { RepoPicker, type RepoTarget } from './RepoPicker';
import styles from './style.module.css';

interface RepoDialogProps {
    open: boolean;
    onClose: () => void;
    onSaved: (repoIds: readonly number[]) => void;
}

/**
 * Ajouter des dépôts à l'espace. Rien d'autre : une fois ajouté, un dépôt se règle
 * dans l'onglet Général de sa fiche, comme tout élément.
 *
 * Il charge lui-même les jetons de l'espace, ce qui permet de l'ouvrir aussi bien
 * depuis la feature que depuis un projet. Ils se choisissent ici mais ne s'y
 * créent pas : ce sont les sources de la feature, gérées dans Réglages → Sources.
 */
export function RepoDialog({ open, onClose, onSaved }: RepoDialogProps) {
    const [credentials, setCredentials] = useState<GitCredential[] | null>(null);
    const [target, setTarget] = useState<RepoTarget>({ owner: '', repos: [], credentialId: null });
    const [busy, setBusy] = useState(false);
    /** Un bandeau par refus : chacun décide seul du signalement. */
    const [errors, setErrors] = useState<ErrorNoteInput[]>([]);
    /**
     * Les jetons connus au moment d'ouvrir les réglages : celui qui apparaît
     * ensuite vient d'y être créé pour ce dépôt, et se sélectionne tout seul.
     */
    const knownIds = useRef<Set<number> | null>(null);
    /** Les dépôts déjà ajoutés quand une partie de la sélection a été refusée : ils rejoignent le prochain `onSaved`. */
    const addedIds = useRef<number[]>([]);

    const reloadCredentials = useCallback(async (): Promise<GitCredential[]> => {
        try {
            const res = await api.send('git.credentialList', {});
            setCredentials(res.credentials);
            return res.credentials;
        } catch (e) {
            setCredentials([]);
            setErrors([errorNote(e, 'Impossible de charger les jetons de l’espace.')]);
            return [];
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        knownIds.current = null;
        addedIds.current = [];
        setTarget({ owner: '', repos: [], credentialId: null });
        setErrors([]);
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

    const names = target.repos.map((name) => name.trim()).filter((name) => name !== '');
    const canSubmit = target.owner.trim() !== '' && names.length > 0;

    /**
     * Un dépôt après l'autre, dans l'ordre : l'offre se vérifie à chaque ajout,
     * et un refus (quota atteint) n'arrête pas les suivants. Le dialogue reste
     * alors ouvert sur les seuls refusés, avec la raison de chacun.
     */
    const submit = async () => {
        if (busy || !canSubmit) return;
        setBusy(true);
        setErrors([]);
        const refused: { name: string; note: ErrorNoteInput }[] = [];
        for (const name of names) {
            try {
                const res = await api.send('git.repoAdd', {
                    provider: 'github',
                    owner: target.owner.trim(),
                    repo: name,
                    credentialId: target.credentialId
                });
                addedIds.current.push(res.repo.id);
            } catch (e) {
                refused.push({ name, note: errorNote(e, 'L’enregistrement a échoué.') });
            }
        }
        setBusy(false);
        // Les ajoutés sont dans l'espace même si l'on annule ensuite : la liste doit les montrer.
        if (refused.length < names.length) invalidate('git.list', 'git.count');
        if (refused.length === 0) {
            onSaved([...addedIds.current]);
            return;
        }
        setTarget((prev) => ({ ...prev, repos: refused.map((r) => r.name) }));
        setErrors(
            names.length === 1
                ? [refused[0].note]
                : refused.map((r) => ({ ...r.note, message: `${r.name} : ${r.note.message}` }))
        );
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
                        {busy ? 'Enregistrement…' : names.length > 1 ? `Ajouter ${names.length} dépôts` : 'Ajouter'}
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
                {errors.map((note, i) => (
                    <ErrorNote key={i} note={note} />
                ))}
            </div>
        </Dialog>
    );
}

export default RepoDialog;
