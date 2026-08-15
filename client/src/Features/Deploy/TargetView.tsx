import { useState, type ReactNode } from 'react';
import type { DeployHistoryEntry, DeployStatus, DeployTarget, Deployment, MinimalUser } from 'deveye-types';
import { DEPLOY_TITLE_MAX_LENGTH } from 'deveye-types';
import { Button, Dialog, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate } from '@/stores/invalidation';
import { humanizeError } from '@/Features/Projects/api';
import { Avatar } from '@/Features/Projects/Board/Avatar';
import { DOKPLOY_TIMEOUT_MS, formatAgo, hostOf, STATUS_LABELS, statusTone } from './format';
import styles from './style.module.css';

interface TargetViewProps {
    target: DeployTarget;
    deployments: Deployment[];
    /** Pour mettre un visage sur qui a déclenché quoi. */
    members: MinimalUser[];
    /** Droit `deploy: write` — c'est lui qui autorise à mettre en production. */
    canWrite: boolean;
    /**
     * Le projet d'où part le geste, quand il en part d'un.
     *
     * Sert à inscrire le déclenchement dans **sa** frise. Absent depuis la
     * feature : un déploiement lancé de là n'appartient à aucun projet en
     * particulier, et l'attribuer à l'un d'eux au hasard serait faux.
     */
    projectId?: number;
    onEdit?: () => void;
    /** Actions propres à l'appelant : « Délier », « Ouvrir le Déploiement ». */
    after?: ReactNode;
    /**
     * L'historique complet du fournisseur, à la place du suivi local
     * (`deployments`) : il couvre aussi ce qui n'est jamais passé par DevEye.
     * `null` = en cours de chargement. **Absent dans l'onglet d'un projet** —
     * `deployments` y suffit, et interroger Dokploy pour chaque cible reliée
     * coûterait une requête externe par carte pour peu d'apport.
     */
    fullHistory?: DeployHistoryEntry[] | null;
    /** Dokploy injoignable pendant le chargement de `fullHistory` — n'empêche
     *  pas le reste de la fiche (nom, déclenchement) de fonctionner. */
    fullHistoryError?: string | null;
    /**
     * Ouvre le journal d'une ligne — absent dans l'onglet d'un projet, où le
     * geste n'a pas de sens sans `fullHistory` pour lui donner un identifiant
     * fournisseur sûr.
     */
    onOpenLogs?: (externalId: string) => void;
    /**
     * Affiche la section dédiée à l'historique complet, sous l'en-tête.
     *
     * `false` dans l'onglet « Déploiement » d'un projet : ce panneau ne le
     * concerne pas. La fiche s'y limite à l'identité et au dernier déploiement
     * (`blockLastDeploy`), comme avant que l'historique n'y gagne sa propre
     * carte. Réservée à la feature Déploiement elle-même, où l'historique
     * complet a de la place pour respirer, surtout sur sa page dédiée.
     * Par défaut `true`.
     */
    showHistory?: boolean;
}

/** Une ligne d'historique, qu'elle vienne du suivi local ou de Dokploy en direct. */
interface HistoryRow {
    key: string | number;
    status: DeployStatus;
    title: string;
    description: string;
    startedAt: number;
    /** `null` = inconnu (ligne venue de Dokploy) ou tâche de fond. */
    triggeredByUserId: number | null;
    /** `null` = pas d'identifiant fournisseur, donc pas de journal à ouvrir. */
    externalId: string | null;
}

/**
 * Une cible et son historique — le cœur partagé entre la feature et l'onglet
 * d'un projet.
 *
 * Même parti pris que `RepoView`, `DatabaseView` et `SiteView` : une cible ne se
 * présente pas autrement selon la porte par laquelle on entre. Ce composant
 * porte donc l'en-tête, le bouton qui déclenche et la liste de ce qui est parti ;
 * l'appelant n'ajoute que ce qui lui est propre, par `after`.
 */
