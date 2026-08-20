import { useCallback, useEffect, useState } from 'react';
import { featureDescriptor, type ItemShareState, type ShareBlocker } from 'deveye-types';

import { ws } from '@/api/ws';
import Switch from '@/Components/Switch';
import { invalidate, type ResourceKey } from '@/stores/invalidation';

import type { SettingsScope } from '../scope';
import styles from '../FeatureSettings.module.css';

/**
 * Où cet élément est visible — **ses espaces, et seulement les siens**.
 *
 * ## Ce que la case fait, et ce qu'elle ne fait pas
 *
 * Elle **projette**, elle ne déplace pas. L'élément garde un domicile ; cocher
 * un espace y ouvre une fenêtre. Il s'y lit et s'y modifie comme chez lui, mais
 * son contenu reste chiffré sous la clé de son origine — c'est ce qui permet à
 * ce chantier de ne rien re-chiffrer.
 *
 * ## Pourquoi seulement ses propres espaces
 *
 * La liste est celle des espaces dont on est membre, l'espace personnel
 * compris. Proposer ceux des autres reviendrait à y déposer une donnée dont on
 * ne pourrait plus répondre, et à contourner l'appartenance — la frontière
 * absolue du modèle. Le serveur le refuse aussi : l'écran ne fait que ne pas le
 * proposer.
 */

const BLOCKER_TEXT: Record<ShareBlocker, string> = {
    feature:
        'Cette fonctionnalité ne se partage pas encore entre espaces : son listage ne sait pas aller chercher les éléments projetés.',
    item: 'Cet élément est chiffré au palier « gardé ». Le serveur ne peut pas le relire pour un autre espace, et il n’est donc pas projetable — passez-le au palier ouvert si sa nature s’y prête.',
    forbidden: 'Vous n’avez pas le droit de partager les éléments de cette fonctionnalité.',
    foreign:
        'Cet élément vient d’un autre espace : son partage s’y règle. On ne re-projette pas ce qu’on ne fait que voir — sinon son espace d’origine perdrait la maîtrise de sa donnée sans le savoir.'
};

/**
 * Ce qu'un partage invalide, par fonctionnalité branchée.
 *
 * La clé était codée en dur sur `uptime.list` : partager une base ou une cible
 * rafraîchissait… la liste des services. La table suit `SHARE_WIRED_FEATURES` —
 * une feature qu'on branche au partage s'inscrit ici en même temps.
 */
const LIST_KEYS: Partial<Record<SettingsScope['feature'], ResourceKey[]>> = {
    uptime: ['uptime.list', 'uptime.count'],
    database: ['database.list', 'database.count'],
    deploy: ['deploy.list', 'deploy.count'],
    git: ['git.list', 'git.count'],
    audience: ['audience.list', 'audience.count'],
    backup: ['backup.jobList', 'backup.count']
};

interface Props {
    scope: SettingsScope;
}

export default function SharingSection({ scope }: Props) {
    const [state, setState] = useState<ItemShareState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const itemId = scope.kind === 'item' ? scope.itemId : 0;

    const reload = useCallback(async () => {
        const res = await ws.send('share.get', { feature: scope.feature, itemId });
        setState(res);
    }, [scope.feature, itemId]);

    useEffect(() => {
        void reload().catch(() => setError('Chargement impossible.'));
    }, [reload]);

    const toggle = (workspaceId: number, shared: boolean): void => {
        setBusy(true);
        setError(null);
        void ws
            .send('share.set', { feature: scope.feature, itemId, workspaceId, shared })
            .then((res) => {
                setState(res);
                // La liste de la fonctionnalité change des deux côtés : ici on
                // vient d'ouvrir ou de fermer une fenêtre, là-bas la ligne
                // apparaît ou disparaît.
                for (const key of LIST_KEYS[scope.feature] ?? []) invalidate(key);
            })
            .catch(() => setError('Modification impossible.'))
            .finally(() => setBusy(false));
    };

    if (!state) return <p className={styles.sectionHint}>Chargement…</p>;

    const noun = featureDescriptor(scope.feature).itemNoun ?? 'élément';

    return (
        <div className={styles.section}>
            <p className={styles.sectionHint}>
                Les espaces où ce {noun} est visible. Il n’y est pas copié : il reste chez lui et s’affiche ailleurs,
                donc le modifier d’un côté le modifie partout.
            </p>

            {state.blocker && <p className={styles.warning}>{BLOCKER_TEXT[state.blocker]}</p>}

            <div className={styles.channelList}>
                {state.workspaces.map((w) => (
                    <div key={w.workspaceId} className={styles.channelRow}>
                        <Switch
                            checked={w.shared}
                            aria-label={
                                w.isHome
                                    ? `${w.workspaceName} — espace d’origine`
                                    : `Rendre visible dans ${w.workspaceName}`
                            }
                            // L'origine n'est pas décochable : l'élément y est
                            // chez lui, pas projeté. Un interrupteur qui ne
                            // pourrait qu'échouer n'a pas à être actionnable.
                            disabled={w.isHome || busy || state.blocker !== null}
                            onChange={(on) => toggle(w.workspaceId, on)}
                        />
                        <span className={styles.channelText}>
                            <span className={styles.channelLabel}>
                                {w.workspaceName}
                                {w.isHome && <span className={styles.channelOff}>espace d’origine</span>}
                            </span>
                            {w.isHome && (
                                <span className={styles.channelMeta}>
                                    C’est ici que la donnée vit et qu’elle est chiffrée.
                                </span>
                            )}
                        </span>
                    </div>
                ))}
            </div>

            <p className={styles.sectionHint}>
                Un membre d’un autre espace verra ce {noun}, mais pas ce à quoi il est relié ici — un compte mail, un
                canal d’alerte. Ces liens lui apparaissent comme « d’un autre espace », sans leur contenu.
            </p>

            {error && <p className={styles.notice}>{error}</p>}
        </div>
    );
}
