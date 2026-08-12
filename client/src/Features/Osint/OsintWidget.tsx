import { useEffect, useState } from 'react';
import type { OsintHistoryEntry } from 'deveye-types';

import { ws } from '@/api/ws';
import { useResourceVersion } from '@/stores/invalidation';
import { useSecrecy } from '@/stores/secrecy';
import { useActiveWorkspace } from '@/stores/workspace';

import styles from './Osint.module.css';

/**
 * Carte de la grille : la dernière cible cherchée.
 *
 * Elle n'appelle **pas** `withSecrecy` — délibérément. La carte d'accueil ne
 * doit jamais déclencher l'invite de mot de passe : elle s'affiche au chargement
 * du tableau de bord, et réclamer le coffre pour peupler une vignette serait
 * intrusif.
 *
 * Elle écoute en revanche le store de verrou, qui est global : quand le mot de
 * passe est saisi n'importe où — la pastille de la topbar, une autre feature —
 * la vignette repasse d'elle-même de « chiffré » à la vraie dernière cible,
 * sans rechargement.
 */
export function OsintWidget(): React.ReactElement {
    const workspace = useActiveWorkspace();
    const version = useResourceVersion('osint.history');
    const { unlocked } = useSecrecy();
    const [entries, setEntries] = useState<OsintHistoryEntry[] | null>(null);

    useEffect(() => {
        if (!workspace) return;
        let cancelled = false;

        const load = (): void => {
            ws.send('osint.history', { limit: 3 })
                .then((res) => {
                    if (!cancelled) setEntries(res.entries);
                })
                .catch(() => {
                    // Un échec passager garde la dernière valeur connue plutôt
                    // que d'afficher un « aucune recherche » trompeur.
                    if (!cancelled) setEntries((prev) => prev ?? []);
                });
        };

        if (ws.state === 'open') load();
        const off = ws.onStateChange((s) => {
            if (s === 'open') load();
        });
        return () => {
            cancelled = true;
            off();
        };
        // `unlocked` en dépendance : au déverrouillage, la même commande rend
        // cette fois les requêtes en clair.
    }, [workspace, version, unlocked]);

    if (entries === null) return <div className={styles.widgetMuted}>…</div>;
    if (entries.length === 0) {
        return <div className={styles.widgetMuted}>Aucune recherche</div>;
    }

    const last = entries[0];
    return (
        <div className={styles.widget}>
            <span className={styles.widgetTarget}>{last.query ?? '— chiffré —'}</span>
            <span className={styles.widgetMuted}>
                {entries.length > 1 ? `${entries.length} recherches récentes` : '1 recherche'}
            </span>
        </div>
    );
}
