import { useMemo, useState } from 'react';
import { itemNounForms, type FeatureId } from '@deveye/types';

import { WsError } from '@/api/ws';
import { errorNote } from '@/api/useResource';
import Button from '@/Components/Button';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import ErrorNote, { type ErrorNoteInput } from '@/Components/ErrorNote';
import SearchSelect from '@/Components/SearchSelect';
import { TaskProgress } from '@/Components/TaskDialog';
import { moduleManifest } from '@/sdk/registry';
import { useRemoteTargets } from '@/sdk/remoteTargets';
import { runTask } from '@/sdk/tasks';
import { invalidate, type ResourceKey } from '@/stores/invalidation';
import { UnlockCancelledError } from '@/stores/secrecy';
import { TaskError, useTaskRecords } from '@/stores/tasks';
import { useWorkspacesHere, useWorkspaceState, workspaceKey } from '@/stores/workspace';

import { copyItem, previewCopy, type CopyDestination, type CopyStep } from '../copyItem';
import styles from '../FeatureSettings.module.css';

interface Props {
    feature: FeatureId;
    itemId: string;
    /** Le nom de l'élément, pour la ligne de sa copie dans la zone des opérations. */
    itemLabel?: string;
}

/** Le serveur ne tient qu'un transfert par compte : le suivant chasserait celui qui court. */
const COPY_KEY = 'share.copy';

interface Target extends CopyDestination {
    key: string;
    name: string;
    /** Pourquoi on ne peut pas y copier maintenant ; `null` quand on le peut. */
    unavailable: string | null;
}

const STEP_LABEL: Record<CopyStep, string> = {
    read: 'Lecture de l’élément…',
    transfer: 'Transfert…',
    write: 'Écriture dans l’espace d’arrivée…'
};

/**
 * « Copier vers » : l'élément reste ici, un double naît ailleurs, dans un espace
 * d'ici ou d'une instance distante. Rien ne relie ensuite les deux.
 */
