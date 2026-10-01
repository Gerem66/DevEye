import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, LogOutput } from 'deveye-sdk-client';
import type { DeployStatus } from '../contracts/domain';

import { api } from './api';
import { LOG_TIMEOUT_MS, providerError } from './format';
import styles from './style.module.css';

/** Cadence de relecture d'un journal qui s'écrit encore. */
const FOLLOW_INTERVAL_MS = 5_000;

/** La ligne dont on lit le journal, et son état au moment du clic. */
export interface LogsTarget {
    externalId: string;
    running: boolean;
}

/**
 * Le déploiement dont on lit le journal tourne encore : d'après la ligne relue
 * quand l'appelant en a une, sinon d'après l'état au moment du clic. C'est ce
 * qui arrête le suivi quand la ligne passe en succès ou en échec.
 */
export function isLogLive(
    logsFor: LogsTarget | null,
    rows: readonly { externalId: string | null; status: DeployStatus }[] | null | undefined
): boolean {
    if (logsFor === null) return false;
    const row = rows?.find((r) => r.externalId === logsFor.externalId);
    return row ? row.status === 'running' : logsFor.running;
}

interface LogsDialogProps {
    open: boolean;
    targetId: number | null;
    /** L'identifiant chez le fournisseur : celui d'une ligne de `deploy.history`. */
    externalId: string | null;
    /** Le déploiement tourne encore : le journal se relit tout seul. */
    live: boolean;
    onClose: () => void;
}

/**
 * Le journal complet d'un déploiement, relu chez le fournisseur. Chez Dokploy,
 * par un point d'entrée non documenté (voir l'adaptateur) qu'une instance peut
 * refuser, d'où le message tel que le fournisseur l'a formulé (`providerError`,
 * pas `humanizeError`).
 */
export function LogsDialog({ open, targetId, externalId, live, onClose }: LogsDialogProps) {
    const [log, setLog] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    /** Lu par le minuteur du suivi, qui ne doit pas dépendre du rendu. */
    const busyRef = useRef(false);
    /** La lecture la plus récente : une réponse en retard d'une autre ligne ne s'affiche pas. */
    const seqRef = useRef(0);

    const load = useCallback(() => {
        if (targetId === null || externalId === null) return;
        const seq = ++seqRef.current;
        busyRef.current = true;
        setBusy(true);
        setError(null);
        api.send('deploy.log', { targetId, externalId }, { timeoutMs: LOG_TIMEOUT_MS })
            .then((res) => {
                if (seqRef.current === seq) setLog(res.log);
            })
            .catch((e) => {
                if (seqRef.current === seq) setError(providerError(e, 'Impossible de charger le journal.'));
            })
            .finally(() => {
                if (seqRef.current !== seq) return;
                busyRef.current = false;
                setBusy(false);
            });
    }, [targetId, externalId]);

    // Une nouvelle ligne ouverte reprend de zéro : le journal d'une autre
    // cible ne doit jamais s'afficher un instant sous le mauvais titre.
    useEffect(() => {
        if (!open) return;
        setLog(null);
        setError(null);
        load();
    }, [open, load]);

    // Le suivi : une relecture par intervalle tant que la ligne tourne, jamais deux en vol.
    useEffect(() => {
        if (!open || !live) return;
        const iv = setInterval(() => {
            if (!busyRef.current) load();
        }, FOLLOW_INTERVAL_MS);
        return () => clearInterval(iv);
    }, [open, live, load]);

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Journal du déploiement'
            width={1200}
            tall
            footer={
                <>
                    {live && (
                        <span className={styles.logLive} role='status'>
                            <span className={styles.logLiveDot} aria-hidden='true' />
                            Suivi en direct, toutes les 5 s
                        </span>
                    )}
                    <Button variant='secondary' onClick={load} disabled={busy}>
                        Recharger
                    </Button>
                    <Button onClick={onClose}>Fermer</Button>
                </>
            }
        >
            {error && <p className={styles.error}>{error}</p>}
            {/* Une relecture qui échoue garde le journal lu avant elle. */}
            {(log !== null || !error) && (
                <LogOutput
                    text={log ?? ''}
                    busy={busy && log === null}
                    emptyText='Journal vide.'
                    className={styles.logOutput}
                    aria-label='Journal du déploiement'
                />
            )}
        </Dialog>
    );
}

export default LogsDialog;
