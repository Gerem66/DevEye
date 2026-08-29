import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, FeatureSettingsButton, humanizeError, SelectInput } from 'deveye-sdk-client';
import type { GitCredential, GitRepo } from '../contracts/domain';

import { api } from './api';
import { RepoPicker, type RepoTarget } from './RepoPicker';
import styles from './style.module.css';

interface RepoDialogProps {
    open: boolean;
    /** Le dépôt modifié ; `null` = on en ajoute un. */
    repo: GitRepo | null;
    onClose: () => void;
    onSaved: (repoId: number) => void;
    /** Supprimer le dépôt. Absent à la création, ou en lecture seule. */
    onRemove?: () => void;
}

/**
 * Ajouter un dépôt à l'espace, ou changer ses réglages.
 *
 * `owner`/`repo` ne se modifient pas après coup : ce couple est l'identité du
 * dépôt (voir `slug_ref`), et le changer ferait d'une ligne existante un autre
 * dépôt, avec le cache du précédent.
 *
 * Il charge lui-même les jetons de l'espace, ce qui permet de l'ouvrir aussi bien
 * depuis la feature que depuis un projet. Ils se choisissent ici mais ne s'y
 * créent pas : ce sont les sources de la feature, gérées dans Réglages → Sources.
 */
export function RepoDialog({ open, repo, onClose, onSaved, onRemove }: RepoDialogProps) {
    const [credentials, setCredentials] = useState<GitCredential[] | null>(null);
    const [target, setTarget] = useState<RepoTarget>({ owner: '', repo: '', credentialId: null });
    const [enabled, setEnabled] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** La suppression emporte le cache : elle se confirme sur place. */
    const [confirmRemove, setConfirmRemove] = useState(false);
    /** La relecture complète coûte du temps et du quota : elle aussi. */
    const [confirmResync, setConfirmResync] = useState(false);
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
        setConfirmRemove(false);
        setConfirmResync(false);
        knownIds.current = null;
        setTarget({
            owner: repo?.owner ?? '',
            repo: repo?.repo ?? '',
            credentialId: repo?.credentialId ?? null
        });
        setEnabled(repo?.enabled ?? true);
        setError(null);
        void reloadCredentials();
    }, [open, repo, reloadCredentials]);

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

    /**
     * Vide le cache et relance une lecture complète. On referme derrière :
     * `git.repoResync` remet `lastSyncAt` à zéro, ce qui fait réapparaître le
     * voile de progression de `RepoView`, que le dialogue cacherait.
     */
    const resync = async () => {
        if (!repo || busy) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('git.repoResync', { repoId: repo.id });
            onSaved(repo.id);
        } catch (e) {
            setError(humanizeError(e, 'La resynchronisation n’a pas pu être lancée.'));
        } finally {
            setBusy(false);
        }
    };

    const submit = async () => {
        if (busy || !canSubmit) return;
        setBusy(true);
        setError(null);
        try {
            const res = repo
                ? await api.send('git.repoUpdate', {
                      repoId: repo.id,
                      credentialId: target.credentialId,
                      enabled
                  })
                : await api.send('git.repoAdd', {
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
            title={repo ? 'Modifier le dépôt' : 'Ajouter un dépôt'}
            width={560}
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || !canSubmit}>
                        {busy ? 'Enregistrement…' : repo ? 'Enregistrer' : 'Ajouter'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                {!repo && (
                    <RepoPicker
                        credentials={credentials ?? []}
                        value={target}
                        onChange={setTarget}
                        onSettingsOpenChange={onSettingsOpenChange}
                        autoFocus
                    />
                )}

                {/* En modification, `owner/repo` est figé, c'est l'identité du
                    dépôt, et seul le jeton reste réglable. */}
                {repo && (
                    <>
                        <p className={styles.repoName}>
                            <span className='icon icon-branch' /> {repo.owner}/{repo.repo}
                        </p>
                        <span className={styles.hint}>
                            Le couple propriétaire / dépôt est l’identité du dépôt : pour en viser un autre, ajoutez-le.
                        </span>

                        <label className={styles.field}>
                            <span className={styles.label}>Jeton d’accès</span>
                            <div className={styles.fieldWithAction}>
                                <SelectInput
                                    value={target.credentialId === null ? '' : String(target.credentialId)}
                                    onChange={(e) =>
                                        setTarget({
                                            ...target,
                                            credentialId: e.target.value ? Number(e.target.value) : null
                                        })
                                    }
                                >
                                    <option value=''>Aucun — synchronisation inactive</option>
                                    {(credentials ?? []).map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.label}
                                        </option>
                                    ))}
                                </SelectInput>
                                {/* Le bouton commun ouvre les réglages par-dessus,
                                    et le jeton qui y est créé est adopté au
                                    retour. */}
                                <FeatureSettingsButton
                                    scope={{ kind: 'feature', feature: 'git' }}
                                    initialSection='sources'
                                    variant='ghost'
                                    label='Jetons GitHub'
                                    onOpenChange={onSettingsOpenChange}
                                />
                            </div>
                            <span className={styles.hint}>
                                Un jeton en lecture seule suffit (<code>contents: read</code>). Les jetons se gèrent
                                dans Réglages → Sources (« Jetons GitHub » y mène) et servent à tous les dépôts.
                            </span>
                        </label>
                    </>
                )}

                {repo && (
                    <Checkbox checked={enabled} onChange={setEnabled}>
                        <>
                            <span className={styles.label}>Synchroniser ce dépôt</span>
                            <span className={styles.hint}>
                                Décoché, le dépôt reste dans la liste avec son historique, mais n’est plus relu.
                            </span>
                        </>
                    </Checkbox>
                )}

                {/* Relire tout l'historique, quand le « Synchroniser » de l'en-tête
                    reprend là où le service s'était arrêté. Ici et derrière une
                    confirmation : il coûte quelques minutes et quelques centaines
                    de requêtes au quota. */}
                {repo && (
                    <div className={styles.actionZone}>
                        <div className={styles.dangerText}>
                            <span className={styles.label}>Tout resynchroniser</span>
                            <span className={styles.hint}>
                                Vide l’historique mémorisé et le relit entièrement depuis GitHub — utile si le cache
                                paraît incomplet ou faux. Le rattachement des auteurs aux membres et les liaisons aux
                                projets sont conservés.
                            </span>
                        </div>
                        {confirmResync ? (
                            <div className={styles.actions}>
                                <Button variant='secondary' onClick={() => setConfirmResync(false)} disabled={busy}>
                                    Annuler
                                </Button>
                                <Button onClick={() => void resync()} disabled={busy}>
                                    Confirmer
                                </Button>
                            </div>
                        ) : (
                            <Button
                                variant='secondary'
                                icon='refresh'
                                onClick={() => setConfirmResync(true)}
                                disabled={busy}
                            >
                                Tout resynchroniser
                            </Button>
                        )}
                    </div>
                )}

                {onRemove && repo && (
                    <div className={styles.dangerZone}>
                        <div className={styles.dangerText}>
                            <span className={styles.label}>Supprimer ce dépôt</span>
                            <span className={styles.hint}>
                                Branches, commits, releases et pull requests mémorisés sont perdus, et les{' '}
                                {repo.projectCount > 0
                                    ? `${repo.projectCount} projet${repo.projectCount > 1 ? 's' : ''} qui l’utilisent perdent leur lien`
                                    : 'projets qui l’utiliseraient perdraient leur lien'}
                                . Le dépôt sur GitHub, lui, n’est pas touché.
                            </span>
                        </div>
                        {confirmRemove ? (
                            <div className={styles.actions}>
                                <Button variant='secondary' onClick={() => setConfirmRemove(false)} disabled={busy}>
                                    Annuler
                                </Button>
                                <Button variant='danger' onClick={onRemove} disabled={busy}>
                                    Confirmer
                                </Button>
                            </div>
                        ) : (
                            <Button variant='danger' onClick={() => setConfirmRemove(true)} disabled={busy}>
                                Supprimer
                            </Button>
                        )}
                    </div>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default RepoDialog;
