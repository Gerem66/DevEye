import { useCallback, useEffect, useRef, useState } from 'react';
import type { GitCredential, GitRepo, GitRepoSyncState, GitRepoUsage } from 'deveye-types';
import { Button } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import { startTeleport } from '@/stores/live';
import { useLiveSegment } from '@/live/useLiveSegment';
import { useLiveOutlines } from '@/live/useLiveOutline';
import type { FeatureProps } from '@/Features/types';
import { humanizeError } from '../Projects/api';
import RepoDetail from './RepoDetail';
import RepoDialog from './RepoDialog';
import RepoList from './RepoList';
import CredentialsDialog from './CredentialsDialog';
import styles from './style.module.css';

/**
 * Cadence du sondage d'avancement de la liste.
 *
 * La commande sondée ne lit qu'une table en mémoire du service : ni requête, ni
 * déchiffrement. À ce prix-là, une seconde et demie donne une barre qui avance
 * visiblement sans rien coûter — même cadence, et même raison, que celle d'une
 * synchro mail.
 */
const SYNC_POLL_MS = 1_500;

/**
 * Git — les dépôts de l'espace actif.
 *
 * Feature de premier rang, et non un onglet des Projets : un dépôt appartient à
 * l'espace, plusieurs projets peuvent s'en servir, et certains ne servent aucun
 * projet du tout. Un projet ne fait qu'y **pointer**.
 *
 * Rien ici n'est chiffré à l'étage gardé : le dépôt et son cache vivent sous la
 * clé de l'espace, donc cette feature ne demande jamais de mot de passe.
 */
