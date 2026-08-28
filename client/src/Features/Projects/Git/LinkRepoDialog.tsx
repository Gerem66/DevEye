import { useEffect, useState } from 'react';
import { GIT_CLIENT_PROVIDER } from '@deveye/types/sdk';
import type { GitClientProvider, GitLinkedCandidate } from '@deveye/types/sdk/client';
import { Button, Dialog, SelectInput } from '@/Components';
import { ws } from '@/api/ws';
import { moduleClientProvider } from '@/sdk/registry';
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

/**
 * Ajouter un dépôt au projet : en choisir un de l'espace, ou en créer un.
 *
 * **La création passe par le vrai dialogue de la feature** (`RepoDialog`, lu
 * par le contrat client du module Git), pas par une copie réduite : même parti
 * pris que `LinkDatabaseDialog` et `LinkTargetDialog`. Un dépôt se désigne par
 * un jeton, un propriétaire et un nom qu'il faut aller lire chez le
 * fournisseur ; en réécrire un formulaire ici garantirait qu'il diverge au
 * premier réglage ajouté. Ce dialogue-ci ne fait que l'ouvrir, puis relier ce
 * qu'il a créé. Module absent, le dialogue le dit et ne propose rien.
 *
 * `git.repoAdd` étant idempotente sur `owner/repo`, saisir par mégarde un dépôt
 * déjà présent le retrouve au lieu de le dupliquer. Un dépôt né dans un projet
 * n'est pas un dépôt de seconde classe : il rejoint la feature Git comme
 * n'importe quel autre.
 *
 * Rien n'est exclusif : un dépôt déjà utilisé par un autre projet peut être
 * choisi ici sans lui être retiré.
 */
export function LinkRepoDialog({ open, projectId, linkedRepoIds, onClose, onSaved }: LinkRepoDialogProps) {
    const provider = moduleClientProvider<GitClientProvider>(GIT_CLIENT_PROVIDER);
    const [repos, setRepos] = useState<readonly GitLinkedCandidate[]>([]);
    const [picked, setPicked] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** Le dialogue d'ajout de la feature, ouvert par-dessus celui-ci. */
    const [createOpen, setCreateOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        setPicked('');
        setError(null);
        if (!provider) return;
        void (async () => {
            try {
                setRepos(await provider.listRepos());
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les dépôts de l’espace.'));
            }
        })();
    }, [open, provider]);

    /** Ce qui reste à relier : un dépôt déjà là n'a rien à faire dans la liste. */
    const free = repos.filter((r) => !linkedRepoIds.includes(r.id));

    const link = async (repoId: number) => {
        setBusy(true);
        setError(null);
        try {
            await ws.send('project.repoLink', { projectId, repoId });
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'La liaison a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Dialog
                open={open && !createOpen}
                onClose={onClose}
                title='Ajouter un dépôt au projet'
                width={560}
                onSubmit={() => picked !== '' && void link(Number(picked))}
                footer={
                    <>
                        <Button variant='secondary' onClick={onClose} disabled={busy}>
                            Annuler
                        </Button>
                        <Button onClick={() => void link(Number(picked))} disabled={busy || picked === ''}>
                            {busy ? 'Enregistrement…' : 'Relier'}
                        </Button>
                    </>
                }
            >
                <div className={styles.form}>
                    {!provider ? (
                        <p className={styles.hint}>Le module Git n’est pas installé.</p>
                    ) : (
                        <>
                            <label className={styles.field}>
                                <span className={styles.label}>Dépôt de l’espace</span>
                                <SelectInput
                                    value={picked}
                                    disabled={free.length === 0}
                                    onChange={(e) => setPicked(e.target.value)}
                                >
                                    <option value=''>
                                        {free.length === 0 ? 'Aucun dépôt à relier' : 'Choisir un dépôt…'}
                                    </option>
                                    {free.map((r) => (
                                        <option key={r.id} value={r.id}>
                                            {r.owner}/{r.repo}
                                        </option>
                                    ))}
                                </SelectInput>
                                <span className={styles.hint}>
                                    Un dépôt peut servir plusieurs projets : en choisir un déjà utilisé ailleurs ne le
                                    retire à personne.
                                </span>
                            </label>

                            <div className={styles.actions}>
                                <Button
                                    variant='secondary'
                                    icon='add'
                                    onClick={() => setCreateOpen(true)}
                                    disabled={busy}
                                >
                                    Créer un dépôt
                                </Button>
                                <span className={styles.hint}>
                                    Il rejoindra la feature Git, où il sera visible et réutilisable par d’autres
                                    projets, et sera relié à ce projet dans la foulée.
                                </span>
                            </div>
                        </>
                    )}

                    {error && <p className={styles.error}>{error}</p>}
                </div>
            </Dialog>

            {/* Le vrai formulaire de la feature. Ce qu'il crée est relié
                immédiatement : sans cela, « Créer un dépôt » depuis un projet
                laisserait l'utilisateur devant une liste où il faut le
                rechercher, ce qui est exactement le geste qu'on lui épargne. */}
            {provider && (
                <provider.RepoDialog
                    open={createOpen}
                    onClose={() => setCreateOpen(false)}
                    onSaved={(repoId) => {
                        setCreateOpen(false);
                        void link(repoId);
                    }}
                />
            )}
        </>
    );
}

export default LinkRepoDialog;
