import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import type { AdminFeatureFact, AdminFeatureStats } from '@deveye/types';
import type { AdminTabSpec } from '@deveye/types/sdk';

import { humanizeError } from '@/api/useResource';
import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import { CountBadge } from '@/Components/CountBadge';
import ErrorBoundary from '@/Components/ErrorBoundary';
import SideNav, { type SideNavItem } from '@/Components/FeatureSettings/SideNav';
import LoadingVeil from '@/Components/LoadingVeil';
import StatusBadge, { type BadgeTone } from '@/Components/StatusBadge/StatusBadge';
import StickyHeader from '@/Components/StickyHeader';
import { formatBytesFr } from '@/format';
import { clientModules } from '@/sdk/registry';
import { useAdminPending, type AdminPendingCounts } from '@/stores/adminPending';
import { clearFeatureAdminTarget, useFeatureAdminTarget } from '@/stores/featureAdminIntent';
import { useResourceVersion } from '@/stores/invalidation';
import { featureMaintenance, useHiddenFeatures, useMaintenance } from '@/stores/maintenance';
import styles from './FeatureAdmin.module.css';

export type FeatureAdminMode = 'admin' | 'moderation';

interface AdminFeature {
    id: string;
    label: string;
    icon: string;
    description: string;
    /** Les onglets que le mode ouvre : tous pour l'administrateur, ceux de modération sinon. */
    tabs: readonly AdminTabSpec[];
    components: Readonly<Record<string, ComponentType>>;
}

/**
 * Les fonctionnalités que la popup liste : toutes pour l'administrateur, celles
 * qui ont un onglet de modération pour le modérateur. Par nom.
 */