export function FeatureGit({ workspace }: FeatureProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('git', 'write');

    const [repos, setRepos] = useState<GitRepo[] | null>(null);
    const [credentials, setCredentials] = useState<GitCredential[]>([]);
    const [error, setError] = useState<string | null>(null);

    /** Le dépôt ouvert ; `null` = on est sur la liste. */
    const [openedId, setOpenedId] = useState<number | null>(null);
    const [opened, setOpened] = useState<{ repo: GitRepo; usage: GitRepoUsage[] } | null>(null);

    const [repoDialog, setRepoDialog] = useState<{ repo: GitRepo | null } | null>(null);
    const [credentialsOpen, setCredentialsOpen] = useState(false);
    const [busy, setBusy] = useState(false);

    /**
     * Les synchronisations en cours, par dépôt.
     *
     * Sondées et non diffusées : les six étapes d'un tour feraient sinon
     * re-solliciter toute la liste six fois d'affilée chez **tous** les membres
     * de l'espace. La commande ne lit qu'une table en mémoire du service —
     * aucune requête, aucun déchiffrement — ce qui rend cette cadence
     * négligeable. Même arbitrage que la barre d'une synchro mail (LIVE.md).
     */
    const [syncing, setSyncing] = useState<Map<number, GitRepoSyncState>>(new Map());

    const listVersion = useResourceVersion('git.list');
    const repoVersion = useResourceVersion('git.repo');
    const reloadRef = useRef<Promise<void> | null>(null);

    /** Un glisser-déposer est en cours : la liste ne doit pas bouger dessous. */
    const dragging = useRef(false);
    /** Une relecture est tombée pendant un glissé : elle attend la fin. */
    const pendingReload = useRef(false);

    // Présence : « qui regarde quel dépôt ». Un seul déclarant par niveau —
    // ce composant possède `l1`, et rien d'autre dans la feature n'y touche.
    useLiveSegment('l1', openedId === null ? null : `repo:${openedId}`);
    const outlineFor = useLiveOutlines('l1');

    const reload = useCallback(async () => {
        if (reloadRef.current) return reloadRef.current;
        const task = (async () => {
            try {
                const [list, creds] = await Promise.all([
                    ws.send('git.repoList', {}),
                    ws.send('git.credentialList', {})
                ]);
                setRepos(list.repos);
                setCredentials(creds.credentials);
                setError(null);
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger les dépôts.'));
            }
        })();
        reloadRef.current = task;
        try {
            await task;
        } finally {
            reloadRef.current = null;
        }
    }, []);

    useEffect(() => {
        // Une relecture réordonne la liste sous le pointeur : jamais pendant un
        // glissé. Elle est retenue et rejouée au relâchement.
        if (dragging.current) {
            pendingReload.current = true;
            return;
        }
        setRepos(null);
        void reload();
        // `listVersion` rejoue l'effet quand la ressource est invalidée — par
        // notre propre écriture, ou par `live.changed` venu d'ailleurs.
    }, [reload, workspace.id, listVersion]);

    const onDragStateChange = useCallback(
        (active: boolean) => {
            dragging.current = active;
            if (!active && pendingReload.current) {
                pendingReload.current = false;
                void reload();
            }
        },
        [reload]
    );

    /**
     * Applique un dépôt : on range d'abord localement, pour que la carte reste
     * là où on l'a lâchée sans aller-retour, puis on persiste. Un échec revient
     * au serveur, seul détenteur de l'ordre réellement enregistré.
     */
    const reorder = useCallback(
        (ids: number[]) => {
            setRepos((prev) => {
                if (!prev) return prev;
                const byId = new Map(prev.map((r) => [r.id, r]));
                return ids.flatMap((id) => byId.get(id) ?? []);
            });
            ws.send('git.repoReorder', { ids }).catch(() => {
                setError('Réorganisation impossible.');
                void reload();
            });
        },
        [reload]
    );

    useEffect(() => {
        let alive = true;
        /** Y avait-il quelque chose en cours au tour précédent ? */
        let had = false;

        const tick = async () => {
            try {
                const res = await ws.send('git.syncStatuses', {});
                if (!alive) return;
                setSyncing(new Map(res.statuses.map((st) => [st.repoId, st])));
                // La dernière synchronisation vient de s'achever : c'est
                // maintenant que la liste a du neuf à montrer (dates, compteurs).
                if (had && res.statuses.length === 0) invalidate('git.list', 'git.count');
                had = res.statuses.length > 0;
            } catch {
                // Une coupure ne doit pas figer des bandes de progression à
                // l'écran : on repart d'une liste vide, le tour suivant corrigera.
                if (alive) setSyncing(new Map());
            }
        };

        void tick();
        const timer = setInterval(() => void tick(), SYNC_POLL_MS);
        return () => {
            alive = false;
            clearInterval(timer);
        };
    }, [workspace.id]);

    /** Charge le dépôt ouvert et les projets qui s'en servent. */
    const loadOpened = useCallback(async (repoId: number) => {
        try {
            const res = await ws.send('git.repoGet', { repoId });
            setOpened({ repo: res.repo, usage: res.usage });
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible d’ouvrir ce dépôt.'));
            setOpenedId(null);
            setOpened(null);
        }
    }, []);

    useEffect(() => {
        if (openedId === null) {
            setOpened(null);
            return;
        }
        void loadOpened(openedId);
    }, [openedId, loadOpened, repoVersion]);

    const syncNow = async (repoId: number) => {
        setBusy(true);
        try {
            await ws.send('git.repoSyncNow', { repoId });
            // La vue du dépôt prend le relais : elle sonde l'avancement et pose
            // son voile. Ici on ne fait que déclencher.
            invalidate('git.repo');
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'La synchronisation n’a pas pu être lancée.'));
        } finally {
            setBusy(false);
        }
    };

    const removeRepo = async (repoId: number) => {
        setBusy(true);
        try {
            await ws.send('git.repoRemove', { repoId });
            setRepoDialog(null);
            setOpenedId(null);
            invalidate('git.list', 'git.count', 'project.board');
        } catch (e) {
            setError(humanizeError(e, 'La suppression a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    /**
     * Ouvre un projet qui utilise ce dépôt, dans la feature Projets.
     *
     * Par la **téléportation** — le mécanisme que la présence utilise déjà pour
     * « rejoindre quelqu'un » — plutôt que par un canal de navigation dédié :
     * un chemin `view:projets l1:project:12` dit exactement « ouvre Projets, et
     * dedans, ce projet-là », et l'accueil sait déjà l'appliquer, garde d'accès
     * comprise. Écrire un second mécanisme pour le même besoin aurait été en
     * maintenir deux.
     */
    const openProject = (projectId: number) => {
        startTeleport(workspace.id, ['view:projects', `l1:project:${projectId}`]);
    };

    if (opened) {
        return (
            <>
                <RepoDetail
                    repo={opened.repo}
                    usage={opened.usage}
                    members={workspace.users}
                    canWrite={canWrite}
                    busy={busy}
                    onBack={() => setOpenedId(null)}
                    onEdit={() => setRepoDialog({ repo: opened.repo })}
                    onSyncNow={() => void syncNow(opened.repo.id)}
                    onOpenProject={openProject}
                />
                <RepoDialog
                    open={repoDialog !== null}
                    repo={repoDialog?.repo ?? null}
                    credentials={credentials}
                    onClose={() => setRepoDialog(null)}
                    onSaved={() => {
                        setRepoDialog(null);
                        invalidate('git.list', 'git.repo', 'git.count');
                    }}
                    onRemove={canWrite ? () => void removeRepo(opened.repo.id) : undefined}
                />
            </>
        );
    }

    return (
        <div className={styles.root}>
            <header className={styles.header}>
                <div>
                    <h2 className={styles.heading}>Dépôts Git</h2>
                    {repos && (
                        <p className={styles.subheading}>
                            {repos.length} dépôt{repos.length > 1 ? 's' : ''} · {credentials.length} jeton
                            {credentials.length > 1 ? 's' : ''} d’accès
                        </p>
                    )}
                </div>
                <div className={styles.actions}>
                    {/* Les jetons sont une propriété de l'espace, pas d'un dépôt :
                        ils vivent donc en tête de la feature, et non enfouis dans
                        le formulaire d'un dépôt comme c'était le cas avant. */}
                    <Button variant='secondary' icon='key' onClick={() => setCredentialsOpen(true)}>
                        Jetons d’accès
                    </Button>
                    {canWrite && (
                        <Button icon='add' onClick={() => setRepoDialog({ repo: null })}>
                            Ajouter un dépôt
                        </Button>
                    )}
                </div>
            </header>

            {error && <p className={styles.error}>{error}</p>}

            {repos === null && <p className={styles.empty}>Chargement…</p>}

            {repos?.length === 0 && (
                <p className={styles.empty}>
                    Aucun dépôt pour l’instant.
                    {canWrite && ' Ajoutez-en un pour suivre ses commits, ses branches et ses pull requests.'}
                </p>
            )}

            {repos && repos.length > 0 && (
                <RepoList
                    repos={repos}
                    syncing={syncing}
                    outlineFor={outlineFor}
                    canWrite={canWrite}
                    onOpen={setOpenedId}
                    onReorder={reorder}
                    onDragStateChange={onDragStateChange}
                />
            )}

            <RepoDialog
                open={repoDialog !== null}
                repo={repoDialog?.repo ?? null}
                credentials={credentials}
                onClose={() => setRepoDialog(null)}
                onSaved={(repoId) => {
                    setRepoDialog(null);
                    invalidate('git.list', 'git.count');
                    // Un dépôt qu'on vient d'ajouter s'ouvre : c'est ce qu'on
                    // voulait faire, et sa synchronisation démarre sous les yeux.
                    setOpenedId(repoId);
                }}
                onRemove={canWrite && repoDialog?.repo ? () => void removeRepo(repoDialog.repo!.id) : undefined}
            />

            <CredentialsDialog
                open={credentialsOpen}
                credentials={credentials}
                canWrite={canWrite}
                onClose={() => setCredentialsOpen(false)}
                onChanged={() => invalidate('git.list')}
            />
        </div>
    );
}

export default FeatureGit;
