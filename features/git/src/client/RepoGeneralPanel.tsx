import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    Checkbox,
    ConfirmDialog,
    FeatureSettingsButton,
    humanizeError,
    invalidate,
    ReadOnlyNotice,
    SaveButton,
    SelectInput,
    settingsStyles as shell,
    type ConfirmRequest
} from 'deveye-sdk-client';
import type { SettingsPanelProps } from '@deveye/types/sdk/client';
import type { GitCredential, GitRepo } from '../contracts/domain';

import { api } from './api';

/**
 * Le dépôt lui-même : son jeton, sa synchronisation, sa relecture complète et
 * sa suppression. L'onglet Général de ses réglages, là où le bouton commun mène.
 *
 * C'est le formulaire qui vivait dans un dialogue « Modifier », à côté du bouton
 * de réglages : deux portes pour régler une même chose. Le dialogue ne sert plus
 * qu'à AJOUTER un dépôt, geste qui n'a pas d'élément à viser.
 *
 * `owner`/`repo` ne se modifient pas : ce couple est l'identité du dépôt (voir
 * `slug_ref`), et le changer ferait d'une ligne existante un autre dépôt, avec
 * le cache du précédent.
 */
export default function RepoGeneralPanel({ scope, canWrite, close, gone }: SettingsPanelProps) {
    const repoId = scope.kind === 'item' ? Number(scope.itemId) : null;
    const [repo, setRepo] = useState<GitRepo | null>(null);
    const [credentials, setCredentials] = useState<GitCredential[]>([]);
    const [credentialId, setCredentialId] = useState<number | null>(null);
    const [enabled, setEnabled] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    /**
     * Les jetons connus au moment d'ouvrir les réglages de la feature : celui
     * qui apparaît ensuite vient d'y être créé pour ce dépôt, et se sélectionne
     * tout seul au retour.
     */
    const knownIds = useRef<Set<number> | null>(null);

    const loadCredentials = useCallback(async (): Promise<GitCredential[]> => {
        const res = await api.send('git.credentialList', {});
        setCredentials(res.credentials);
        return res.credentials;
    }, []);

    useEffect(() => {
        if (repoId === null) return;
        void (async () => {
            try {
                const [res] = await Promise.all([api.send('git.repoGet', { repoId }), loadCredentials()]);
                setRepo(res.repo);
                setCredentialId(res.repo.credentialId);
                setEnabled(res.repo.enabled);
            } catch (e) {
                setError(humanizeError(e, 'Le dépôt n’a pas pu être lu.'));
            }
        })();
    }, [repoId, loadCredentials]);

    /**
     * À l'ouverture on photographie les jetons connus, à la fermeture on relit et
     * on adopte le nouveau venu. `knownIds` n'est posé qu'à l'ouverture, donc le
     * `false` que le bouton émet au montage et au démontage ne relit rien.
     */
    const onSettingsOpenChange = (opened: boolean) => {
        if (opened) {
            knownIds.current = new Set(credentials.map((c) => c.id));
            return;
        }
        if (knownIds.current === null) return;
        void loadCredentials()
            .then((list) => {
                const fresh = list.find((c) => !knownIds.current?.has(c.id));
                if (fresh) setCredentialId(fresh.id);
            })
            .catch(() => setError('Impossible de relire les jetons de l’espace.'))
            .finally(() => {
                knownIds.current = null;
            });
    };

    const save = async () => {
        if (!repo) return;
        setError(null);
        try {
            const res = await api.send('git.repoUpdate', { repoId: repo.id, credentialId, enabled });
            setRepo(res.repo);
            invalidate('git.list', 'git.repo', 'git.count');
        } catch (e) {
            setError(humanizeError(e, 'L’enregistrement a échoué.'));
            // Relancé : le bouton n'annonce « Enregistré » que sur un succès.
            throw e;
        }
    };

    /**
     * Vide le cache et relance une lecture complète. La coquille se referme
     * derrière : `git.repoResync` remet `lastSyncAt` à zéro, ce qui fait
     * réapparaître le voile de progression de la fiche, que le dialogue cacherait.
     */
    const resync = async () => {
        if (!repo) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('git.repoResync', { repoId: repo.id });
            invalidate('git.list', 'git.repo');
            close();
        } catch (e) {
            setError(humanizeError(e, 'La resynchronisation n’a pas pu être lancée.'));
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!repo) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('git.repoRemove', { repoId: repo.id });
            // La fiche s'en va AVANT que la liste ne se relise : relue après
            // coup, elle chercherait un dépôt qui n'existe plus.
            gone();
            invalidate('git.list', 'git.count', 'projects.board');
        } catch (e) {
            setError(humanizeError(e, 'La suppression a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    if (!repo) {
        return <p className={error ? shell.notice : shell.empty}>{error ?? 'Chargement…'}</p>;
    }

    // Le jeton d'un dépôt se choisit parmi les clés de son espace : le serveur
    // refuse la modification d'un dépôt étranger.
    if (repo.foreign) {
        return (
            <p className={shell.sectionHint}>
                Ce dépôt vient d’un autre espace : son jeton, sa synchronisation et sa suppression se règlent depuis
                là-bas.
            </p>
        );
    }

    const editable = canWrite && !busy;
    const unchanged = credentialId === repo.credentialId && enabled === repo.enabled;
    const projects =
        repo.projectCount > 0
            ? `les ${repo.projectCount} projet${repo.projectCount > 1 ? 's' : ''} qui l’utilisent perdent leur lien`
            : 'les projets qui l’utiliseraient perdraient leur lien';

    return (
        <div className={shell.section}>
            <div className={shell.field}>
                <span className={shell.sectionLabel}>Dépôt</span>
                <span className={shell.fieldLabel}>
                    {repo.owner}/{repo.repo}
                </span>
                <span className={shell.fieldHint}>
                    Le couple propriétaire / dépôt est l’identité du dépôt : pour en viser un autre, ajoutez-le.
                </span>
            </div>

            <div className={shell.field}>
                <span className={shell.sectionLabel}>Jeton d’accès</span>
                <div className={shell.fieldWithAction}>
                    <SelectInput
                        value={credentialId === null ? '' : String(credentialId)}
                        disabled={!editable}
                        aria-label='Jeton d’accès'
                        onChange={(e) => setCredentialId(e.target.value ? Number(e.target.value) : null)}
                    >
                        <option value=''>Aucun : synchronisation inactive</option>
                        {credentials.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.label}
                            </option>
                        ))}
                    </SelectInput>
                    {/* Le bouton commun ouvre les réglages de la feature par-dessus,
                        et le jeton qui y est créé est adopté au retour. */}
                    {canWrite && (
                        <FeatureSettingsButton
                            scope={{ kind: 'feature', feature: 'git' }}
                            initialSection='sources'
                            variant='ghost'
                            label='Jetons GitHub'
                            onOpenChange={onSettingsOpenChange}
                        />
                    )}
                </div>
                <span className={shell.fieldHint}>
                    Un jeton en lecture seule suffit (contents: read). Les jetons se gèrent dans Réglages → Sources et
                    servent à tous les dépôts.
                </span>
            </div>

            <Checkbox checked={enabled} disabled={!editable} onChange={setEnabled}>
                <>
                    <span className={shell.fieldLabel}>Synchroniser ce dépôt</span>
                    <span className={shell.fieldHint}>
                        Décoché, le dépôt reste dans la liste avec son historique, mais n’est plus relu.
                    </span>
                </>
            </Checkbox>

            {canWrite ? (
                <div className={shell.sectionActions}>
                    <SaveButton onSave={save} disabled={busy || unchanged} />
                </div>
            ) : (
                <ReadOnlyNotice>
                    Votre rôle ne permet pas de modifier un dépôt : cela relève de l’écriture sur Git.
                </ReadOnlyNotice>
            )}

            {/* Relire tout l'historique, quand « Synchroniser » sur la fiche
                reprend là où le service s'était arrêté. Derrière une
                confirmation : il coûte quelques minutes et quelques centaines de
                requêtes au quota. */}
            {canWrite && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Tout resynchroniser</span>
                    <span className={shell.fieldHint}>
                        Vide l’historique mémorisé et le relit entièrement depuis GitHub, utile si le cache paraît
                        incomplet ou faux. Le rattachement des auteurs aux membres et les liaisons aux projets sont
                        conservés.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='secondary'
                            icon='refresh'
                            disabled={busy}
                            onClick={() =>
                                setConfirm({
                                    title: `Tout resynchroniser « ${repo.owner}/${repo.repo} » ?`,
                                    description:
                                        'L’historique mémorisé est vidé puis relu entièrement depuis GitHub : quelques minutes, et quelques centaines de requêtes au quota du jeton.',
                                    confirmLabel: 'Resynchroniser',
                                    tone: 'primary',
                                    onConfirm: () => void resync()
                                })
                            }
                        >
                            Tout resynchroniser
                        </Button>
                    </div>
                </div>
            )}

            {canWrite && (
                <div className={shell.field}>
                    <span className={shell.sectionLabel}>Supprimer ce dépôt</span>
                    <span className={shell.fieldHint}>
                        Branches, commits, releases et pull requests mémorisés sont perdus, et {projects}. Le dépôt sur
                        GitHub, lui, n’est pas touché.
                    </span>
                    <div className={shell.sectionActions}>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() =>
                                setConfirm({
                                    title: `Supprimer « ${repo.owner}/${repo.repo} » ?`,
                                    description: `L’historique mémorisé est perdu, et ${projects}. Le dépôt sur GitHub n’est pas touché.`,
                                    confirmLabel: 'Supprimer le dépôt',
                                    onConfirm: () => void remove()
                                })
                            }
                        >
                            Supprimer le dépôt
                        </Button>
                    </div>
                </div>
            )}

            {error && <p className={shell.notice}>{error}</p>}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
