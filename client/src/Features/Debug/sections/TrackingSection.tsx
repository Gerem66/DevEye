import { useCallback, useEffect, useState } from 'react';
import type { DebugTracking, DebugTrackingCompanion } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import CopyButton from '@/Components/CopyButton';
import { StatusBadge } from '@/Components/StatusBadge';
import Switch from '@/Components/Switch';
import TextInput from '@/Components/TextInput';
import { useResourceVersion } from '@/stores/invalidation';
import { requestOpenView } from '@/stores/viewRequest';
import { formatMoment } from '../format';
import styles from '../Debug.module.css';

const COMPANIONS: Record<DebugTrackingCompanion['kind'], { label: string; icon: string }> = {
    status: { label: 'Page d’état', icon: 'icon-uptime' },
    site: { label: 'Site vitrine', icon: 'icon-globe' }
};

const hostOf = (url: string): string => {
    try {
        return new URL(url).host;
    } catch {
        return url;
    }
};

/** Les deux arguments de construction du site vitrine, tels qu'on les colle dans Dokploy. */
const siteBuildArgs = (ingestOrigin: string, key: string): string =>
    `PUBLIC_AUDIENCE_ORIGIN=${ingestOrigin}\nPUBLIC_AUDIENCE_KEY=${key}`;

/**
 * L'usage de DevEye lui-même, relevé dans un site Audience de cette instance :
 * les pages ouvertes, les actions faites, les refus rencontrés. Anonyme comme
 * tout site suivi, et propre à ce serveur. Les pages publiques de l'instance
 * (page d'état, site vitrine) ont chacune leur site à côté, mesuré par la
 * balise comme un site tiers.
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
    const { config, companions } = state;
    const missing = companions.filter((c) => c.site === null);
    const companionList = companions.map((c) => `${COMPANIONS[c.kind].label.toLowerCase()} (${hostOf(c.url)})`);

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
                                    aussitôt
                                    {companionList.length > 0
                                        ? `, avec un site par page publique : ${companionList.join(' et ')}.`
                                        : '.'}
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
                                    hint='En pause, rien n’est envoyé et la page d’état retire sa balise ; les sites et leurs mesures restent.'
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
                                            'Plus rien ne sera relevé, et la page d’état retirera sa balise. Les sites et leurs mesures restent dans Audience.',
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

            {state.audienceInstalled && (
                <section className={styles.section}>
                    <div className={styles.sectionHead}>
                        <span className={styles.sectionLabel}>Pages publiques</span>
                        {config && missing.length > 0 && (
                            <Button
                                variant='secondary'
                                disabled={busy}
                                onClick={() => void run(() => ws.send('debug.trackingCreate', {}))}
                            >
                                Créer les sites manquants
                            </Button>
                        )}
                    </div>
                    <p className={styles.sectionHint}>
                        La page d’état et le site vitrine sont mesurés par la balise publique d’Audience, chargée depuis{' '}
                        {state.ingestOrigin}, dans le même espace que le site de l’app. Le site vitrine reçoit aussi les
                        messages de sa fenêtre « Écris-moi », dans les retours de son formulaire « contact ».
                    </p>
                    {companions.length === 0 ? (
                        <div className={styles.infoBanner}>
                            <span className={styles.bannerText}>
                                Aucune page publique n’a d’adresse sur ce serveur : renseignez STATUS_PAGE_URL ou
                                SITE_URL pour la mesurer aussi.
                            </span>
                        </div>
                    ) : (
                        <div className={styles.card}>
                            {companions.map((companion) => (
                                <CompanionRow
                                    key={companion.kind}
                                    companion={companion}
                                    ingestOrigin={state.ingestOrigin}
                                    connected={config !== null}
                                />
                            ))}
                        </div>
                    )}
                </section>
            )}

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

/**
 * Une page publique : son site s'il est déclaré, et ce qu'il reste à faire.
 * La page d'état lit sa clé chez DevEye ; le site vitrine, construit en
 * statique, la reçoit à sa construction, d'où les deux arguments à copier.
 */
function CompanionRow({
    companion,
    ingestOrigin,
    connected
}: {
    companion: DebugTrackingCompanion;
    ingestOrigin: string;
    connected: boolean;
}) {
    const { label, icon } = COMPANIONS[companion.kind];
    const { site } = companion;
    return (
        <div className={styles.row}>
            <span className={`icon ${icon} ${styles.rowIcon}`} />
            <div className={styles.rowText}>
                <span className={styles.rowTitle}>
                    {label} · {hostOf(companion.url)}
                </span>
                {site === null ? (
                    <span className={styles.rowMeta}>
                        {connected ? 'Pas encore déclarée dans Audience.' : 'Déclarée avec l’audience, ci-dessus.'}
                    </span>
                ) : (
                    <>
                        <span className={styles.rowMeta}>
                            {site.siteName ?? 'Site introuvable dans Audience'} · clé {site.key}
                        </span>
                        {companion.kind === 'status' ? (
                            <span className={styles.rowMeta}>
                                La page d’état lit sa clé ici, avec les destinations des alertes : rien à régler chez
                                elle.
                            </span>
                        ) : (
                            <span className={styles.rowMeta}>
                                À poser dans les arguments de construction du site (Dokploy, « Build-time Arguments »),
                                puis le reconstruire :
                            </span>
                        )}
                    </>
                )}
            </div>
            {site !== null && companion.kind === 'site' && (
                <>
                    <pre className={`${styles.mono} ${styles.buildArgs}`}>{siteBuildArgs(ingestOrigin, site.key)}</pre>
                    <CopyButton value={siteBuildArgs(ingestOrigin, site.key)} label='Copier les deux arguments' />
                </>
            )}
            {site !== null && (
                <StatusBadge tone='success'>
                    {companion.kind === 'status' ? 'Balise servie par DevEye' : 'Site déclaré'}
                </StatusBadge>
            )}
        </div>
    );
}
