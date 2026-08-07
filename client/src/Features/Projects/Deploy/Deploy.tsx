import { useCallback, useEffect, useState } from 'react';
import type {
    DeployCandidate,
    DeployStatus,
    MinimalUser,
    Project,
    ProjectCredential,
    ProjectDeployTarget,
    ProjectDeployment
} from 'deveye-types';
import { PROJECT_DEPLOY_TITLE_MAX_LENGTH } from 'deveye-types';
import { Button, Dialog, SelectInput, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { invalidate, useResourceVersion } from '@/stores/invalidation';
import { humanizeError, withSecrecy } from '../api';
import { Avatar } from '../Board/Avatar';
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
 */
export function Deploy({ project, members, canWrite }: DeployProps) {
    const [target, setTarget] = useState<ProjectDeployTarget | null>(null);
    const [deployments, setDeployments] = useState<ProjectDeployment[]>([]);
    const [credentials, setCredentials] = useState<ProjectCredential[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [linkOpen, setLinkOpen] = useState(false);
    const [triggerOpen, setTriggerOpen] = useState(false);
    const [busy, setBusy] = useState(false);

    const version = useResourceVersion('project.board');
    const guarded = project.securityTier === 'guarded';

    const load = useCallback(async () => {
        try {
            const [t, creds] = await Promise.all([
                withSecrecy(() => ws.send('project.deployGet', { projectId: project.id })),
                ws.send('project.credentialList', {})
            ]);
            setTarget(t.target);
            setCredentials(creds.credentials.filter((c) => c.provider === 'dokploy'));
            const list = await withSecrecy(() => ws.send('project.deployList', { projectId: project.id }));
            setDeployments(list.deployments);
            setError(null);
        } catch (e) {
            setError(humanizeError(e, 'Impossible de charger le déploiement.'));
        } finally {
            setLoaded(true);
        }
    }, [project.id]);

    useEffect(() => {
        void load();
    }, [load, version]);

    if (guarded) {
        return (
            <p className={styles.empty}>
                Ce projet est confidentiel : il ne peut pas être relié à un déploiement, car le suivi tourne sans
                session et n’a pas accès à sa clé.
            </p>
        );
    }

    if (!loaded) return <p className={styles.empty}>Chargement…</p>;

    return (
        <div className={styles.git}>
            {error && <p className={styles.error}>{error}</p>}

            {!target && (
                <div className={styles.gitEmpty}>
                    <p className={styles.empty}>Aucune application liée à ce projet.</p>
                    {canWrite && (
                        <Button icon='add' onClick={() => setLinkOpen(true)} disabled={credentials.length === 0}>
                            Lier une application
                        </Button>
                    )}
                    {credentials.length === 0 && (
                        <p className={styles.hint}>
                            Ajoutez d’abord un accès Dokploy (adresse de l’instance + clé d’API) depuis l’onglet Git.
                        </p>
                    )}
                </div>
            )}

            {target && (
                <>
                    <header className={styles.repoHead}>
                        <div>
                            <p className={styles.repoName}>
                                <span className='icon icon-rocket' /> {target.name}
                            </p>
                            <p className={styles.repoMeta}>
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
                            </div>
                        )}
                    </header>

                    <section>
                        <h3 className={styles.gitTitle}>Déploiements</h3>
                        {deployments.length === 0 && <p className={styles.empty}>Aucun déploiement déclenché d’ici.</p>}
                        <ul className={styles.gitList}>
                            {deployments.map((d) => (
                                <li key={d.id}>
                                    <span className={styles.deployStatus} data-status={d.status}>
                                        {STATUS_LABELS[d.status]}
                                    </span>
                                    <span className={styles.gitItemName}>{d.title}</span>
                                    {d.triggeredByUserId !== null && (
                                        <Avatar user={members.find((m) => m.id === d.triggeredByUserId)} size={18} />
                                    )}
                                    <span className={styles.gitDate}>
                                        {new Date(d.startedAt * 1000).toLocaleString('fr-FR')}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </section>
                </>
            )}

            <LinkDialog
                open={linkOpen}
                projectId={project.id}
                credentials={credentials}
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
        </div>
    );
}

interface LinkDialogProps {
    open: boolean;
    projectId: number;
    credentials: ProjectCredential[];
    current: ProjectDeployTarget | null;
    onClose: () => void;
    onSaved: () => void;
}

function LinkDialog({ open, projectId, credentials, current, onClose, onSaved }: LinkDialogProps) {
    const [credentialId, setCredentialId] = useState('');
    const [candidates, setCandidates] = useState<DeployCandidate[]>([]);
    const [externalId, setExternalId] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setCredentialId(current?.credentialId ? String(current.credentialId) : String(credentials[0]?.id ?? ''));
        setExternalId(current?.externalId ?? '');
        setCandidates([]);
        setError(null);
    }, [open, current, credentials]);

    // La liste des applications vient de l'instance : c'est la seule commande du
    // module qui appelle un service externe en direct, parce qu'attendre un tour
    // d'ordonnanceur pour remplir un sélecteur n'aurait aucun sens.
    const loadCandidates = async () => {
        if (!credentialId) return;
        setBusy(true);
        setError(null);
        try {
            const res = await ws.send('project.deployCandidates', { credentialId: Number(credentialId) });
            setCandidates(res.candidates);
            if (res.candidates.length === 0) setError('Cette instance ne déclare aucune application.');
        } catch (e) {
            setError(humanizeError(e, 'Impossible de joindre l’instance Dokploy.'));
        } finally {
            setBusy(false);
        }
    };

    const submit = async () => {
        const chosen = candidates.find((c) => c.externalId === externalId);
        if (busy || !credentialId || !externalId) return;
        setBusy(true);
        setError(null);
        try {
            await withSecrecy(() =>
                ws.send('project.deployLink', {
                    projectId,
                    credentialId: Number(credentialId),
                    // Une cible saisie à la main est supposée être une
                    // application : c'est le repli, et le sélecteur donne le
                    // vrai type dès qu'on passe par lui.
                    kind: chosen?.kind ?? 'application',
                    externalId,
                    name: chosen?.name ?? externalId
                })
            );
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'La liaison a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Lier une cible de déploiement'
            width={560}
            onSubmit={submit}
            holdSecrecy
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || !externalId}>
                        {busy ? 'Enregistrement…' : 'Lier'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <label className={styles.field}>
                    <span className={styles.label}>Instance Dokploy</span>
                    <SelectInput value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                        {credentials.map((c) => (
                            <option key={c.id} value={c.id}>
                                {c.label} — {c.baseUrl}
                            </option>
                        ))}
                    </SelectInput>
                </label>

                <Button variant='secondary' icon='refresh' onClick={() => void loadCandidates()} disabled={busy}>
                    {busy ? 'Interrogation…' : 'Lister les applications'}
                </Button>

                {candidates.length > 0 && (
                    <label className={styles.field}>
                        <span className={styles.label}>Cible</span>
                        <SelectInput value={externalId} onChange={(e) => setExternalId(e.target.value)}>
                            <option value=''>Choisir…</option>
                            {candidates.map((c) => (
                                <option key={`${c.kind}:${c.externalId}`} value={c.externalId}>
                                    {c.kind === 'compose' ? '🧩 ' : '📦 '}
                                    {c.name}
                                    {c.path ? ` — ${c.path}` : ''}
                                </option>
                            ))}
                        </SelectInput>
                    </label>
                )}

                {/* Repli manuel : si l'instance répond dans une forme que le
                    décodeur ne reconnaît pas, on doit quand même pouvoir lier. */}
                <label className={styles.field}>
                    <span className={styles.label}>…ou identifiant de cible</span>
                    <TextInput
                        value={externalId}
                        placeholder='applicationId ou composeId'
                        onChange={(e) => setExternalId(e.target.value)}
                    />
                </label>

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
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
