import { useState, type ReactNode } from 'react';
import type { DeployTarget, Deployment, MinimalUser } from 'deveye-types';
import { DEPLOY_TITLE_MAX_LENGTH } from 'deveye-types';
import { Button, Dialog, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate } from '@/stores/invalidation';
import { humanizeError } from '@/Features/Projects/api';
import { Avatar } from '@/Features/Projects/Board/Avatar';
import { formatAgo, hostOf, STATUS_LABELS, statusTone } from './format';
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
    /** Actions propres à l'appelant : « Délier », « Ouvrir dans Déploiement ». */
    after?: ReactNode;
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
export function TargetView({ target, deployments, members, canWrite, projectId, onEdit, after }: TargetViewProps) {
    const [triggerOpen, setTriggerOpen] = useState(false);
    const [busy, setBusy] = useState(false);

    const orphan = target.credentialId === null;

    return (
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
                                {target.kind === 'compose' ? 'pile compose' : 'application'} · {hostOf(target.baseUrl)}{' '}
                                · {target.externalId}
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

            <div className={styles.history}>
                <h3 className={styles.sectionTitle}>Déploiements</h3>
                {deployments.length === 0 ? (
                    <p className={styles.empty}>Rien n’est encore parti d’ici.</p>
                ) : (
                    <ul className={styles.itemList}>
                        {deployments.map((d) => (
                            <li key={d.id}>
                                <span className={styles.statusTag} data-tone={statusTone(d.status)}>
                                    {STATUS_LABELS[d.status]}
                                </span>
                                <span className={styles.itemName}>{d.title}</span>
                                {d.triggeredByUserId !== null && (
                                    <Avatar user={members.find((m) => m.id === d.triggeredByUserId)} size={18} />
                                )}
                                <span
                                    className={styles.itemDate}
                                    title={new Date(d.startedAt * 1000).toLocaleString('fr-FR')}
                                >
                                    {formatAgo(d.startedAt)}
                                </span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

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
        </section>
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
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await ws.send('deploy.trigger', {
                targetId,
                title,
                description,
                ...(projectId === undefined ? {} : { projectId })
            });
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
