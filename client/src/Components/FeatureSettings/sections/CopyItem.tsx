import { useMemo, useState } from 'react';
import { itemNounForms, type FeatureId } from '@deveye/types';

import { WsError } from '@/api/ws';
import { humanizeError } from '@/api/useResource';
import Button from '@/Components/Button';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import { ProgressDialog } from '@/Components/ProgressDialog';
import SelectInput from '@/Components/SelectInput';
import { moduleManifest } from '@/sdk/registry';
import { invalidate, type ResourceKey } from '@/stores/invalidation';
import { isRemoteUsable, useRemoteInstances, useRemotePing } from '@/stores/remoteInstances';
import { UnlockCancelledError } from '@/stores/secrecy';
import { useWorkspaceState, workspaceKey } from '@/stores/workspace';

import { copyItem, previewCopy, type CopyDestination, type CopyStep } from '../copyItem';
import styles from '../FeatureSettings.module.css';

interface Props {
    feature: FeatureId;
    itemId: string;
}

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
export default function CopyItem({ feature, itemId }: Props) {
    const { workspaces, remoteWorkspaces, activeId, activeInstanceId } = useWorkspaceState();
    const remotes = useRemoteInstances();
    useRemotePing(true);
    const [choice, setChoice] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [progress, setProgress] = useState<{ step: CopyStep; value: number } | null>(null);
    const { dem, Dem } = itemNounForms(feature);

    const targets = useMemo<Target[]>(() => {
        const here = workspaces.map((w) => ({
            key: workspaceKey({ instanceId: null, id: w.id }),
            instanceId: null,
            workspaceId: w.id,
            instanceLabel: 'cette instance',
            name: activeInstanceId === null && w.id === activeId ? `${w.name} (cet espace)` : w.name,
            unavailable: null
        }));
        const elsewhere = remotes.flatMap((entry) =>
            (remoteWorkspaces[entry.instance.id] ?? []).map((w) => ({
                key: workspaceKey({ instanceId: entry.instance.id, id: w.id }),
                instanceId: entry.instance.id,
                workspaceId: w.id,
                instanceLabel: entry.instance.label,
                name: `${w.name} · ${entry.instance.label}`,
                unavailable: isRemoteUsable(entry) ? null : 'injoignable'
            }))
        );
        return [...here, ...elsewhere];
    }, [workspaces, remoteWorkspaces, remotes, activeId, activeInstanceId]);

    const explain = (e: unknown, fallback: string): string => {
        if (e instanceof UnlockCancelledError) return 'Copie annulée : le mot de passe n’a pas été saisi.';
        if (e instanceof WsError && e.code === 'closed') return 'Cette instance ne répond plus.';
        return humanizeError(e, fallback);
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
                    setError(blocker);
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
        setProgress({ step: 'read', value: 0 });
        void copyItem(feature, itemId, to, (step, value) => setProgress({ step, value }))
            .then(() => {
                setDone(`${Dem} a été copié dans « ${workspaceName} ».`);
                // Copié dans l'espace où l'on se trouve, sa liste vient de changer.
                for (const key of moduleManifest(feature)?.resources ?? []) invalidate(key as ResourceKey);
            })
            .catch((e: unknown) => setError(explain(e, `Copie vers « ${workspaceName} » impossible.`)))
            .finally(() => {
                setProgress(null);
                setBusy(false);
            });
    };

    return (
        <div className={styles.field}>
            <span className={styles.fieldLabel}>Copier vers</span>
            <div className={styles.fieldWithAction}>
                <SelectInput
                    value={choice}
                    disabled={busy}
                    aria-label={`Copier ${dem} vers`}
                    onChange={(e) => setChoice(e.target.value)}
                >
                    <option value=''>Choisir un espace…</option>
                    {targets.map((t) => (
                        <option key={t.key} value={t.key} disabled={t.unavailable !== null}>
                            {t.unavailable ? `${t.name} (${t.unavailable})` : t.name}
                        </option>
                    ))}
                </SelectInput>
                <Button variant='secondary' disabled={busy || choice === ''} onClick={ask}>
                    Copier…
                </Button>
            </div>
            <span className={styles.fieldHint}>
                Un double indépendant, dans un autre de vos espaces ou sur une instance distante où vous êtes connecté.
                Ce qu’il n’emporte pas est nommé avant confirmation.
            </span>
            {error && <p className={styles.notice}>{error}</p>}
            {done && <p className={styles.sectionHint}>{done}</p>}

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />

            {/* Rien ne ferme ce dialogue : quitter en cours de route laisserait un
                transfert à moitié fait, que la destination finirait par jeter. */}
            <ProgressDialog
                open={progress !== null}
                title='Copie en cours'
                description={`${Dem} est lu ici, transféré par ce navigateur, puis écrit dans l’espace d’arrivée.`}
                value={progress?.value}
                step={progress ? STEP_LABEL[progress.step] : undefined}
            />
        </div>
    );
}
