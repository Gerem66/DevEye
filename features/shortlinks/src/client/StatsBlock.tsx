import { Button, safeHref, useResource } from 'deveye-sdk-client';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { ShortlinkRange } from '../contracts/domain';
import { api } from './api';
import { fillSeries } from './format';
import RangeBar from './RangeBar';
import StatBand from './Stats/StatBand';
import TopList from './Stats/TopList';
import TrendChart from './Stats/TrendChart';
import styles from './style.module.css';

/** Le bouton Actualiser reste grisé ce temps-là après la réponse : il ne se mitraille pas. */
const REFRESH_HOLD_MS = 500;
/** Une réponse qui ne change rien à l'écran (la même erreur) libère le bouton au bout du délai d'une commande. */
const REFRESH_TIMEOUT_MS = 15_000;

interface StatsBlockProps {
    /** Un lien, ou tous les liens visibles depuis l'espace quand `null`. */
    linkId: number | null;
    title: string;
    /** Les classements sous la courbe : d'où viennent les visiteurs. */
    detailed: boolean;
}

/**
 * Les chiffres d'une période : la bande, la courbe et, sur la fiche d'un lien,
 * les classements. Ils se relisent seuls quand des visites arrivent, au plus
 * une fois par minute ; pendant une relecture, les chiffres précédents restent
 * en place, atténués.
 */
export default function StatsBlock({ linkId, title, detailed }: StatsBlockProps) {
    const [range, setRange] = useState<ShortlinkRange>('30d');
    const read = useResource(
        'shortlinks.stats',
        () => api.send('shortlinks.stats', { id: linkId, range }),
        'Les statistiques n’ont pas pu être lues.',
        [linkId, range]
    );
    const [refreshing, setRefreshing] = useState(false);
    const asked = useRef<{ data: unknown; error: string | null } | null>(null);
    const refresh = () => {
        asked.current = { data: read.data, error: read.error };
        setRefreshing(true);
        read.reload();
    };
    useEffect(() => {
        if (!refreshing) return;
        const before = asked.current;
        const answered = before !== null && (read.data !== before.data || read.error !== before.error);
        const timer = setTimeout(() => setRefreshing(false), answered ? REFRESH_HOLD_MS : REFRESH_TIMEOUT_MS);
        return () => clearTimeout(timer);
    }, [refreshing, read.data, read.error]);
    const stats = read.data?.stats ?? null;
    const stale = stats !== null && stats.range !== range;
    const points = useMemo(() => (stats === null ? [] : fillSeries(stats)), [stats]);

    return (
        <section className={styles.section}>
            <div className={styles.sectionHead}>
                <h3 className={styles.sectionTitle}>{title}</h3>
                <div className={styles.actions}>
                    <Button
                        variant='ghost'
                        icon='refresh'
                        className={refreshing ? styles.refreshing : undefined}
                        disabled={read.loading || refreshing}
                        aria-busy={refreshing}
                        onClick={refresh}
                        title='Relire les chiffres sans attendre'
                    >
                        Actualiser
                    </Button>
                    <RangeBar value={range} onChange={setRange} />
                </div>
            </div>

            {read.error !== null && <p className={styles.error}>{read.error}</p>}

            {stats === null ? (
                read.error === null && <p className={styles.empty}>Chargement des statistiques…</p>
            ) : (
                <div className={stale ? styles.statsStale : styles.stats} aria-busy={stale}>
                    <StatBand stats={stats} range={stats.range} />
                    <TrendChart points={points} bucket={stats.bucket} />
                    {detailed && (
                        <div className={styles.panels}>
                            <TopList dimension='referrer' rows={stats.top.referrer} total={stats.totals.visits} />
                            <TopList
                                dimension='country'
                                rows={stats.top.country}
                                total={stats.totals.visits}
                                footer={
                                    <p className={styles.attribution}>
                                        <a
                                            href={safeHref(stats.attribution.url)}
                                            target='_blank'
                                            rel='noopener noreferrer'
                                        >
                                            {stats.attribution.text}
                                        </a>
                                    </p>
                                }
                            />
                            <TopList dimension='device' rows={stats.top.device} total={stats.totals.visits} />
                            <TopList dimension='browser' rows={stats.top.browser} total={stats.totals.visits} />
                            <TopList dimension='os' rows={stats.top.os} total={stats.totals.visits} />
                            <TopList dimension='language' rows={stats.top.language} total={stats.totals.visits} />
                        </div>
                    )}
                </div>
            )}
        </section>
    );
}
