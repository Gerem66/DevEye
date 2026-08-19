import { useEffect, useState } from 'react';

import { ws } from '@/api/ws';
import { useResourceVersion } from '@/stores/invalidation';
import { useActiveWorkspace } from '@/stores/workspace';
import styles from './style.module.css';

/**
 * Carte compacte de l'accueil : combien de travaux tournent, et combien sont
 * tombés.
 *
 * Contrairement aux autres tuiles de comptage, celle-ci montre **l'échec**, et
 * c'est toute sa raison d'être. Un compteur de sauvegardes qui affiche « 4
 * travaux » quand trois d'entre eux échouent depuis une semaine serait pire
 * qu'aucune carte : il donnerait la sensation d'être couvert. C'est le même
 * arbitrage que la carte Sentinelle, qui compte par gravité plutôt qu'en bloc.
 */
export function BackupWidget() {
    const workspace = useActiveWorkspace();
    const version = useResourceVersion('backup.count');
    const [state, setState] = useState<{ count: number; failing: number } | null>(null);

    useEffect(() => {
        if (!workspace) return;
        let cancelled = false;

        const load = () => {
            ws.send('backup.count', {})
                .then((res) => {
                    if (!cancelled) setState({ count: res.count, failing: res.failing });
                })
                // On garde la dernière valeur connue plutôt que de retomber sur
                // « 0 » : un zéro trompeur sur une carte de sauvegardes se lit
                // « rien à sauvegarder », ce qui n'est jamais la vérité.
                .catch(() => undefined);
        };

        if (ws.state === 'open') load();
        const off = ws.onStateChange((s) => {
            if (s === 'open') load();
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [workspace, version]);

    const loading = state === null;
    const count = state?.count ?? 0;
    const failing = state?.failing ?? 0;

    return (
        <div className={styles.widget}>
            <div className={styles.widgetStat}>
                <span className={styles.widgetValue} data-tone={failing > 0 ? 'danger' : 'neutral'}>
                    {loading ? '—' : count}
                </span>
                <span className={styles.widgetLabel}>travail{count > 1 ? 'x' : ''}</span>
            </div>
            <span className={styles.widgetFoot}>
                {loading
                    ? 'Chargement…'
                    : count === 0
                      ? 'Aucune sauvegarde programmée'
                      : failing > 0
                        ? `${failing} en échec au dernier passage`
                        : 'Dernier passage réussi'}
            </span>
        </div>
    );
}

export default BackupWidget;
