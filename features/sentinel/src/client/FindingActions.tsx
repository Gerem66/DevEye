import { useState } from 'react';
import { Button, TextInput } from 'deveye-sdk-client';

import type { AllowScope } from '../contracts/domain';

import styles from './style.module.css';

/** Une action asynchrone et son état : occupé, ou l'échec à dire. */
export function useAction() {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function run(action: () => Promise<void>): Promise<void> {
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch {
            setError("L'action n'a pas abouti.");
        } finally {
            setBusy(false);
        }
    }

    return { busy, error, run };
}

interface Props {
    /** Combien de constats l'action touche : les libellés passent au pluriel au-delà d'un. */
    count: number;
    /** Au moins un constat ouvert : « réglé » a de quoi fermer. */
    canResolve: boolean;
    onAcknowledge: (scope: AllowScope, reason: string | null) => Promise<void>;
    onResolve: () => Promise<void>;
}

/**
 * Les deux réponses à un constat, ou à tout un groupe : « c'est réglé » (corrigé,
 * pas devenu normal) et « légitime » (une autorisation, ici ou partout).
 */
export default function FindingActions({ count, canResolve, onAcknowledge, onResolve }: Props) {
    const [reason, setReason] = useState('');
    const { busy, error, run } = useAction();
    const many = count > 1;

    return (
        <div className={styles.actions}>
            {error && <p className={styles.error}>{error}</p>}

            {canResolve && (
                <div className={styles.settled}>
                    <p className={styles.settledNote}>
                        {many
                            ? 'Corrigés ? Fermez-les sans les déclarer normaux : chacun rouvrira de lui-même si sa situation revient.'
                            : 'Corrigé ? Fermez-le sans le déclarer normal : il rouvrira de lui-même si la situation revient.'}
                    </p>
                    <Button variant='secondary' icon='check-circle' disabled={busy} onClick={() => void run(onResolve)}>
                        {many ? 'Tout est réglé' : 'C’est réglé'}
                    </Button>
                </div>
            )}

            {many && (
                <p className={styles.settledNote}>Les {count} constats seront jugés légitimes, avec la même raison.</p>
            )}
            <label className={styles.field}>
                <span className={styles.fieldLabel}>Raison (facultatif)</span>
                <TextInput
                    value={reason}
                    maxLength={255}
                    placeholder='ex. installé par nos soins le 3 mars'
                    onChange={(e) => setReason(e.target.value)}
                />
            </label>
            <div className={styles.actionRow}>
                <Button
                    variant='secondary'
                    disabled={busy}
                    onClick={() => void run(() => onAcknowledge('device', reason.trim() || null))}
                >
                    {many ? 'Légitimes ici' : 'Légitime ici'}
                </Button>
                <Button
                    variant='ghost'
                    disabled={busy}
                    onClick={() => void run(() => onAcknowledge('fleet', reason.trim() || null))}
                >
                    {many ? 'Légitimes partout' : 'Légitime partout'}
                </Button>
            </div>
        </div>
    );
}
