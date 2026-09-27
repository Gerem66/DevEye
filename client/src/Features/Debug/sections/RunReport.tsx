import { useState } from 'react';
import type { DebugE2eReport, DebugE2eScenarioReport, DebugStepStatus } from '@deveye/types';

import { formatDelta, formatMs, relativeDelta } from '../format';
import styles from '../Debug.module.css';

const MARK: Record<DebugStepStatus, { symbol: string; className: string; label: string }> = {
    pending: { symbol: '·', className: styles.muted, label: 'En attente' },
    running: { symbol: '…', className: styles.running, label: 'En cours' },
    passed: { symbol: '✓', className: styles.passed, label: 'Réussi' },
    failed: { symbol: '✗', className: styles.failed, label: 'En échec' },
    skipped: { symbol: '–', className: styles.muted, label: 'Ignoré' }
};

function Mark({ status }: { status: DebugStepStatus }) {
    const mark = MARK[status];
    return (
        <span className={mark.className} title={mark.label} aria-label={mark.label}>
            {mark.symbol}
        </span>
    );
}

function Scenario({
    scenario,
    previous
}: {
    scenario: DebugE2eScenarioReport;
    previous: DebugE2eScenarioReport | null;
}) {
    // Un scénario réussi se replie : c'est l'échec qu'on vient lire.
    const [open, setOpen] = useState(scenario.status !== 'passed' && scenario.status !== 'skipped');
    const expanded = open || scenario.status === 'running' || scenario.status === 'failed';
    const delta = relativeDelta(scenario.durationMs, previous?.durationMs ?? null);
    return (
        <div className={styles.scenario}>
            <button
                type='button'
                className={`${styles.row} ${styles.rowButton}`}
                onClick={() => setOpen((o) => !o)}
                aria-expanded={expanded}
            >
                <span className={`icon icon-chevron ${styles.rowIcon}`} />
                <div className={styles.rowText}>
                    <span className={styles.rowTitle}>
                        <Mark status={scenario.status} /> {scenario.label}
                    </span>
                    <span className={styles.rowMeta}>
                        {scenario.sourceLabel}
                        {scenario.skipReason ? ` · ${scenario.skipReason}` : ''}
                    </span>
                </div>
                <span className={styles.mono}>
                    {formatMs(scenario.durationMs)}
                    {delta !== null && <span className={styles.muted}> ({formatDelta(delta)})</span>}
                </span>
            </button>
            {expanded && scenario.steps.length > 0 && (
                <ol className={styles.steps}>
                    {scenario.steps.map((step, i) => (
                        <li key={i} className={styles.step}>
                            <Mark status={step.status} />
                            <span>{step.label}</span>
                            <span className={styles.mono}>{formatMs(step.durationMs)}</span>
                            {step.detail && (
                                <span
                                    className={`${styles.stepDetail} ${step.status === 'failed' ? styles.stepDetailFailed : ''}`}
                                >
                                    {step.detail}
                                </span>
                            )}
                        </li>
                    ))}
                    {scenario.cleanup && !scenario.cleanup.ok && (
                        <li className={styles.step}>
                            <Mark status='failed' />
                            <span>Ménage incomplet</span>
                            <span />
                            <span className={`${styles.stepDetail} ${styles.stepDetailFailed}`}>
                                {scenario.cleanup.detail}
                            </span>
                        </li>
                    )}
                </ol>
            )}
        </div>
    );
}

/** Le rapport d'un essai, scénario par scénario ; les durées comparées à l'essai précédent. */
export default function RunReport({ report, previous }: { report: DebugE2eReport; previous: DebugE2eReport | null }) {
    return (
        <div className={styles.card}>
            {report.scenarios.map((s) => (
                <Scenario
                    key={s.id}
                    scenario={s}
                    previous={previous?.scenarios.find((p) => p.id === s.id && p.status === 'passed') ?? null}
                />
            ))}
            {report.residueAfter !== null && report.residueAfter > 0 && (
                <div className={styles.row}>
                    <span className={`icon icon-x-circle ${styles.rowIcon} ${styles.failed}`} />
                    <span className={styles.rowTitle}>
                        {report.residueAfter} compte(s) d’essai n’ont pas pu être supprimés.
                    </span>
                </div>
            )}
        </div>
    );
}
