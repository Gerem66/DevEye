import { useEffect, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    CopyButton,
    humanizeError,
    settingsStyles as shell,
    type ConfirmRequest
} from 'deveye-sdk-client';

import { api } from './api';
import styles from './style.module.css';

/**
 * L'adresse d'appel d'un service, à coller dans une CI : lue à la demande
 * (elle ne voyage pas avec la liste, qu'un membre en lecture reçoit aussi),
 * copiable, et régénérée quand elle a fuité.
 */
export default function DeployHookField({ serviceId, disabled }: { serviceId: number; disabled?: boolean }) {
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

    useEffect(() => {
        void api
            .send('uptime.deployHook', { id: serviceId })
            .then((res) => setUrl(res.url))
            .catch((e) => setError(humanizeError(e, 'L’adresse n’a pas pu être lue.')));
    }, [serviceId]);

    const regenerate = async () => {
        setConfirm(null);
        setBusy(true);
        setError(null);
        try {
            setUrl((await api.send('uptime.deployHook', { id: serviceId, regenerate: true })).url);
        } catch (e) {
            setError(humanizeError(e, 'L’adresse n’a pas pu être régénérée.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={shell.field}>
            <span className={shell.sectionLabel}>Adresse d’appel</span>
            {url ? (
                <div className={styles.hookRow}>
                    <code className={styles.hookUrl}>{url}</code>
                    <CopyButton value={url} label='Copier l’adresse d’appel' />
                </div>
            ) : (
                !error && <span className={shell.fieldHint}>Chargement…</span>
            )}
            {url && (
                <span className={shell.fieldHint}>
                    À appeler par un POST en fin de mise en ligne : <code>curl -fsS -X POST</code> suivi de l’adresse.
                    Gardez-la dans les secrets de votre CI, jamais sur le serveur surveillé : qui la détient fait
                    accepter une version.
                </span>
            )}
            {error && <span className={shell.notice}>{error}</span>}
            <div className={shell.sectionActions}>
                <Button
                    variant='secondary'
                    icon='refresh'
                    disabled={disabled || busy}
                    onClick={() =>
                        setConfirm({
                            title: 'Régénérer l’adresse d’appel ?',
                            description:
                                'L’adresse actuelle cesse aussitôt de répondre : remplacez-la dans votre CI avec la nouvelle.',
                            confirmLabel: 'Régénérer',
                            tone: 'primary',
                            onConfirm: () => void regenerate()
                        })
                    }
                >
                    Régénérer
                </Button>
            </div>
            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
