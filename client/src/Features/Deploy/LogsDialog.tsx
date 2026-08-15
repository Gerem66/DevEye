import { useEffect, useState } from 'react';
import { Button, Dialog } from '@/Components';
import { ws } from '@/api/ws';
import { dokployError, DOKPLOY_LOG_TIMEOUT_MS } from './format';
import styles from './style.module.css';

interface LogsDialogProps {
    open: boolean;
    targetId: number | null;
    /** L'identifiant chez Dokploy — celui d'une ligne de `deploy.history`. */
    externalId: string | null;
    onClose: () => void;
}

/**
 * Le journal complet d'un déploiement, tel que Dokploy l'a produit.
 *
 * Rejoué depuis un point d'entrée de Dokploy qui n'a rien d'officiel (aucune
 * procédure tRPC ne le documente — voir l'adaptateur) : une instance qui
 * l'authentifie autrement que le reste de l'API peut le refuser. L'état
 * d'erreur montre donc le message tel que Dokploy (ou le réseau) l'a formulé
 * (`dokployError`, pas `humanizeError`) — c'est souvent la seule piste pour
 * distinguer un refus d'authentification d'une instance simplement injoignable.
 */
export function LogsDialog({ open, targetId, externalId, onClose }: LogsDialogProps) {
    const [log, setLog] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = () => {
        if (targetId === null || externalId === null) return;
        setBusy(true);
        setError(null);
        ws.send('deploy.log', { targetId, externalId }, { timeoutMs: DOKPLOY_LOG_TIMEOUT_MS })
            .then((res) => setLog(res.log))
            .catch((e) => setError(dokployError(e, 'Impossible de charger le journal.')))
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
