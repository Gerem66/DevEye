import { useCallback, useEffect, useRef, useState } from 'react';
import type { Credential, DeployHistoryEntry, DeployTarget, Deployment } from 'deveye-types';

import { Button, CredentialsDialog, DEPLOY_CREDENTIALS } from '@/Components';
import { ws } from '@/api/ws';
import { useLiveOutlines } from '@/live/useLiveOutline';
import { useLiveSegment } from '@/live/useLiveSegment';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import type { FeatureProps } from '@/Features/types';
import { humanizeError } from '@/Features/Projects/api';
import { dokployError, DOKPLOY_TIMEOUT_MS } from './format';
import LogsDialog from './LogsDialog';
import TargetDialog from './TargetDialog';
import TargetList from './TargetList';
import TargetView from './TargetView';
import styles from './style.module.css';

/**
 * Déploiement — les cibles de l'espace actif.
 *
 * Feature de premier rang, et non un onglet des Projets : une pile compose sert
 * souvent deux projets (un client, un serveur), certaines ne servent aucun
 * projet, et un projet n'y **pointe** que par une liaison. C'est la forme des
 * features Git, Bases de données et Audience, et pour les mêmes raisons — c'est
 * même le dernier module à l'avoir prise (migration 080).
 *
 * Portée volontairement étroite : **déclencher et suivre**. Rien ici ne
 * configure un déploiement ; tout cela vit chez Dokploy, qui le fait mieux.
 *
 * Ne demande jamais de mot de passe : tout vit à l'étage ouvert, sous la clé de
 * l'espace — condition pour que le suivi d'état tourne sans session.
 */
export function FeatureDeploy({ workspace }: FeatureProps) {
    const permissions = useWorkspacePermissions();
    const canWrite = permissions.canFeature('deploy', 'write');

    const [targets, setTargets] = useState<DeployTarget[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    /** La cible ouverte ; `null` = on est sur la liste. */
    const [openedId, setOpenedId] = useState<number | null>(null);
    const [opened, setOpened] = useState<{ target: DeployTarget; deployments: Deployment[] } | null>(null);

    /**
     * L'historique complet, tel que Dokploy le rend — chargé à part de
     * `opened` : une instance injoignable ne doit pas priver la fiche de son
     * nom ni de son bouton « Déployer », seul l'historique doit le dire.
     * `null` = en cours de chargement.
     */
    const [history, setHistory] = useState<DeployHistoryEntry[] | null>(null);
    const [historyError, setHistoryError] = useState<string | null>(null);

    const [dialog, setDialog] = useState<{ target: DeployTarget | null } | null>(null);
    const [credentialsOpen, setCredentialsOpen] = useState(false);
    const [credentials, setCredentials] = useState<Credential[]>([]);
    /** L'identifiant Dokploy dont on regarde le journal ; `null` = popup fermée. */
    const [logsFor, setLogsFor] = useState<string | null>(null);

    const listVersion = useResourceVersion('deploy.list');
    const detailVersion = useResourceVersion('deploy.detail');

    /** Un glisser-déposer est en cours : la liste ne doit pas bouger dessous. */
    const dragging = useRef(false);
    const pendingReload = useRef(false);

    // Présence : « qui regarde quelle cible ». Un seul déclarant par niveau —
    // ce composant possède `l1`, et rien d'autre dans la feature n'y touche.
    const l1Target = useLiveSegment('l1', openedId === null ? null : `target:${openedId}`);
    const outlineFor = useLiveOutlines('l1');

    useEffect(() => {
        if (!l1Target) return;
        if (l1Target.value === null) {
            setOpenedId(null);
            return;
        }
        const id = Number(l1Target.value.replace(/^target:/, ''));
        if (!Number.isInteger(id) || !targets?.some((t) => t.id === id)) return;
        setOpenedId(id);
    }, [l1Target, targets]);

    const reload = useCallback(async () => {
        try {
            const res = await ws.send('deploy.list', {});
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
    }, [reload, workspace.id, listVersion]);

    // Les jetons, pour le dialogue qui les gère. Lus avec la liste : leur nombre
    // ne bouge qu'à la main, et l'écran en a besoin dès qu'on l'ouvre.
    const reloadCredentials = useCallback(async () => {
        try {
            const res = await ws.send('deploy.credentialList', {});
            setCredentials(res.credentials);
        } catch {
            setCredentials([]);
        }
    }, []);

    useEffect(() => {
        void reloadCredentials();
    }, [reloadCredentials, workspace.id, listVersion]);

    const loadOpened = useCallback(async (targetId: number) => {
        try {
            const res = await ws.send('deploy.get', { targetId });
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
            const res = await ws.send('deploy.history', { targetId }, { timeoutMs: DOKPLOY_TIMEOUT_MS });
            setHistory(res.entries);
        } catch (e) {
            // Le message de Dokploy lui-même, pas un intitulé générique : c'est
            // souvent la seule piste pour distinguer une instance injoignable
            // d'un refus d'authentification (voir `dokployError`).
            setHistoryError(dokployError(e, 'Impossible de charger l’historique complet.'));
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
            ws.send('deploy.reorder', { targetIds }).catch(() => {
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
                            {/* Les clés sont une propriété de l'espace, pas d'une
                                cible : elles vivent donc en tête de la feature.
                                Elles étaient dans l'écran des dépôts, faute d'un
                                module de déploiement pour les accueillir. */}
                            <Button variant='secondary' icon='key' onClick={() => setCredentialsOpen(true)}>
                                Accès Dokploy
                            </Button>
                            {canWrite && (
                                <Button icon='add' onClick={() => setDialog({ target: null })}>
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
                                ? 'Posez une clé d’API Dokploy, choisissez une application, et vous pourrez la déployer d’ici.'
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
                    <header className={styles.head}>
                        <Button variant='ghost' icon='arrow-left' onClick={() => setOpenedId(null)}>
                            Déploiements
                        </Button>
                    </header>

                    <TargetView
                        target={opened.target}
                        deployments={opened.deployments}
                        members={workspace.users}
                        canWrite={canWrite}
                        onEdit={() => setDialog({ target: opened.target })}
                        fullHistory={history}
                        fullHistoryError={historyError}
                        onOpenLogs={setLogsFor}
                    />
                </>
            )}

            <TargetDialog
                open={dialog !== null}
                target={dialog?.target ?? null}
                onClose={() => setDialog(null)}
                onSaved={(target) => {
                    setDialog(null);
                    // La fiche ouverte doit refléter le réglage tout de suite ;
                    // la liste se relit par l'invalidation posée dans le
                    // dialogue, à la source de la mutation.
                    setOpened((prev) => (prev && prev.target.id === target.id ? { ...prev, target } : prev));
                    void reload();
                }}
                onRemoved={
                    dialog?.target
                        ? () => {
                              setDialog(null);
                              setOpenedId(null);
                              void reload();
                          }
                        : undefined
                }
            />

            <CredentialsDialog
                open={credentialsOpen}
                kind={DEPLOY_CREDENTIALS}
                credentials={credentials}
                canWrite={canWrite}
                onClose={() => setCredentialsOpen(false)}
                onChanged={() => {
                    void reloadCredentials();
                    // Un jeton retiré rend ses cibles indéployables : la liste
                    // doit le dire sans attendre.
                    invalidate('deploy.list');
                }}
            />

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
