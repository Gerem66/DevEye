import { useCallback, useEffect, useState } from 'react';
import type { DebugTracking } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import { StatusBadge } from '@/Components/StatusBadge';
import Switch from '@/Components/Switch';
import TextInput from '@/Components/TextInput';
import { useResourceVersion } from '@/stores/invalidation';
import { requestOpenView } from '@/stores/viewRequest';
import { formatMoment } from '../format';
import styles from '../Debug.module.css';

/**
 * L'usage de DevEye lui-même, relevé dans un site Audience de cette instance :
 * les pages ouvertes, les actions faites, les refus rencontrés. Anonyme comme
 * tout site suivi, et propre à ce serveur.
 */
export default function TrackingSection() {
    const [state, setState] = useState<DebugTracking | null>(null);
    const [key, setKey] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const version = useResourceVersion('debug.tracking');

    const load = useCallback(async () => {
        try {
            setState(await ws.send('debug.trackingGet', {}));
        } catch (e) {
            setError(e instanceof WsError ? e.message : 'État du suivi illisible.');
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load, version]);

    const run = async (fn: () => Promise<DebugTracking>): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            setState(await fn());
        } catch (e) {
            setError(e instanceof WsError ? e.message : 'Changement impossible.');
        } finally {
            setBusy(false);
        }
    };

    if (!state) return error ? <div className={styles.errorBanner}>{error}</div> : null;
    const { config } = state;

    return (
        <>
            <section className={styles.section}>
                <div className={styles.sectionHead}>
                    <span className={styles.sectionLabel}>Suivi d’usage</span>
                    {config && (
                        <StatusBadge tone={config.enabled ? 'success' : 'neutral'}>
                            {config.enabled ? 'Actif' : 'En pause'}
                        </StatusBadge>
                    )}
                </div>
                <p className={styles.sectionHint}>
                    Les pages que les membres ouvrent, les actions qu’ils font et les refus qu’ils rencontrent, relevés
                    dans un site Audience de cette instance. Anonyme : ni cookie, ni nom de compte, et un visiteur ne se
                    reconnaît pas d’un jour à l’autre. Le réglage vaut pour ce serveur seul ({state.origin}).
                </p>
                {error && <div className={styles.errorBanner}>{error}</div>}
                {!state.audienceInstalled && (
                    <div className={styles.warningBanner}>
                        Le module Audience n’est pas installé sur ce serveur : rien ne peut être relevé.
                    </div>
                )}

                {state.audienceInstalled && !config && (
                    <div className={styles.card}>
                        <div className={styles.row}>
                            <span className={`icon icon-plus ${styles.rowIcon}`} />
                            <div className={styles.rowText}>
                                <span className={styles.rowTitle}>Créer l’audience</span>
                                <span className={styles.rowMeta}>
                                    Un site anonyme, dans votre espace personnel, réglé pour ce serveur et branché
                                    aussitôt.
                                </span>
                            </div>
                            <Button disabled={busy} onClick={() => void run(() => ws.send('debug.trackingCreate', {}))}>
                                Créer l’audience
                            </Button>
                        </div>
                        <div className={styles.row}>
                            <span className={`icon icon-key ${styles.rowIcon}`} />
                            <div className={styles.rowText}>
                                <span className={styles.rowTitle}>Utiliser un site existant</span>
                                <span className={styles.rowMeta}>
                                    La clé d’un site d’un de vos espaces, telle qu’Audience l’affiche.
                                </span>
                            </div>
                            <TextInput
                                value={key}
                                placeholder='pk_…'
                                onChange={(e) => setKey(e.target.value)}
                                aria-label='Clé du site'
                            />
                            <Button
                                variant='secondary'
                                disabled={busy || key.trim().length < 8}
                                onClick={() => void run(() => ws.send('debug.trackingUse', { key: key.trim() }))}
                            >
                                Brancher
                            </Button>
                        </div>
                    </div>
                )}

                {config && (
                    <div className={styles.card}>
                        <div className={styles.row}>
                            <span className={`icon icon-activity ${styles.rowIcon}`} />
                            <div className={styles.rowText}>
                                <span className={styles.rowTitle}>
                                    {config.siteName ?? 'Site introuvable dans Audience'}
                                </span>
                                <span className={styles.rowMeta}>
                                    Clé {config.keyHint} · réglé le {formatMoment(config.updated * 1000)}
                                    {config.updatedBy ? ` par ${config.updatedBy.username}` : ''}
                                </span>
                            </div>
                            <Button variant='secondary' icon='arrow' onClick={() => requestOpenView('audience')}>
                                Ouvrir dans Audience
                            </Button>
                        </div>
                        <div className={styles.row}>
                            <div className={styles.rowText}>
                                <Switch
                                    checked={config.enabled}
                                    disabled={busy}
                                    onChange={(enabled) =>
                                        void run(() =>
                                            ws.send('debug.trackingSet', {
                                                enabled,
                                                excludeAdmins: config.excludeAdmins
                                            })
                                        )
                                    }
                                    label='Relever l’usage'
                                    hint='En pause, rien n’est envoyé ; le site et ses mesures restent.'
                                />
                            </div>
                        </div>
                        <div className={styles.row}>
                            <div className={styles.rowText}>
                                <Switch
                                    checked={!config.excludeAdmins}
                                    disabled={busy}
                                    onChange={(count) =>
                                        void run(() =>
                                            ws.send('debug.trackingSet', {
                                                enabled: config.enabled,
                                                excludeAdmins: !count
                                            })
                                        )
                                    }
                                    label='Compter les administrateurs'
                                    hint='Écartés par défaut : leurs essais fausseraient les chiffres. Les comptes d’essai ne comptent jamais.'
                                />
                            </div>
                        </div>
                        <div className={styles.row}>
                            <div className={styles.rowText}>
                                <span className={styles.rowMeta}>
                                    Depuis le démarrage de ce serveur : {state.counters.sent} mesure(s) envoyée(s),{' '}
                                    {state.counters.excluded} écartée(s).
                                </span>
                            </div>
                            <Button
                                variant='ghost'
                                disabled={busy}
                                onClick={() =>
                                    setConfirm({
                                        title: 'Débrancher ce serveur ?',
                                        description:
                                            'Plus rien ne sera relevé. Le site et ses mesures restent dans Audience.',
                                        confirmLabel: 'Débrancher',
                                        onConfirm: () => void run(() => ws.send('debug.trackingClear', {}))
                                    })
                                }
                            >
                                Débrancher
                            </Button>
                        </div>
                    </div>
                )}
            </section>

            {state.others.length > 0 && (
                <section className={styles.section}>
                    <span className={styles.sectionLabel}>Autres serveurs sur cette base</span>
                    <div className={styles.card}>
                        {state.others.map((other) => (
                            <div key={other.origin} className={styles.row}>
                                <span className={`${styles.rowTitle} ${styles.mono}`}>{other.origin}</span>
                                <StatusBadge tone={other.enabled ? 'success' : 'neutral'}>
                                    {other.enabled ? 'Actif' : 'En pause'}
                                </StatusBadge>
                            </div>
                        ))}
                    </div>
                </section>
            )}
            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        </>
    );
}
