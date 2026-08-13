import { useCallback, useEffect, useState } from 'react';
import type { DeployStatus, MinimalUser, Project, ProjectDeployTarget, ProjectDeployment } from 'deveye-types';
import { PROJECT_DEPLOY_TITLE_MAX_LENGTH } from 'deveye-types';
import { Button, Dialog, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { humanizeError, withSecrecy } from '../api';
import { Avatar } from '../Board/Avatar';
import { LinkTargetDialog } from './LinkTargetDialog';
import { UptimeLinks } from './UptimeLinks';
import styles from '../style.module.css';

const STATUS_LABELS: Record<DeployStatus, string> = {
    queued: 'En attente',
    running: 'En cours',
    success: 'Réussi',
    failed: 'Échoué'
};

interface DeployProps {
    project: Project;
    members: MinimalUser[];
    canWrite: boolean;
}

/**
 * L'onglet Déploiement : lier une application, la déclencher, suivre l'état.
 *
 * DevEye ne configure rien du déploiement — ni domaine, ni variable
 * d'environnement, ni build. Il déclenche et il observe ; le reste vit chez
 * Dokploy, qui le fait mieux.
 *
 * L'état est réinterrogé par le service de fond (aucun webhook n'arrive) : la
 * page se rafraîchit donc d'elle-même via `live.changed`, sans sondage côté
 * navigateur.
 *
 * **Même forme que les onglets Git, Bases et Audience**, et ce n'est pas
 * cosmétique : ce sont quatre vues du même genre — un ou plusieurs objets
 * rattachés, chacun dans son cadre, avec son en-tête d'actions, et le geste
 * d'ajout au pied de la page. L'onglet montrait auparavant un bloc centré au
 * milieu du vide quand rien n'était lié, puis un en-tête nu quand quelque chose
 * l'était, et ne savait pas délier : trois écarts pour un même besoin.
 *
 * Sa seule vraie différence tient au domaine : **une application par projet**,
 * là où les trois autres en admettent autant qu'on veut. Le pied de page propose
 * donc l'ajout tant qu'il n'y a rien, et l'en-tête « Modifier » ensuite.
 */
export function Deploy({ project, members, canWrite }: DeployProps) {
    const [target, setTarget] = useState<ProjectDeployTarget | null>(null);
    const [deployments, setDeployments] = useState<ProjectDeployment[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    const [triggerOpen, setTriggerOpen] = useState(false);
    const [unlinking, setUnlinking] = useState(false);
    const [busy, setBusy] = useState(false);

    const version = useResourceVersion('project.board');
    const guarded = project.securityTier === 'guarded';

    const load = useCallback(async () => {
        // Un projet confidentiel n'a jamais de cible : ne rien demander évite
        // surtout de faire surgir l'invite de déverrouillage pour lire une liste
        // de déploiements dont on sait déjà qu'elle est vide.
        if (guarded) {
            setLoaded(true);
            return;
        }
        try {
            const t = await withSecrecy(() => ws.send('project.deployGet', { projectId: project.id }));
            setTarget(t.target);
            const list = await withSecrecy(() => ws.send('project.deployList', { projectId: project.id }));
            setDeployments(list.deployments);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger le déploiement.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id, guarded]);

    useEffect(() => {
        void load();
    }, [load, version]);

    const unlink = async () => {
        setBusy(true);
        try {
            await ws.send('project.deployUnlink', { projectId: project.id });
            setUnlinking(false);
            invalidate('project.board');
        } catch (e) {
            setError(humanizeError(e, 'Le déliement a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    if (!loaded) return <p className={styles.empty}>Chargement…</p>;

    return (
        <div className={styles.deploy}>
            {error && <p className={styles.error}>{error}</p>}

            {/* Au-dessus de l'application déployée, et non en dessous : « est-ce
                en ligne ? » se lit avant « qu'ai-je livré ? ». Rendu même sur un
                projet confidentiel — c'est la seule moitié de cet onglet qui ne
                dépende d'aucun service extérieur, et la faire disparaître
                emprisonnerait les services déjà rattachés. */}
            <UptimeLinks projectId={project.id} canWrite={canWrite} />

            {guarded && (
                <p className={styles.empty}>
                    Ce projet est confidentiel : il ne peut pas être relié à un déploiement, car le suivi tourne sans
                    session et n’a pas accès à sa clé.
                </p>
            )}

            {!guarded && !target && <p className={styles.empty}>Aucune application liée à ce projet.</p>}

            {target && (
                <section className={styles.deployBlock}>
                    <header className={styles.targetHead}>
                        <div className={styles.targetIdent}>
                            <p className={styles.targetName}>
                                <span className='icon icon-rocket' aria-hidden='true' /> {target.name}
                            </p>
                            <p className={styles.targetMeta}>
                                {target.credentialId === null ? (
                                    <span className={styles.overdue}>accès retiré, déclenchement impossible</span>
                                ) : (
                                    <span>
                                        Dokploy · {target.kind === 'compose' ? 'pile compose' : 'application'} ·{' '}
                                        {target.externalId}
                                    </span>
                                )}
                            </p>
                        </div>
                        {canWrite && (
                            <div className={styles.actions}>
                                <Button
                                    icon='rocket'
                                    onClick={() => setTriggerOpen(true)}
                                    disabled={busy || target.credentialId === null}
                                >
                                    Déployer
                                </Button>
                                <Button variant='secondary' icon='edit' onClick={() => setLinkOpen(true)}>
                                    Modifier
                                </Button>
                                {/* Destructeur, donc en bout de barre et confirmé :
                                    il ne doit pas côtoyer « Déployer », qu'on
                                    presse souvent. Comme dans les trois autres
                                    onglets. */}
                                <Button variant='ghost' onClick={() => setUnlinking(true)} disabled={busy}>
                                    Délier
                                </Button>
                            </div>
                        )}
                    </header>

                    <section>
                        <h3 className={styles.sectionTitle}>Déploiements</h3>
                        {deployments.length === 0 && <p className={styles.empty}>Aucun déploiement déclenché d’ici.</p>}
                        <ul className={styles.itemList}>
                            {deployments.map((d) => (
                                <li key={d.id}>
                                    <span className={styles.deployStatus} data-status={d.status}>
                                        {STATUS_LABELS[d.status]}
                                    </span>
                                    <span className={styles.itemName}>{d.title}</span>
                                    {d.triggeredByUserId !== null && (
                                        <Avatar user={members.find((m) => m.id === d.triggeredByUserId)} size={18} />
                                    )}
                                    <span className={styles.itemDate}>
                                        {new Date(d.startedAt * 1000).toLocaleString('fr-FR')}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </section>
                </section>
            )}

            {/* Au pied de page comme dans les trois autres onglets, mais **une
                seule fois** : un projet ne déploie qu'une application, donc une
                fois liée c'est « Modifier » qui s'en charge. */}
            {!guarded && !target && canWrite && (
                <div className={styles.addRow}>
                    <Button icon='add' onClick={() => setLinkOpen(true)}>
                        Ajouter une application
                    </Button>
                </div>
            )}

            <LinkTargetDialog
                open={linkOpen}
                projectId={project.id}
                current={target}
                onClose={() => setLinkOpen(false)}
                onSaved={() => {
                    setLinkOpen(false);
                    invalidate('project.board');
                }}
            />

            <TriggerDialog
                open={triggerOpen}
                projectId={project.id}
                busy={busy}
                setBusy={setBusy}
                onClose={() => setTriggerOpen(false)}
                onDone={() => {
                    setTriggerOpen(false);
                    invalidate('project.board');
                }}
            />

            <Dialog
                open={unlinking}
                onClose={() => setUnlinking(false)}
                title='Délier cette application ?'
                width={460}
                onSubmit={() => void unlink()}
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setUnlinking(false)} disabled={busy}>
                            Annuler
                        </Button>
                        <Button variant='danger' disabled={busy} onClick={() => void unlink()}>
                            Délier
                        </Button>
                    </>
                }
            >
                <p className={styles.hint}>
                    {target && (
                        <>
                            <strong>{target.name}</strong> quitte ce projet : plus rien ne sera déclenché d’ici.
                            L’application, elle, continue de tourner chez Dokploy — DevEye ne fait que la pointer.
                        </>
                    )}
                </p>
            </Dialog>
        </div>
    );
}

interface TriggerDialogProps {
    open: boolean;
    projectId: number;
    busy: boolean;
    setBusy: (v: boolean) => void;
    onClose: () => void;
    onDone: () => void;
}

function TriggerDialog({ open, projectId, busy, setBusy, onClose, onDone }: TriggerDialogProps) {
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setTitle('');
        setDescription('');
        setError(null);
    }, [open]);

    const submit = async () => {
        if (busy) return;
        setBusy(true);
        setError(null);
        try {
            await withSecrecy(() => ws.send('project.deployTrigger', { projectId, title, description }));
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
            description='L’action est enregistrée dans les journaux et dans l’historique du projet.'
            width={520}
            onSubmit={submit}
            holdSecrecy
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
                        maxLength={PROJECT_DEPLOY_TITLE_MAX_LENGTH}
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

export default Deploy;
