import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CommandOutput, DebugRun } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import Checkbox from '@/Components/Checkbox';
import { useRun } from '../useRun';
import RunHistory, { RunStatusBadge } from './RunHistory';
import RunReport from './RunReport';
import styles from '../Debug.module.css';

type Catalog = CommandOutput<'debug.e2eCatalog'>;

function e2eOf(run: DebugRun | null) {
    return run?.report.kind === 'e2e' ? run.report : null;
}

function summaryOf(run: DebugRun): string {
    const report = e2eOf(run);
    if (!report) return '';
    const count = (status: string): number => report.scenarios.filter((s) => s.status === status).length;
    const parts = [`${count('passed')} réussi(s)`];
    if (count('failed') > 0) parts.push(`${count('failed')} en échec`);
    if (count('skipped') > 0) parts.push(`${count('skipped')} ignoré(s)`);
    return parts.join(', ');
}

/**
 * Des parcours réels joués contre ce serveur : des comptes jetables ouverts,
 * utilisés puis supprimés par les vrais chemins. Rien ne reste après un essai,
 * même interrompu : ce qu'un arrêt laisse est effacé au démarrage suivant.
 */
export default function E2eSection({ activeRunId }: { activeRunId: number | null }) {
    const [catalog, setCatalog] = useState<Catalog | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [sweeping, setSweeping] = useState(false);
    const [catalogError, setCatalogError] = useState<string | null>(null);
    const { run, history, error, running, start, abort, show } = useRun('e2e', activeRunId);

    const load = useCallback(async () => {
        try {
            const next = await ws.send('debug.e2eCatalog', {});
            setCatalog(next);
            setSelected((current) =>
                current.size > 0 ? current : new Set(next.scenarios.filter((s) => !s.skip).map((s) => s.id))
            );
        } catch (e) {
            setCatalogError(e instanceof WsError ? e.message : 'Catalogue des essais illisible.');
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    // Le catalogue se relit à la fin d'un essai : les résidus et les raisons d'ignorer ont pu changer.
    const status = run?.status;
    useEffect(() => {
        if (status && status !== 'running') void load();
    }, [status, load]);

    const runnable = useMemo(() => (catalog?.scenarios ?? []).filter((s) => !s.skip), [catalog]);
    const report = e2eOf(run);
    const previous = useMemo(() => {
        if (!run) return null;
        const older = history.find((r) => r.startedAt < run.startedAt && r.status !== 'running');
        return older ? e2eOf(older) : null;
    }, [history, run]);

    const launch = (ids: string[]): void => {
        void start(() => ws.send('debug.e2eStart', { scenarios: ids }));
    };

    const sweep = async (): Promise<void> => {
        setSweeping(true);
        try {
            await ws.send('debug.e2eSweep', {}, { timeoutMs: 60_000 });
            await load();
        } catch (e) {
            setCatalogError(e instanceof WsError ? e.message : 'Ménage impossible.');
        } finally {
            setSweeping(false);
        }
    };

    const toggle = (id: string, on: boolean): void =>
        setSelected((current) => {
            const next = new Set(current);
            if (on) next.add(id);
            else next.delete(id);
            return next;
        });

    const chosen = runnable.filter((s) => selected.has(s.id)).map((s) => s.id);

    return (
        <>
            <section className={styles.section}>
                <div className={styles.sectionHead}>
                    <span className={styles.sectionLabel}>Parcours complets</span>
                    <div className={styles.actions}>
                        {running ? (
                            <Button variant='secondary' icon='x' onClick={() => void abort()}>
                                Arrêter
                            </Button>
                        ) : (
                            <>
                                <Button
                                    variant='secondary'
                                    disabled={chosen.length === 0 || Boolean(catalog?.blocked)}
                                    onClick={() => launch(chosen)}
                                >
                                    Lancer la sélection
                                </Button>
                                <Button
                                    icon='play'
                                    disabled={runnable.length === 0 || Boolean(catalog?.blocked)}
                                    onClick={() => launch(runnable.map((s) => s.id))}
                                >
                                    Tout lancer
                                </Button>
                            </>
                        )}
                    </div>
                </div>
                <p className={styles.sectionHint}>
                    Chaque parcours ouvre des comptes d’essai, les fait passer par les vrais écrans du serveur, puis les
                    supprime avec tout ce qu’ils ont créé. Leurs mails sont retenus par le serveur, jamais envoyés.
                </p>
                {catalogError && <div className={styles.errorBanner}>{catalogError}</div>}
                {error && <div className={styles.errorBanner}>{error}</div>}
                {catalog?.blocked && <div className={styles.warningBanner}>{catalog.blocked}</div>}
                {catalog && catalog.residue > 0 && !running && (
                    <div className={styles.warningBanner}>
                        <span className={styles.bannerText}>
                            {catalog.residue} compte(s) d’essai restent d’un essai interrompu.
                        </span>
                        <Button variant='secondary' disabled={sweeping} onClick={() => void sweep()}>
                            {sweeping ? 'Ménage…' : 'Faire le ménage'}
                        </Button>
                    </div>
                )}
                {catalog && (
                    <div className={styles.card}>
                        {catalog.scenarios.map((s) => (
                            <div key={s.id} className={styles.row}>
                                <Checkbox
                                    checked={selected.has(s.id) && !s.skip}
                                    disabled={Boolean(s.skip) || running}
                                    onChange={(on) => toggle(s.id, on)}
                                >
                                    <span className={styles.rowTitle}>{s.label}</span>
                                    <span className={styles.rowMeta}>
                                        {s.sourceLabel}
                                        {s.skip ? ` · ${s.skip}` : ''}
                                    </span>
                                </Checkbox>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {report && run && (
                <section className={styles.section}>
                    <div className={styles.sectionHead}>
                        <span className={styles.sectionLabel}>
                            {run.status === 'running' ? 'Essai en cours' : 'Rapport'}
                        </span>
                        <RunStatusBadge status={run.status} />
                    </div>
                    <RunReport report={report} previous={previous} />
                </section>
            )}

            <RunHistory runs={history} selectedId={run?.id ?? null} onSelect={show} summary={summaryOf} />
        </>
    );
}
