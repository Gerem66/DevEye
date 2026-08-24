import { useEffect, useState } from 'react';
import type { Credential, GitRepo } from '@deveye/types';
import { Button, Dialog, SelectInput } from '@/Components';
import { ws } from '@/api/ws';
import { RepoPicker, type RepoTarget } from '@/Features/Git/RepoPicker';
import { humanizeError } from '../api';
import styles from '../style.module.css';

interface LinkRepoDialogProps {
    open: boolean;
    projectId: number;
    /** Les dépôts déjà reliés : ils sortent de la liste des choix possibles. */
    linkedRepoIds: number[];
    onClose: () => void;
    onSaved: () => void;
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
export function LinkRepoDialog({ open, projectId, linkedRepoIds, onClose, onSaved }: LinkRepoDialogProps) {
    const [repos, setRepos] = useState<GitRepo[]>([]);
    const [credentials, setCredentials] = useState<Credential[]>([]);
    const [mode, setMode] = useState<Mode>('pick');
    const [picked, setPicked] = useState('');
    const [target, setTarget] = useState<RepoTarget>({ owner: '', repo: '', credentialId: null });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setPicked('');
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
                // Rien à choisir — espace vide, ou tout déjà relié — : on ouvre
                // directement sur la création.
                setMode(list.repos.some((r) => !linkedRepoIds.includes(r.id)) ? 'pick' : 'create');
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les dépôts de l’espace.'));
            }
        })();
    }, [open]);

    /** Ce qui reste à relier : un dépôt déjà là n'a rien à faire dans la liste. */
    const free = repos.filter((r) => !linkedRepoIds.includes(r.id));

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
            title='Ajouter un dépôt au projet'
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
                {free.length > 0 && (
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
                            {free.map((r) => (
                                <option key={r.id} value={r.id}>
                                    {r.owner}/{r.repo}
                                    {r.projectCount > 0 &&
                                        ` — ${r.projectCount} projet${r.projectCount > 1 ? 's' : ''}`}
                                </option>
                            ))}
                        </SelectInput>
                        <span className={styles.hint}>
                            Un dépôt peut servir plusieurs projets : en choisir un déjà utilisé ailleurs ne le retire à
                            personne.
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

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default LinkRepoDialog;