export default function CopyItem({ feature, itemId, itemLabel }: Props) {
    const { activeId, activeInstanceId } = useWorkspaceState();
    // Les espaces de l'instance de l'élément, puis ceux des autres instances.
    const workspaces = useWorkspacesHere();
    const { workspaces: remote } = useRemoteTargets();
    const [choice, setChoice] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    // Quel que soit l'élément ou l'espace d'où elle est partie.
    const copies = useTaskRecords().filter((task) => task.state === 'running' && task.key === COPY_KEY);
    const copying = copies.length > 0;
    const { dem, Dem } = itemNounForms(feature);

    const targets = useMemo<Target[]>(() => {
        const here = workspaces.map((w) => ({
            key: workspaceKey({ instanceId: activeInstanceId, id: w.id }),
            instanceId: activeInstanceId,
            workspaceId: w.id,
            instanceLabel: 'cette instance',
            name: w.id === activeId ? `${w.name} (cet espace)` : w.name,
            unavailable: null
        }));
        const elsewhere = remote.map((t) => ({
            key: t.key,
            instanceId: t.instanceId,
            workspaceId: t.workspaceId,
            instanceLabel: t.instanceLabel,
            name: `${t.workspaceName} · ${t.instanceLabel}`,
            unavailable: t.unavailable
        }));
        return [...here, ...elsewhere];
    }, [workspaces, remote, activeId, activeInstanceId]);

    const explain = (e: unknown, fallback: string): ErrorNoteInput => {
        if (e instanceof UnlockCancelledError) {
            return { message: 'Copie annulée : le mot de passe n’a pas été saisi.', code: 'locked' };
        }
        if (e instanceof WsError && e.code === 'closed')
            return { message: 'Cette instance ne répond plus.', code: 'closed' };
        return errorNote(e, fallback);
    };

    const ask = (): void => {
        const to = targets.find((t) => t.key === choice);
        if (!to) return;
        setBusy(true);
        setError(null);
        setDone(null);
        void previewCopy(feature, itemId, to)
            .then(({ plan, target }) => {
                const blocker = plan.blockers[0] ?? target.blockers[0];
                if (blocker) {
                    setError({ message: blocker, code: 'conflict' });
                    return;
                }
                setConfirm({
                    title: `Copier vers « ${target.workspaceName} » ?`,
                    confirmLabel: 'Copier',
                    tone: 'primary',
                    description: (
                        <>
                            <p>
                                {Dem} reste ici. Un double est créé dans « {target.workspaceName} », chiffré sous la clé
                                de cet espace. Les deux vivent ensuite chacun leur vie.
                            </p>
                            {plan.tier === 'private' && target.tier === 'open' && (
                                <p>
                                    Ici, {dem} est chiffré par votre mot de passe. « {target.workspaceName} » est un
                                    espace partagé, qui n’a pas ce niveau de protection : ses membres pourront lire la
                                    copie.
                                </p>
                            )}
                            {plan.carries.length > 0 && (
                                <>
                                    <p>La copie emporte aussi :</p>
                                    <ul className={styles.usageList}>
                                        {plan.carries.map((line) => (
                                            <li key={line}>{line}</li>
                                        ))}
                                    </ul>
                                </>
                            )}
                            {plan.drops.length > 0 && (
                                <>
                                    <p>La copie n’emporte pas :</p>
                                    <ul className={styles.usageList}>
                                        {plan.drops.map((line) => (
                                            <li key={line}>{line}</li>
                                        ))}
                                    </ul>
                                </>
                            )}
                        </>
                    ),
                    onConfirm: () => run(to, target.workspaceName)
                });
            })
            .catch((e: unknown) => setError(explain(e, 'Copie impossible à préparer.')))
            .finally(() => setBusy(false));
    };

    const run = (to: Target, workspaceName: string): void => {
        setConfirm(null);
        setBusy(true);
        const copied = `Une copie de ${dem} est maintenant dans « ${workspaceName} ».`;
        const refused = `Copie vers « ${workspaceName} » impossible.`;
        const abort = new AbortController();
        // Le transfert passe par ce navigateur : réduit, il continue, mais
        // fermer l'onglet le laisserait à moitié fait, que la destination jette.
        void runTask(
            {
                feature,
                itemId,
                key: COPY_KEY,
                title: 'Copie vers un autre espace',
                subject: itemLabel ? `« ${itemLabel} » vers « ${workspaceName} »` : `Vers « ${workspaceName} »`,
                description: 'Lecture ici, transfert par ce navigateur, puis écriture dans l’espace d’arrivée.',
                local: true,
                done: copied,
                failed: (e) => explain(e, refused),
                cancel: () => abort.abort()
            },
            (task) =>
                copyItem(feature, itemId, to, (step, value) => task.report({ value, step: STEP_LABEL[step] }), {
                    signal: abort.signal,
                    beforePrompt: task.raise
                })
        )
            .then(() => {
                setDone(copied);
                // Copié dans l'espace où l'on se trouve, sa liste vient de changer.
                for (const key of moduleManifest(feature)?.resources ?? []) invalidate(key as ResourceKey);
            })
            .catch((e: unknown) => {
                if (e instanceof TaskError && e.code === 'cancelled') return;
                setError(explain(e, refused));
            })
            .finally(() => setBusy(false));
    };

    return (
        <div className={styles.field}>
            <span className={styles.fieldLabel}>Copier vers</span>
            <div className={styles.fieldWithAction}>
                <SearchSelect
                    value={choice}
                    disabled={busy}
                    aria-label={`Copier ${dem} vers`}
                    placeholder='Choisir un espace…'
                    options={targets.map((t) => ({
                        value: t.key,
                        label: t.name,
                        detail: t.unavailable ?? undefined,
                        disabled: t.unavailable !== null
                    }))}
                    onChange={setChoice}
                />
                <Button variant='secondary' disabled={busy || copying || choice === ''} onClick={ask}>
                    Copier…
                </Button>
            </div>
            <span className={styles.fieldHint}>
                {copying
                    ? 'Une copie est déjà en cours : attendez sa fin pour en lancer une autre.'
                    : 'Un double indépendant, dans un autre de vos espaces ou sur une instance distante où vous êtes connecté. Ce qu’il n’emporte pas est nommé avant confirmation.'}
            </span>
            {/* La barre du haut est sous le voile des réglages : la copie réduite se suit ici. */}
            {copies.map((task) => (
                <TaskProgress key={task.id} task={task} />
            ))}
            <ErrorNote note={error} />
            {done && <p className={styles.sectionHint}>{done}</p>}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
