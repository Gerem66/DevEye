import { useResource } from 'deveye-sdk-client';

import { api } from './api';
import styles from './style.module.css';

const plural = (count: number, one: string, many: string): string => `${count} ${count > 1 ? many : one}`;

/** La carte de l'accueil : ce qui tourne, et ce qui attend d'être récupéré avant de quitter le serveur. */
export function ConvertWidget() {
    const { data } = useResource(
        'convert.list',
        () => api.send('convert.list', {}).then((r) => r.jobs),
        'Impossible de charger vos conversions.'
    );
    const running =
        data?.filter((j) => j.phase === 'queued' || j.phase === 'running' || j.phase === 'uploading').length ?? 0;
    const ready = data?.filter((j) => j.phase === 'done').length ?? 0;

    return (
        <div className={styles.widget}>
            {data === null ? (
                'Chargement…'
            ) : running === 0 && ready === 0 ? (
                'Vidéos, images, sons, documents, devises et unités.'
            ) : (
                <>
                    {running > 0 && <div>{plural(running, 'conversion en cours', 'conversions en cours')}</div>}
                    {ready > 0 && (
                        <div className={styles.widgetReady}>
                            {plural(ready, 'fichier prêt à récupérer', 'fichiers prêts à récupérer')}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