export function TargetView({
    target,
    deployments,
    members,
    canWrite,
    projectId,
    onEdit,
    after,
    fullHistory,
    fullHistoryError,
    onOpenLogs,
    showHistory = true
}: TargetViewProps) {
    const [triggerOpen, setTriggerOpen] = useState(false);
    const [busy, setBusy] = useState(false);

    const orphan = target.credentialId === null;

    // Toujours calculées, `showHistory` ou pas : l'en-tête a besoin de la
    // première ligne (son titre) pour son propre résumé du dernier
    // déploiement, que la section dédiée soit rendue ou non.
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
                    // Pas d'id DevEye pour une ligne que Dokploy seul connaît ;
                    // son identifiant chez le fournisseur en tient lieu, avec
                    // l'index en dernier repli s'il n'en donne aucun.
                    key: d.externalId ?? `${d.startedAt}-${i}`,
                    status: d.status,
                    title: d.title,
                    description: d.description,
                    startedAt: d.startedAt,
                    triggeredByUserId: null,
                    externalId: d.externalId
                }));

    // La section dédiée, elle, respecte `showHistory` : c'est elle que
    // l'onglet d'un projet n'affiche pas, pas le calcul qui la nourrit.
    const rows = showHistory ? historyRows : null;
    // La ligne la plus récente, pour le résumé compact de l'en-tête : les deux
    // sources sont triées du plus récent au plus ancien (voir le serveur).
    const lastRow = historyRows?.[0] ?? null;

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
                                    {target.kind === 'compose' ? 'pile compose' : 'application'} ·{' '}
                                    {hostOf(target.baseUrl)} · {target.externalId}
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
                        {/* Le dernier état à même hauteur que l'identité : le détail de
                            la fiche n'oblige plus à descendre jusqu'à l'historique pour
                            savoir si ça tient toujours debout. */}
                        <p className={styles.blockLastDeploy}>
                            {target.lastStatus === null ? (
                                <span className={styles.hint}>Aucun déploiement pour l’instant.</span>
                            ) : (
                                <>
                                    <span className={styles.statusTag} data-tone={statusTone(target.lastStatus)}>
                                        {STATUS_LABELS[target.lastStatus]}
                                    </span>
                                    {/* Le titre du dernier déploiement, pas seulement son état : le
                                        même que celui de la première ligne de l'historique, tronqué
                                        si besoin plutôt que de pousser la date hors du cadre. */}
                                    {lastRow?.title && (
                                        <span className={styles.lastDeployName} title={lastRow.title}>
                                            {lastRow.title}
                                        </span>
                                    )}
                                    <span className={styles.hint}>
                                        Dernier déploiement {formatAgo(target.lastDeployAt)}
                                    </span>
                                </>
                            )}
                        </p>
                    </div>
                    <div className={styles.actions}>
                        {canWrite && (
                            <Button icon='rocket' onClick={() => setTriggerOpen(true)} disabled={busy || orphan}>
                                Déployer
                            </Button>
                        )}
                        {canWrite && onEdit && (
                            <Button variant='secondary' icon='edit' onClick={onEdit}>
                                Modifier
                            </Button>
                        )}
                        {after}
                    </div>
                </header>
            </section>

            {/* Section à part entière, et non plus nichée sous l'en-tête : l'historique
                complet a désormais sa propre carte, avec sa propre respiration, surtout
                sensible sur la page dédiée de la feature, plus large qu'un onglet de projet.
                Absente de l'onglet d'un projet (`showHistory` à `false`), qui n'a que faire
                de ce second panneau (voir la doc de la prop). */}
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
                                        {/* Toute la ligne est la cible du clic — pas une
                                            icône à part qu'il faudrait viser — quand un
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
                                        {/* Le message du fournisseur, pas une simple
                                            étiquette rouge : c'est lui qui dit pourquoi,
                                            pas seulement que ça a échoué. */}
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

            <TriggerDialog
                open={triggerOpen}
                targetId={target.id}
                projectId={projectId}
                busy={busy}
                setBusy={setBusy}
                onClose={() => setTriggerOpen(false)}
                onDone={() => {
                    setTriggerOpen(false);
                    // La liste, la fiche **et** l'onglet du projet qui la
                    // déploie montrent le même état : les trois se relisent.
                    invalidate('deploy.list', 'deploy.detail', 'project.board');
                }}
            />
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
            await ws.send(
                'deploy.trigger',
                {
                    targetId,
                    title,
                    description,
                    ...(projectId === undefined ? {} : { projectId })
                },
                { timeoutMs: DOKPLOY_TIMEOUT_MS }
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
