import { useState, type ReactNode } from 'react';
import { Avatar, Button, Dialog, FeatureSettingsButton, humanizeError, invalidate, TextInput } from 'deveye-sdk-client';
import type { MinimalUser } from '@deveye/types';
import {
    DEPLOY_TITLE_MAX_LENGTH,
    type DeployHistoryEntry,
    type DeployStatus,
    type DeployTarget,
    type Deployment
} from '../contracts/domain';

import { api } from './api';
import { formatAgo, isOrphan, PROVIDER_TIMEOUT_MS, STATUS_LABELS, statusTone, targetWhere } from './format';
import styles from './style.module.css';

interface TargetViewProps {
    target: DeployTarget;
    deployments: Deployment[];
    /** Pour mettre un visage sur qui a déclenché quoi. */
    members: readonly MinimalUser[];
    /** Droit `deploy: write` : c'est lui qui autorise à mettre en production. */
    canWrite: boolean;
    /**
     * Le projet d'où part le geste, pour inscrire le déclenchement dans sa
     * frise. Absent depuis la feature : le déploiement n'appartient à aucun projet.
     */
    projectId?: number;
    /** Actions propres à l'appelant : « Délier », « Ouvrir le Déploiement ». */
    after?: ReactNode;
    /**
     * L'historique complet du fournisseur, à la place du suivi local
     * (`deployments`). `null` = en cours de chargement. Absent dans l'onglet
     * d'un projet : une requête externe par cible reliée coûterait trop.
     */
    fullHistory?: DeployHistoryEntry[] | null;
    /** Fournisseur injoignable pendant le chargement de `fullHistory` ; le reste de la fiche fonctionne. */
    fullHistoryError?: string | null;
    /**
     * Ouvre le journal d'une ligne : celles de l'historique, et le dernier
     * déploiement de l'en-tête. Absent, les deux restent inertes.
     */
    onOpenLogs?: (externalId: string) => void;
    /**
     * Affiche la section de l'historique complet sous l'en-tête. `false` dans
     * l'onglet d'un projet, qui se limite à l'identité et au dernier
     * déploiement. Par défaut `true`.
     */
    showHistory?: boolean;
    /**
     * Rend les actions dans le bloc d'identité. `false` sur la page dédiée de
     * la feature, où l'appelant monte {@link TargetActions} dans la rangée
     * d'en-tête ; le défaut `true` sert l'onglet d'un projet.
     */
    showActions?: boolean;
}

interface TargetActionsProps {
    target: DeployTarget;
    canWrite: boolean;
    /** Le projet d'où part le geste, quand il en part d'un (voir TargetView). */
    projectId?: number;
    /**
     * La cible a été supprimée ou déplacée depuis ses réglages : la fiche s'en
     * va (le geste de son bouton de retour). Absent dans l'onglet d'un projet,
     * où la cible reste, ou s'en délie par invalidation.
     */
    onGone?: () => void;
    /** Actions propres à l'appelant : « Délier », « Ouvrir le Déploiement ». */
    after?: ReactNode;
}

/**
 * Les actions d'une cible : déclencher, régler. À part de {@link TargetView}
 * pour vivre à deux endroits : la rangée d'en-tête de la page dédiée et le
 * bloc d'identité d'un onglet de projet.
 */
