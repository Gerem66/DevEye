import { useEffect, useState } from 'react';
import type { GitCredential, GitRepo } from 'deveye-types';
import { Button, Dialog, SelectInput } from '@/Components';
import { ws } from '@/api/ws';
import { RepoPicker, type RepoTarget } from '@/Features/Git/RepoPicker';
import gitStyles from '@/Features/Git/style.module.css';
import { humanizeError } from '../api';
import styles from '../style.module.css';

interface LinkRepoDialogProps {
    open: boolean;
    projectId: number;
    /** Le dépôt actuellement pointé, s'il y en a un. */
    linkedRepoId: number | null;
    onClose: () => void;
    onSaved: () => void;
    /** Retirer la liaison. Absent quand rien n'est lié, ou en lecture seule. */
    onUnlink?: () => void;
}

/** Deux façons d'arriver au même endroit : pointer l'existant, ou en créer un. */
type Mode = 'pick' | 'create';

/**
 * Relier un dépôt de l'espace au projet.
 *
 * **Les jetons ne se créent plus ici.** Ils appartiennent à l'espace, servent
 * plusieurs dépôts et plusieurs cibles de déploiement, et n'étaient de toute
 * façon ni modifiables ni supprimables depuis cet écran. Ils vivent maintenant
 * dans la feature Git ; le sélecteur, lui, reste — c'est le geste courant.
 *
 * Deux modes, parce qu'il y a deux situations réelles :
 *
 * - **Choisir** un dépôt déjà présent dans l'espace, y compris un dépôt qu'un
 *   autre projet utilise déjà : rien n'est exclusif ;
 * - **Ajouter** un dépôt que l'espace ne connaît pas encore. Il rejoint alors
 *   la feature Git comme n'importe quel autre — un dépôt né dans un projet
 *   n'est pas un dépôt de seconde classe.
 *
 * `git.repoAdd` étant idempotente sur `owner/repo`, saisir par mégarde un dépôt
 * déjà présent le retrouve au lieu de le dupliquer.
 */
export function LinkRepoDialog({ open, projectId, linkedRepoId, onClose, onSaved, onUnlink }: LinkRepoDialogProps) {
    const [repos, setRepos] = useState<GitRepo[]>([]);
    const [credentials, setCredentials] = useState<GitCredential[]>([]);
    const [mode, setMode] = useState<Mode>('pick');
    const [picked, setPicked] = useState('');
    const [target, setTarget] = useState<RepoTarget>({ owner: '', repo: '', credentialId: null });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmUnlink, setConfirmUnlink] = useState(false);

    useEffect(() => {
        if (!open) return;
        setConfirmUnlink(false);
        setPicked(linkedRepoId === null ? '' : String(linkedRepoId));
        setTarget({ owner: '', repo: '', credentialId: null });
        setError(null);
        void (async () => {
            try {
                const [list, creds] = await Promise.all([
                    ws.send('git.repoList', {}),
                    ws.send('git.credentialList', {})
                ]);
                setRepos(list.repos);
                setCredentials(creds.credentials.filter((c) => c.provider === 'github'));
                // Un espace sans aucun dépôt n'a rien à faire choisir : on ouvre
                // directement sur la création.
                setMode(list.repos.length === 0 ? 'create' : 'pick');
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les dépôts de l’espace.'));
            }
        })();
    }, [open, linkedRepoId]);

    const canSubmit = mode === 'pick' ? picked !== '' : target.owner.trim() !== '' && target.repo.trim() !== '';

    const submit = async () => {
        if (busy || !canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            const repoId =
                mode === 'pick'
                    ? Number(picked)
                    : (
                          await ws.send('git.repoAdd', {
                              provider: 'github',
                              owner: target.owner.trim(),
                              repo: target.repo.trim(),
                              credentialId: target.credentialId
                          })
                      ).repo.id;
            await ws.send('project.repoLink', { projectId, repoId });
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
            title={linkedRepoId === null ? 'Relier un dépôt' : 'Modifier le dépôt relié'}
            width={560}
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || !canSubmit}>
                        {busy ? 'Enregistrement…' : 'Relier'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                {repos.length > 0 && (
                    <div className={styles.tabs}>
                        <button
                            type='button'
                            className={mode === 'pick' ? styles.tabActive : styles.tab}
                            onClick={() => setMode('pick')}
                        >
                            Dépôt existant
                        </button>
                        <button
                            type='button'
                            className={mode === 'create' ? styles.tabActive : styles.tab}
                            onClick={() => setMode('create')}
                        >
                            Nouveau dépôt
                        </button>
                    </div>
                )}

                {mode === 'pick' && (
                    <label className={styles.field}>
                        <span className={styles.label}>Dépôt de l’espace</span>
                        <SelectInput value={picked} onChange={(e) => setPicked(e.target.value)}>
                            <option value=''>Choisir un dépôt…</option>
                            {repos.map((r) => (
                                <option key={r.id} value={r.id}>
                                    {r.owner}/{r.repo}
                                    {r.projectCount > 0 &&
                                        ` — ${r.projectCount} projet${r.projectCount > 1 ? 's' : ''}`}
                                </option>
                            ))}
                        </SelectInput>
                        <span className={styles.hint}>
                            Un dépôt peut servir plusieurs projets : en choisir un déjà utilisé ne le retire à personne.
                        </span>
                    </label>
                )}

                {mode === 'create' && (
                    <>
                        {/* Le même sélecteur que la feature Git : jeton d'abord —
                            il décide de ce que la liste peut montrer — puis
                            propriétaire, puis dépôt. */}
                        <RepoPicker credentials={credentials} value={target} onChange={setTarget} autoFocus />

                        <span className={styles.hint}>
                            Ce dépôt rejoindra la liste de la feature Git, où il sera visible et réutilisable par
                            d’autres projets.
                        </span>
                    </>
                )}

                {/* Le déliement vit ici, avec les autres réglages de la liaison,
                    et non dans l'en-tête de l'onglet : une action destructrice
                    n'a pas à côtoyer « Synchroniser », qu'on presse souvent. */}
                {onUnlink && (
                    <div className={gitStyles.dangerZone}>
                        <div className={gitStyles.dangerText}>
                            <span className={styles.label}>Délier ce dépôt</span>
                            <span className={styles.hint}>
                                Le projet perd son dépôt. Le dépôt lui-même, son historique et les autres projets qui
                                l’utilisent ne sont pas touchés.
                            </span>
                        </div>
                        {confirmUnlink ? (
                            <div className={styles.actions}>
                                <Button variant='secondary' onClick={() => setConfirmUnlink(false)} disabled={busy}>
                                    Annuler
                                </Button>
                                <Button variant='danger' onClick={onUnlink} disabled={busy}>
                                    Confirmer
                                </Button>
                            </div>
                        ) : (
                            <Button variant='danger' onClick={() => setConfirmUnlink(true)} disabled={busy}>
                                Délier
                            </Button>
                        )}
                    </div>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default LinkRepoDialog;
