import { useResource } from 'deveye-sdk-client';

import { api } from './api';
import styles from './pdf.module.css';

/** La carte de l'accueil : ce que l'atelier fait, et combien de signatures sont gardées. */
export function PdfWidget() {
    const { data } = useResource(
        'pdf.signatures',
        () => api.send('pdf.signatures', {}).then((r) => r.signatures),
        'Impossible de charger vos signatures gardées.'
    );
    const count = data?.length ?? 0;
    return (
        <div className={styles.widget}>
            <p className={styles.widgetText}>Fusionner, trier, signer, remplir, protéger. Rien n’est envoyé.</p>
            {count > 0 && (
                <p className={styles.widgetMeta}>
                    {count} signature{count > 1 ? 's' : ''} gardée{count > 1 ? 's' : ''}
                </p>
            )}
        </div>
    );
}