export function adminFeatures(mode: FeatureAdminMode): AdminFeature[] {
    return clientModules()
        .map(({ manifest, client }) => ({
            id: manifest.id,
            label: manifest.label,
            icon: manifest.icon,
            description: manifest.description,
            tabs: (manifest.adminTabs ?? []).filter((tab) => mode === 'admin' || tab.moderation === true),
            components: client.AdminTabs ?? {}
        }))
        .filter((feature) => mode === 'admin' || feature.tabs.length > 0)
        .sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

/** `null` : la vue d'ensemble, que l'hôte dessine et qu'un id d'onglet de module ne peut pas imiter. */
type TabId = string | null;

interface Selection {
    featureId: string;
    tab: TabId;
}

/** L'onglet où l'on arrive : là où quelque chose attend, sinon le premier. */
function landingTab(feature: AdminFeature, mode: FeatureAdminMode, pending: AdminPendingCounts): TabId {
    const waiting = feature.tabs.find((tab) => pending.tabCount(feature.id, tab.id) > 0);
    if (waiting) return waiting.id;
    return mode === 'admin' ? null : (feature.tabs[0]?.id ?? null);
}

function tabAllowed(feature: AdminFeature, tab: TabId, mode: FeatureAdminMode): boolean {
    return tab === null ? mode === 'admin' : feature.tabs.some((spec) => spec.id === tab);
}

type Lock = 'maintenance' | 'preview';

const LOCK_TEXT: Record<Lock, string> = {
    maintenance: 'Cette fonctionnalité est en maintenance : sa modération rouvrira avec elle.',
    preview: 'Cette fonctionnalité n’est pas encore ouverte : il n’y a rien à modérer pour l’instant.'
};

const STATE_BADGE = {
    requests: { tone: 'warning', label: 'En maintenance' },
    full: { tone: 'danger', label: 'Arrêt complet' },
    preview: { tone: 'accent', label: 'Préversion' }
} as const satisfies Record<string, { tone: BadgeTone; label: string }>;

const LOCK_BADGE: Record<Lock, { tone: BadgeTone; label: string }> = {
    maintenance: { tone: 'warning', label: 'En maintenance' },
    preview: { tone: 'neutral', label: 'Pas encore ouverte' }
};

/** Les chiffres globaux d'une fonctionnalité, relus à la demande (`refresh`) ou à la reconnexion. */
function useFeatureStats(featureId: string | null) {
    const [stats, setStats] = useState<{ featureId: string; data: AdminFeatureStats } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [nonce, setNonce] = useState(0);
    const forceRef = useRef(false);
    const version = useResourceVersion('admin.featureStats');

    useEffect(() => {
        if (featureId === null) return;
        let cancelled = false;
        const run = () => {
            const refresh = forceRef.current;
            forceRef.current = false;
            setBusy(true);
            setError(null);
            ws.send('admin.featureStats', { featureId, refresh })
                .then((data) => {
                    if (!cancelled) setStats({ featureId, data });
                })
                .catch((e: unknown) => {
                    if (!cancelled) setError(humanizeError(e, 'Les chiffres n’ont pas pu être lus.'));
                })
                .finally(() => {
                    if (!cancelled) setBusy(false);
                });
        };
        if (ws.state === 'open') run();
        const off = ws.onStateChange((state) => {
            if (state === 'open') run();
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [featureId, nonce, version]);

    const refresh = useCallback(() => {
        forceRef.current = true;
        setNonce((n) => n + 1);
    }, []);

    return {
        stats: stats !== null && stats.featureId === featureId ? stats.data : null,
        error,
        busy,
        refresh
    };
}

const number = (value: number): string => value.toLocaleString('fr-FR');

const factValue = (fact: AdminFeatureFact): string =>
    fact.unit === 'bytes' ? formatBytesFr(fact.value) : number(fact.value);

function Figure({ label, value, hint }: { label?: string; value: string; hint?: string }) {
    return (
        <div className={styles.figure}>
            {label && <span className={styles.figureLabel}>{label}</span>}
            <span className={styles.figureValue}>{value}</span>
            {hint && <span className={styles.figureHint}>{hint}</span>}
        </div>
    );
}

function Overview({ stats }: { stats: AdminFeatureStats }) {
    const { storage } = stats;
    return (
        <div className={styles.sections}>
            <section className={styles.section}>
                <h4 className={styles.sectionLabel}>Utilisation</h4>
                {stats.workspaces === null || stats.accounts === null ? (
                    <p className={styles.note}>
                        Pas de tuile sur l’accueil : elle se trouve dans le menu du compte de chacun.
                    </p>
                ) : (
                    <div className={styles.figures}>
                        <Figure label='Espaces' value={number(stats.workspaces)} hint='qui l’ont sur leur accueil' />
                        <Figure label='Comptes' value={number(stats.accounts)} hint='membres de ces espaces' />
                    </div>
                )}
            </section>

            <section className={styles.section}>
                <h4 className={styles.sectionLabel}>Stockage</h4>
                {storage.tables === 0 ? (
                    <p className={styles.note}>Aucune table à elle dans la base de données.</p>
                ) : (
                    <>
                        <div className={styles.figures}>
                            <Figure label='Taille' value={formatBytesFr(storage.bytes)} />
                            <Figure label='Lignes' value={number(storage.rows)} />
                            <Figure label='Tables' value={number(storage.tables)} />
                        </div>
                        <p className={styles.note}>
                            Des estimations de la base de données, qui peuvent avoir un peu de retard.
                        </p>
                    </>
                )}
            </section>

            {stats.quotas.length > 0 && (
                <section className={styles.section}>
                    <h4 className={styles.sectionLabel}>Quotas</h4>
                    <div className={styles.figures}>
                        {/* Un libellé de quota suit son nombre : « 3 liens courts », « 2 Go de stockage ». */}
                        {stats.quotas.map((fact) => (
                            <Figure
                                key={fact.label}
                                value={factValue(fact)}
                                hint={`${fact.label}, tous espaces confondus`}
                            />
                        ))}
                    </div>
                </section>
            )}

            {stats.facts === null ? (
                <section className={styles.section}>
                    <h4 className={styles.sectionLabel}>Ses chiffres</h4>
                    <p className={styles.note}>La fonctionnalité n’a pas donné ses chiffres cette fois-ci.</p>
                </section>
            ) : (
                stats.facts.length > 0 && (
                    <section className={styles.section}>
                        <h4 className={styles.sectionLabel}>Ses chiffres</h4>
                        <div className={styles.figures}>
                            {stats.facts.map((fact) => (
                                <Figure key={fact.label} label={fact.label} value={factValue(fact)} />
                            ))}
                        </div>
                    </section>
                )
            )}
        </div>
    );
}

export interface FeatureAdminProps {
    mode: FeatureAdminMode;
}

/**
 * La popup d'administration des fonctionnalités : la liste à gauche, et à
 * droite la fonctionnalité choisie, sa vue d'ensemble (administrateur) et ses
 * onglets (`manifest.adminTabs`). Le modérateur n'y voit que les onglets de
 * modération, et une fonctionnalité que la maintenance lui ferme y reste,
 * verrouillée. Le serveur garde chaque commande : ce tri n'est qu'un confort.
 */
export default function FeatureAdmin({ mode }: FeatureAdminProps) {
    const features = useMemo(() => adminFeatures(mode), [mode]);
    const pending = useAdminPending();
    const maintenance = useMaintenance();
    const hidden = useHiddenFeatures();

    const [selection, setSelection] = useState<Selection | null>(() => {
        const first = features.find((f) => pending.featureTotal(f.id) > 0) ?? features[0];
        return first ? { featureId: first.id, tab: landingTab(first, mode, pending) } : null;
    });

    // Le lien d'un mail de signalement : la fonctionnalité nommée, sur son premier
    // onglet de modération. Avant l'affichage, pour ne pas montrer la liste au
    // mauvais endroit le temps d'une image.
    const target = useFeatureAdminTarget();
    useLayoutEffect(() => {
        if (target === null) return;
        clearFeatureAdminTarget();
        const feature = features.find((f) => f.id === target);
        if (!feature) return;
        const firstModeration = feature.tabs.find((tab) => tab.moderation === true);
        setSelection({
            featureId: feature.id,
            tab: firstModeration?.id ?? (mode === 'admin' ? null : (feature.tabs[0]?.id ?? null))
        });
    }, [target, features, mode]);

    const feature = features.find((f) => f.id === selection?.featureId) ?? features[0] ?? null;
    const chosen = feature !== null && selection?.featureId === feature.id ? selection.tab : undefined;
    const tab: TabId =
        feature === null
            ? null
            : chosen !== undefined && tabAllowed(feature, chosen, mode)
              ? chosen
              : landingTab(feature, mode, pending);

    const lockOf = (featureId: string): Lock | null => {
        if (mode === 'admin') return null;
        if (hidden.has(featureId)) return 'preview';
        const level = featureMaintenance(maintenance, featureId);
        return level === 'requests' || level === 'full' ? 'maintenance' : null;
    };
    const lock = feature ? lockOf(feature.id) : null;
    const level = feature && mode === 'admin' ? featureMaintenance(maintenance, feature.id) : null;

    const overviewShown = mode === 'admin' && feature !== null && tab === null;
    const { stats, error, busy, refresh } = useFeatureStats(overviewShown ? feature.id : null);

    const navItems: SideNavItem<string>[] = features.map((f) => ({
        id: f.id,
        label: f.label,
        icon: lockOf(f.id) ? 'lock' : f.icon,
        badge: pending.featureTotal(f.id),
        badgeTone: 'accent'
    }));

    const select = (featureId: string) => {
        const next = features.find((f) => f.id === featureId);
        if (!next || next.id === feature?.id) return;
        setSelection({ featureId: next.id, tab: landingTab(next, mode, pending) });
    };

    const Tab = feature && tab !== null ? feature.components[tab] : undefined;
    const title = mode === 'admin' ? 'Fonctionnalités' : 'Modération';

    return (
        <div className={styles.root}>
            <StickyHeader>
                <header className={styles.header}>
                    <div className={styles.headerText}>
                        <h2 className={styles.title}>{title}</h2>
                        <p className={styles.subtitle}>
                            {mode === 'admin'
                                ? 'Chaque fonctionnalité installée, ses chiffres et ce qui attend une décision.'
                                : 'Ce que les utilisateurs ont signalé et qui attend votre décision.'}
                        </p>
                    </div>
                    {overviewShown && (
                        <div className={styles.actions}>
                            <Button variant='secondary' icon='refresh' disabled={busy} onClick={refresh}>
                                Actualiser
                            </Button>
                        </div>
                    )}
                </header>
            </StickyHeader>

            {!feature ? (
                <p className={styles.empty}>
                    {mode === 'admin'
                        ? 'Aucune fonctionnalité n’est installée.'
                        : 'Aucune fonctionnalité ne demande de modération.'}
                </p>
            ) : (
                <div className={styles.layout}>
                    <SideNav items={navItems} active={feature.id} onSelect={select} label={title} />

                    <section className={styles.panel} aria-label={feature.label}>
                        <div className={styles.identity}>
                            <span className={`icon icon-${feature.icon} ${styles.identityIcon}`} aria-hidden='true' />
                            <div className={styles.identityText}>
                                <div className={styles.identityTitle}>
                                    <h3 className={styles.name}>{feature.label}</h3>
                                    {level && (
                                        <StatusBadge tone={STATE_BADGE[level].tone} dot={false}>
                                            {STATE_BADGE[level].label}
                                        </StatusBadge>
                                    )}
                                    {lock && (
                                        <StatusBadge tone={LOCK_BADGE[lock].tone} dot={false}>
                                            {LOCK_BADGE[lock].label}
                                        </StatusBadge>
                                    )}
                                </div>
                                {mode === 'admin' && <p className={styles.description}>{feature.description}</p>}
                            </div>
                        </div>

                        <div className={styles.tabs} role='tablist' aria-label={`Onglets de ${feature.label}`}>
                            {mode === 'admin' && (
                                <button
                                    type='button'
                                    role='tab'
                                    aria-selected={tab === null}
                                    className={tab === null ? styles.tabActive : styles.tab}
                                    onClick={() => setSelection({ featureId: feature.id, tab: null })}
                                >
                                    Vue d’ensemble
                                </button>
                            )}
                            {feature.tabs.map((spec) => {
                                const count = pending.tabCount(feature.id, spec.id);
                                return (
                                    <button
                                        key={spec.id}
                                        type='button'
                                        role='tab'
                                        aria-selected={lock === null && tab === spec.id}
                                        className={lock === null && tab === spec.id ? styles.tabActive : styles.tab}
                                        disabled={lock !== null}
                                        onClick={() => setSelection({ featureId: feature.id, tab: spec.id })}
                                    >
                                        {spec.label}
                                        {count > 0 && <CountBadge count={count} aria-label={`${count} en attente`} />}
                                    </button>
                                );
                            })}
                        </div>

                        {lock ? (
                            <p className={styles.locked}>
                                <span className={`icon icon-lock ${styles.lockedIcon}`} aria-hidden='true' />
                                {LOCK_TEXT[lock]}
                            </p>
                        ) : overviewShown ? (
                            <div className={styles.body}>
                                {error && <div className={styles.errorBanner}>{error}</div>}
                                {stats ? (
                                    <div className={busy ? styles.dimmed : undefined}>
                                        <Overview stats={stats} />
                                        <p className={styles.computedAt}>
                                            Chiffres calculés à{' '}
                                            {new Date(stats.computedAt).toLocaleTimeString('fr-FR', {
                                                hour: '2-digit',
                                                minute: '2-digit'
                                            })}
                                            .
                                        </p>
                                    </div>
                                ) : null}
                                {busy && (
                                    <LoadingVeil align='top' delayed={stats !== null} label='Lecture des chiffres…' />
                                )}
                            </div>
                        ) : Tab ? (
                            <ErrorBoundary key={`${feature.id}:${tab}`} variant='view' canReport featureId={feature.id}>
                                <Tab />
                            </ErrorBoundary>
                        ) : null}
                    </section>
                </div>
            )}
        </div>
    );
}
