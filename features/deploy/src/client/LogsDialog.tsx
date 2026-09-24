import { useEffect, useState } from 'react';
import { Button, Dialog } from 'deveye-sdk-client';

import { api } from './api';
import { LOG_TIMEOUT_MS, providerError } from './format';
import styles from './style.module.css';

interface LogsDialogProps {
    open: boolean;
    targetId: number | null;
    /** L'identifiant chez le fournisseur : celui d'une ligne de `deploy.history`. */
    externalId: string | null;
    onClose: () => void;
}

/**
 * Le journal complet d'un déploiement, relu chez le fournisseur. Chez Dokploy,
 * par un point d'entrée non documenté (voir l'adaptateur) qu'une instance peut
 * refuser, d'où le message tel que le fournisseur l'a formulé (`providerError`,
 * pas `humanizeError`).
 */
export function LogsDialog({ open, targetId, externalId, onClose }: LogsDialogProps) {
    const [log, setLog] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = () => {
        if (targetId === null || externalId === null) return;
        setBusy(true);
        setError(null);
        api.send('deploy.log', { targetId, externalId }, { timeoutMs: LOG_TIMEOUT_MS })
            .then((res) => setLog(res.log))
            .catch((e) => setError(providerError(e, 'Impossible de charger le journal.')))
            .finally(() => setBusy(false));
    };

    // Une nouvelle ligne ouverte reprend de zéro : le journal d'une autre
    // cible ne doit jamais s'afficher un instant sous le mauvais titre.
    useEffect(() => {
        if (!open) return;
        setLog(null);
        setError(null);
        load();
    }, [open, targetId, externalId]);

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Journal du déploiement'
            width={1200}
            fill
            footer={
                <>
                    <Button variant='secondary' onClick={load} disabled={busy}>
                        Recharger
                    </Button>
                    <Button onClick={onClose}>Fermer</Button>
                </>
            }
        >
            {error ? (
                <p className={styles.error}>{error}</p>
            ) : log === null ? (
                <p className={styles.empty}>{busy ? 'Chargement…' : 'Rien à afficher.'}</p>
            ) : log === '' ? (
                <p className={styles.empty}>Journal vide.</p>
            ) : (
                <pre className={styles.logBox}>{log}</pre>
            )}
        </Dialog>
    );
}

export default LogsDialog;
