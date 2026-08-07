import { useEffect, useState } from 'react';
import type { ProjectCredential, ProjectRepo } from 'deveye-types';
import { PROJECT_CREDENTIAL_LABEL_MAX_LENGTH } from 'deveye-types';
import { Button, Dialog, SelectInput, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { humanizeError, withSecrecy } from '../api';
import styles from '../style.module.css';

interface RepoDialogProps {
    open: boolean;
    projectId: number;
    repo: ProjectRepo | null;
    credentials: ProjectCredential[];
    onClose: () => void;
    onSaved: () => void;
}

/**
 * Liaison d'un dépôt, et gestion des jetons d'accès de l'espace.
 *
 * Les deux sont dans le même dialogue parce qu'on ne peut pas faire l'un sans
 * l'autre la première fois : lier un dépôt privé sans jeton n'aboutirait à
 * rien, et faire naviguer l'utilisateur entre deux écrans pour ça serait une
 * perte de temps.
 *
 * Un jeton saisi n'est **jamais** relu : le serveur ne le renvoie pas. Le champ
 * reste donc vide à la ré-ouverture, et le laisser vide veut dire « garder
 * celui en place ».
 */
export function RepoDialog({ open, projectId, repo, credentials, onClose, onSaved }: RepoDialogProps) {
    const [owner, setOwner] = useState('');
    const [repoName, setRepoName] = useState('');
    const [credentialId, setCredentialId] = useState<string>('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const [showToken, setShowToken] = useState(false);
    const [label, setLabel] = useState('');
    const [secret, setSecret] = useState('');

    useEffect(() => {
        if (!open) return;
        setOwner(repo?.owner ?? '');
        setRepoName(repo?.repo ?? '');
        setCredentialId(repo?.credentialId === null || repo === null ? '' : String(repo.credentialId));
        setLabel('');
        setSecret('');
        setShowToken(false);
        setError(null);
    }, [open, repo]);

    const githubCredentials = credentials.filter((c) => c.provider === 'github');

    const addCredential = async () => {
        if (!label.trim() || !secret.trim()) return;
        setBusy(true);
        setError(null);
        try {
            const res = await ws.send('project.credentialAdd', {
                provider: 'github',
                label: label.trim(),
                baseUrl: null,
                secret: secret.trim()
            });
            setCredentialId(String(res.credential.id));
            setLabel('');
            setSecret('');
            setShowToken(false);
        } catch (e) {
            setError(humanizeError(e, 'Le jeton n’a pas pu être enregistré.'));
        } finally {
            setBusy(false);
        }
    };

    const submit = async () => {
        if (busy || !owner.trim() || !repoName.trim()) return;
        setBusy(true);
        setError(null);
        try {
            await withSecrecy(() =>
                ws.send('project.repoLink', {
                    projectId,
                    provider: 'github',
                    owner: owner.trim(),
                    repo: repoName.trim(),
                    credentialId: credentialId ? Number(credentialId) : null
                })
            );
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'La liaison a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={repo ? 'Modifier le dépôt lié' : 'Lier un dépôt'}
            width={560}
            onSubmit={submit}
            holdSecrecy
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || !owner.trim() || !repoName.trim()}>
                        {busy ? 'Enregistrement…' : repo ? 'Enregistrer' : 'Lier'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <div className={styles.row}>
                    <label className={styles.field}>
                        <span className={styles.label}>Propriétaire</span>
                        <TextInput
                            data-autofocus
                            value={owner}
                            placeholder='gerem66'
                            onChange={(e) => setOwner(e.target.value)}
                        />
                    </label>
                    <label className={styles.field}>
                        <span className={styles.label}>Dépôt</span>
                        <TextInput
                            value={repoName}
                            placeholder='DevEye'
                            onChange={(e) => setRepoName(e.target.value)}
                        />
                    </label>
                </div>

                <label className={styles.field}>
                    <span className={styles.label}>Jeton d’accès</span>
                    <SelectInput value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                        <option value=''>Aucun — dépôt public uniquement</option>
                        {githubCredentials.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.label}
                            </option>
                        ))}
                    </SelectInput>
                    <span className={styles.hint}>
                        Un jeton en lecture seule suffit (`contents: read`). Sans jeton, la synchronisation reste
                        inactive : elle a besoin d’un accès authentifié.
                    </span>
                </label>

                {!showToken && (
                    <Button variant='ghost' icon='add' onClick={() => setShowToken(true)}>
                        Ajouter un jeton
                    </Button>
                )}

                {showToken && (
                    <div className={styles.tokenBox}>
                        <label className={styles.field}>
                            <span className={styles.label}>Nom du jeton</span>
                            <TextInput
                                value={label}
                                maxLength={PROJECT_CREDENTIAL_LABEL_MAX_LENGTH}
                                placeholder='GitHub — perso'
                                onChange={(e) => setLabel(e.target.value)}
                            />
                        </label>
                        <label className={styles.field}>
                            <span className={styles.label}>Jeton</span>
                            {/* `enableShowHideButton` : un jeton se relit une fois
                                à la saisie, jamais après — le serveur ne le
                                renverra pas. */}
                            <TextInput
                                type='password'
                                enableShowHideButton
                                value={secret}
                                placeholder='ghp_…'
                                onChange={(e) => setSecret(e.target.value)}
                            />
                        </label>
                        <div className={styles.actions}>
                            <Button variant='secondary' onClick={() => setShowToken(false)} disabled={busy}>
                                Annuler
                            </Button>
                            <Button
                                onClick={() => void addCredential()}
                                disabled={busy || !label.trim() || !secret.trim()}
                            >
                                Enregistrer le jeton
                            </Button>
                        </div>
                    </div>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default RepoDialog;