export function TargetActions({ target, canWrite, projectId, onGone, after }: TargetActionsProps) {
    const [triggerOpen, setTriggerOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const orphan = isOrphan(target);

    return (
        <>
            {canWrite && (
                <Button icon='rocket' onClick={() => setTriggerOpen(true)} disabled={busy || orphan}>
                    Déployer
                </Button>
            )}
            {/* Les réglages de cette cible : son accès, ce qu'elle vise
                et sa suppression (onglet Général), ses canaux. Le bouton se
                garde de lui-même, sans section accessible il ne s'affiche pas. */}
            <FeatureSettingsButton
                scope={{
                    kind: 'item',
                    feature: 'deploy',
                    itemId: String(target.id),
                    itemLabel: target.name
                }}
                onGone={onGone}
            />
            {after}

            <TriggerDialog
                open={triggerOpen}
                targetId={target.id}
                projectId={projectId}
                busy={busy}
                setBusy={setBusy}
                onClose={() => setTriggerOpen(false)}
                onDone={() => {
                    setTriggerOpen(false);
                    // La liste, la fiche et l'onglet du projet se relisent.
                    invalidate('deploy.list', 'deploy.detail', 'projects.board');
                }}
            />
        </>
    );
}

/** Une ligne d'historique, qu'elle vienne du suivi local ou du fournisseur en direct. */
interface HistoryRow {
    key: string | number;
    status: DeployStatus;
    title: string;
    description: string;
    startedAt: number;
    /** `null` = inconnu (ligne venue du fournisseur) ou tâche de fond. */
    triggeredByUserId: number | null;
    /** `null` = pas d'identifiant fournisseur, donc pas de journal à ouvrir. */
    externalId: string | null;
}

/**
 * Une cible et son historique, partagés entre la feature et l'onglet d'un
 * projet : une cible ne se présente pas autrement selon la porte par laquelle
 * on entre. L'appelant n'ajoute que ce qui lui est propre, par `after`.
 */
export function TargetView({
    target,
    deployments,
    members,
    canWrite,
    projectId,
    after,
    fullHistory,
    fullHistoryError,
    onOpenLogs,
    showHistory = true,
    showActions = true
}: TargetViewProps) {
    const orphan = isOrphan(target);

    // Toujours calculées, `showHistory` ou pas : l'en-tête a besoin de la
    // première ligne pour son résumé du dernier déploiement.
    const historyRows: HistoryRow[] | null =
        fullHistory === undefined
            ? deployments.map((d) => ({
                  key: d.id,
                  status: d.status,
                  title: d.title,
                  description: d.description,
                  startedAt: d.startedAt,
                  triggeredByUserId: d.triggeredByUserId,
                  externalId: d.externalId
              }))
            : fullHistory === null
              ? null
              : fullHistory.map((d, i) => ({
                    // Pas d'id DevEye pour une ligne que le fournisseur seul connaît.
                    key: d.externalId ?? `${d.startedAt}-${i}`,
                    status: d.status,
                    title: d.title,
                    description: d.description,
                    startedAt: d.startedAt,
                    triggeredByUserId: null,
                    externalId: d.externalId
                }));

    const rows = showHistory ? historyRows : null;
    // Les deux sources sont triées du plus récent au plus ancien (voir le serveur).
    const lastRow = historyRows?.[0] ?? null;
    // Le journal du dernier déploiement, quand le fournisseur en tient un pour
    // lui : une ligne que le rapprochement n'a pas encore appariée n'en a pas.
    const lastLogId = onOpenLogs && lastRow?.externalId ? lastRow.externalId : null;

    const lastDeploy = target.lastStatus !== null && (
        <>
            <span className={styles.statusTag} data-tone={statusTone(target.lastStatus)}>
                {STATUS_LABELS[target.lastStatus]}
            </span>
            {/* Le titre de la première ligne de l'historique, tronqué
                plutôt que de pousser la date hors du cadre. */}
            {lastRow?.title && (
                <span className={styles.lastDeployName} title={lastRow.title}>
                    {lastRow.title}
                </span>
            )}
            <span className={styles.hint}>Dernier déploiement {formatAgo(target.lastDeployAt)}</span>
        </>
    );

    return (
        <div className={styles.targetGroup}>
            <section className={styles.block}>
                <header className={styles.blockHead}>
                    <div className={styles.blockIdent}>
                        <p className={styles.blockName}>
                            <span className='icon icon-rocket' aria-hidden='true' /> {target.name}
                        </p>
                        <p className={styles.blockMeta}>
                            {orphan ? (
                                <span className={styles.overdue}>accès retiré, déclenchement impossible</span>
                            ) : (
                                <span>
                                    {targetWhere(target)}
                                    {target.ref ? ` · ${target.ref}` : ''}
                                </span>
                            )}
                            {target.projectCount > 1 && (
                                <span>
                                    {' '}
                                    · partagée avec {target.projectCount - 1} autre{target.projectCount > 2 ? 's' : ''}{' '}
                                    projet{target.projectCount > 2 ? 's' : ''}
                                </span>
                            )}
                        </p>
                        {/* Le dernier état à même hauteur que l'identité, et son
                            journal au clic quand la ligne en a un. */}
                        {target.lastStatus === null ? (
                            <p className={styles.blockLastDeploy}>
                                <span className={styles.hint}>Aucun déploiement pour l’instant.</span>
                            </p>
                        ) : lastLogId !== null ? (
                            <button
                                type='button'
                                className={`${styles.blockLastDeploy} ${styles.itemRowClickable}`}
                                title='Voir le journal'
                                onClick={() => onOpenLogs?.(lastLogId)}
                            >
                                {lastDeploy}
                            </button>
                        ) : (
                            <p className={styles.blockLastDeploy}>{lastDeploy}</p>
                        )}
                    </div>
                    {showActions && (
                        <div className={styles.actions}>
                            <TargetActions target={target} canWrite={canWrite} projectId={projectId} after={after} />
                        </div>
                    )}
                </header>
            </section>

            {/* L'historique complet a sa propre carte ; absente de l'onglet d'un
                projet (`showHistory` à `false`). */}
            {showHistory && (
                <section className={`${styles.block} ${styles.historyBlock} ${styles.history}`}>
                    <h3 className={styles.sectionTitle}>Déploiements</h3>
                    {fullHistoryError ? (
                        <p className={styles.error}>{fullHistoryError}</p>
                    ) : rows === null ? (
                        <p className={styles.empty}>Chargement…</p>
                    ) : rows.length === 0 ? (
                        <p className={styles.empty}>Rien n’est encore parti d’ici.</p>
                    ) : (
                        <ul className={styles.itemList}>
                            {rows.map((row) => {
                                const clickable = Boolean(onOpenLogs) && row.externalId !== null;
                                const content = (
                                    <>
                                        <span className={styles.statusTag} data-tone={statusTone(row.status)}>
                                            {STATUS_LABELS[row.status]}
                                        </span>
                                        <span className={styles.itemName}>{row.title}</span>
                                        {row.triggeredByUserId !== null && (
                                            <Avatar
                                                user={members.find((m) => m.id === row.triggeredByUserId)}
                                                size={18}
                                            />
                                        )}
                                        <span
                                            className={styles.itemDate}
                                            title={new Date(row.startedAt * 1000).toLocaleString('fr-FR')}
                                        >
                                            {formatAgo(row.startedAt)}
                                        </span>
                                    </>
                                );
                                return (
                                    <li key={row.key}>
                                        {/* Toute la ligne est la cible du clic quand un
                                            journal existe pour elle. */}
                                        {clickable ? (
                                            <button
                                                type='button'
                                                className={`${styles.itemRow} ${styles.itemRowClickable}`}
                                                title='Voir le journal'
                                                onClick={() => onOpenLogs?.(row.externalId as string)}
                                            >
                                                {content}
                                            </button>
                                        ) : (
                                            <div className={styles.itemRow}>{content}</div>
                                        )}
                                        {/* Le message du fournisseur : c'est lui qui dit
                                            pourquoi. */}
                                        {row.status === 'failed' && row.description && (
                                            <p className={styles.itemError} title={row.description}>
                                                {row.description}
                                            </p>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </section>
            )}
        </div>
    );
}

interface TriggerDialogProps {
    open: boolean;
    targetId: number;
    projectId?: number;
    busy: boolean;
    setBusy: (v: boolean) => void;
    onClose: () => void;
    onDone: () => void;
}

function TriggerDialog({ open, targetId, projectId, busy, setBusy, onClose, onDone }: TriggerDialogProps) {
    const [title, setTitle] = useState('Déploiement DevEye');
    const [description, setDescription] = useState('');
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await api.send(
                'deploy.trigger',
                {
                    targetId,
                    title,
                    description,
                    ...(projectId === undefined ? {} : { projectId })
                },
                { timeoutMs: PROVIDER_TIMEOUT_MS }
            );
            setTitle('');
            setDescription('');
            onDone();
        } catch (e) {
            setError(humanizeError(e, 'Le déclenchement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Déclencher un déploiement'
            description='L’action est enregistrée dans les journaux, et dans l’historique du projet quand elle en part d’un.'
            width={520}
            onSubmit={submit}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button icon='rocket' onClick={submit} disabled={busy}>
                        {busy ? 'Déclenchement…' : 'Déployer'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.label}>Titre</span>
                    <TextInput
                        data-autofocus
                        value={title}
                        maxLength={DEPLOY_TITLE_MAX_LENGTH}
                        placeholder='Déploiement depuis DevEye'
                        onChange={(e) => setTitle(e.target.value)}
                    />
                </label>
                <label className={styles.field}>
                    <span className={styles.label}>Description</span>
                    <textarea
                        className={styles.textarea}
                        value={description}
                        rows={3}
                        onChange={(e) => setDescription(e.target.value)}
                    />
                </label>
                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default TargetView;
