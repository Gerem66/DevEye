import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    FeatureSettingsButton,
    humanizeError,
    useActiveWorkspace,
    useLiveItemTarget,
    useLiveOutlines,
    useResourceVersion,
    useWorkspaceMembers,
    useWorkspacePermissions
} from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';
import type { DeployHistoryEntry, DeployTarget, Deployment } from '../contracts/domain';

import { api } from './api';
import { PROVIDER_TIMEOUT_MS, providerError } from './format';
import LogsDialog from './LogsDialog';
import TargetDialog from './TargetDialog';
import TargetList from './TargetList';
import TargetView, { TargetActions } from './TargetView';
import styles from './style.module.css';

/**
 * Déploiement : les cibles de l'espace actif. Feature de premier rang : une
 * pile compose sert souvent deux projets, et un projet n'y pointe que par une
 * liaison. Ne demande jamais de mot de passe : tout vit à l'étage ouvert.
 */
export function FeatureDeploy(_props: FeatureViewProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('deploy', 'write');
    const workspaceId = useActiveWorkspace()?.id ?? null;
    const members = useWorkspaceMembers();

    const [targets, setTargets] = useState<DeployTarget[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    /** La cible ouverte ; `null` = on est sur la liste. */
    const [openedId, setOpenedId] = useState<number | null>(null);
    const [opened, setOpened] = useState<{ target: DeployTarget; deployments: Deployment[] } | null>(null);

    /**
     * L'historique complet tel que le fournisseur le rend, chargé à part de `opened` :
     * une instance injoignable ne doit pas priver la fiche de son nom ni de son
     * bouton « Déployer ». `null` = en cours de chargement.
     */
    const [history, setHistory] = useState<DeployHistoryEntry[] | null>(null);
    const [historyError, setHistoryError] = useState<string | null>(null);

    const [addOpen, setAddOpen] = useState(false);
    /** L'identifiant chez le fournisseur dont on regarde le journal ; `null` = popup fermée. */
    const [logsFor, setLogsFor] = useState<string | null>(null);

    const listVersion = useResourceVersion('deploy.list');
    const detailVersion = useResourceVersion('deploy.detail');

    /** Un glisser-déposer est en cours : la liste ne doit pas bouger dessous. */
    const dragging = useRef(false);
    const pendingReload = useRef(false);

    /**
     * Présence : « qui regarde quelle cible ». Ce composant seul possède `l1`.
     * Une téléportation ouvre la feature ET la cible visée ; on attend que la
     * liste soit chargée (`ready`) pour vérifier qu'elle existe, et on l'ignore
     * si elle a disparu.
     */
    useLiveItemTarget('l1', openedId === null ? null : String(openedId), targets !== null, (value) => {
        if (value === null) {
            setOpenedId(null);
            return;
        }
        const id = Number(value);
        if (!Number.isInteger(id) || !targets?.some((t) => t.id === id)) return;
        setOpenedId(id);
    });
    const outlineFor = useLiveOutlines('l1');

    const reload = useCallback(async () => {
        try {
            const res = await api.send('deploy.list', {});
            setTargets(res.targets);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger les cibles.'));
        }
    }, []);

    useEffect(() => {
        // Une relecture réordonne la liste sous le pointeur : jamais pendant un
        // glissé. Elle est retenue et rejouée au relâchement.
        if (dragging.current) {
            pendingReload.current = true;
            return;
        }
        void reload();
    }, [reload, workspaceId, listVersion]);

    const loadOpened = useCallback(async (targetId: number) => {
        try {
            const res = await api.send('deploy.get', { targetId });
            setOpened({ target: res.target, deployments: res.deployments });
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger cette cible.'));
            setOpened(null);
        }
    }, []);

    useEffect(() => {
        if (openedId === null) {
            setOpened(null);
            return;
        }
        void loadOpened(openedId);
    }, [openedId, loadOpened, detailVersion]);

    const loadHistory = useCallback(async (targetId: number) => {
        setHistory(null);
        setHistoryError(null);
        try {
            const res = await api.send('deploy.history', { targetId }, { timeoutMs: PROVIDER_TIMEOUT_MS });
            setHistory(res.entries);
        } catch (e) {
            // Le message du fournisseur lui-même (voir `providerError`) : la seule
            // piste pour distinguer injoignable de refus d'authentification.
            setHistoryError(providerError(e, 'Impossible de charger l’historique complet.'));
        }
    }, []);

    useEffect(() => {
        if (openedId === null) {
            setHistory(null);
            setHistoryError(null);
            return;
        }
        void loadHistory(openedId);
    }, [openedId, loadHistory, detailVersion]);

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

    const reorder = useCallback(
        (targetIds: number[]) => {
            // On range d'abord localement, pour que la carte reste là où on l'a
            // lâchée sans aller-retour, puis on persiste.
            setTargets((prev) => {
                if (!prev) return prev;
                const byId = new Map(prev.map((t) => [t.id, t]));
                return targetIds.flatMap((id) => byId.get(id) ?? []);
            });
            api.send('deploy.reorder', { targetIds }).catch(() => {
                setError('Réorganisation impossible.');
                void reload();
            });
        },
        [reload]
    );

    return (
        <div className={styles.feature}>
            {openedId === null ? (
                <>
                    <header className={styles.head}>
                        <div>
                            <h2 className={styles.title}>Déploiements</h2>
                            <p className={styles.subtitle}>Ce que vous mettez en production, et ce que ça a donné.</p>
                        </div>
                        <div className={styles.actions}>
                            {/* Les accès (Dokploy, GitHub) vivent dans Réglages →
                                Sources, à côté des canaux d'alerte. */}
                            <FeatureSettingsButton scope={{ kind: 'feature', feature: 'deploy' }} />
                            {canWrite && (
                                <Button icon='add' onClick={() => setAddOpen(true)}>
                                    Déclarer une cible
                                </Button>
                            )}
                        </div>
                    </header>

                    {error && <p className={styles.error}>{error}</p>}

                    {targets === null ? (
                        <p className={styles.empty}>Chargement…</p>
                    ) : targets.length === 0 ? (
                        <p className={styles.empty}>
                            Aucune cible déclarée.{' '}
                            {canWrite
                                ? 'Ajoutez un accès (une instance Dokploy ou un jeton GitHub) ou choisissez une machine de l’espace, puis ce qu’il faut déployer : vous pourrez le lancer d’ici.'
                                : 'Un membre disposant du droit d’écriture peut en déclarer une.'}
                        </p>
                    ) : (
                        <TargetList
                            targets={targets}
                            outlineFor={outlineFor}
                            canWrite={canWrite}
                            onOpen={setOpenedId}
                            onReorder={reorder}
                            onDragStateChange={onDragStateChange}
                        />
                    )}
                </>
            ) : opened === null ? (
                <p className={styles.empty}>{error ?? 'Chargement…'}</p>
            ) : (
                <>
                    {/* La même rangée d'en-tête que la liste et que les fiches
                        des autres features : retour à gauche, actions à droite. */}
                    <header className={styles.head}>
                        <Button variant='ghost' icon='arrow-left' onClick={() => setOpenedId(null)}>
                            Déploiements
                        </Button>
                        <div className={styles.actions}>
                            {/* Supprimée ou déplacée depuis ses réglages, la cible
                                n'est plus ici : la fiche revient à la liste. */}
                            <TargetActions
                                target={opened.target}
                                canWrite={canWrite}
                                onGone={() => setOpenedId(null)}
                            />
                        </div>
                    </header>

                    <TargetView
                        target={opened.target}
                        deployments={opened.deployments}
                        members={members}
                        canWrite={canWrite}
                        showActions={false}
                        fullHistory={history}
                        fullHistoryError={historyError}
                        onOpenLogs={setLogsFor}
                    />
                </>
            )}

            {/* La liste se relit par l'invalidation posée dans le dialogue. */}
            <TargetDialog open={addOpen} onClose={() => setAddOpen(false)} onSaved={() => setAddOpen(false)} />

            <LogsDialog
                open={logsFor !== null}
                targetId={openedId}
                externalId={logsFor}
                onClose={() => setLogsFor(null)}
            />
        </div>
    );
}

export default FeatureDeploy;
