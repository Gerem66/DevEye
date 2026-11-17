import { useMemo, useState } from 'react';
import { ErrorNote, StatusBadge } from 'deveye-sdk-client';

import type { CveSeverityFilter } from '../contracts/domain';
import type { ExposureFinding, FindingKind } from '../contracts/exposure';

import AssetChips from './AssetChips';
import DetailPane from './DetailPane';
import { versionsOf } from './exposureLabels';
import FindingDetail from './FindingDetail';
import FindingFilters, { emptyFindingsLine } from './FindingFilters';
import { ago, fullDate, SEVERITY_FILTERS, SEVERITY_LABEL, severityTone } from './severity';
import styles from './style.module.css';
import { useFindings } from './useFindings';

const KINDS: readonly FindingKind[] = ['vuln'];

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

/** Les failles publiées qui touchent ce que l'espace fait tourner : un constat par faille, avec ce qu'il touche. */
export default function VulnView({
    canWrite,
    onDetailChange
}: {
    canWrite: boolean;
    onDetailChange: (open: boolean) => void;
}) {
    const findings = useFindings(KINDS, onDetailChange);
    const [severity, setSeverity] = useState<CveSeverityFilter>('all');
    const shown = useMemo(
        () =>
            findings.findings
                .filter((f) => severity === 'all' || f.severity === severity)
                .sort(
                    (a, b) =>
                        (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || b.firstSeen - a.firstSeen
                ),
        [findings.findings, severity]
    );
    const selected = findings.selected;

    return (
        <>
            <FindingFilters findings={findings}>
                <div className={styles.severityChips} role='group' aria-label='Filtrer par gravité'>
                    {SEVERITY_FILTERS.map((f) => (
                        <button
                            key={f.value}
                            type='button'
                            className={`${styles.chip} ${f.value === severity ? styles.chipActive : ''}`}
                            aria-pressed={f.value === severity}
                            onClick={() => setSeverity(f.value)}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
            </FindingFilters>

            <ErrorNote note={findings.error} />

            <div className={styles.split}>
                <div className={styles.listPane}>
                    {shown.length === 0 && !findings.loading ? (
                        <p className={styles.empty}>
                            {emptyFindingsLine(findings, 'Aucune faille connue dans ce que l’espace fait tourner.')}
                        </p>
                    ) : (
                        <ul className={styles.list}>
                            {shown.map((f) => (
                                <FindingRow
                                    key={f.id}
                                    finding={f}
                                    selected={f.id === selected?.id}
                                    onOpen={() => findings.toggle(f.id)}
                                />
                            ))}
                        </ul>
                    )}
                </div>
                <DetailPane open={selected !== null}>
                    {selected && (
                        <FindingDetail
                            finding={selected}
                            canWrite={canWrite}
                            busy={findings.busy}
                            onIgnore={findings.ignore}
                            onRestore={findings.restore}
                            onClose={findings.close}
                        />
                    )}
                </DetailPane>
            </div>
        </>
    );
}

function FindingRow({
    finding,
    selected,
    onOpen
}: {
    finding: ExposureFinding;
    selected: boolean;
    onOpen: () => void;
}) {
    return (
        <li className={`${styles.row} ${selected ? styles.rowSelected : ''}`}>
            <button type='button' className={styles.rowMain} onClick={onOpen}>
                <span className={styles.rowHead}>
                    <span className={styles.rowId}>{finding.advisoryId ?? finding.subject.name}</span>
                    <StatusBadge tone={severityTone(finding.severity)}>
                        {finding.score === null
                            ? SEVERITY_LABEL[finding.severity]
                            : `${SEVERITY_LABEL[finding.severity]} ${finding.score.toFixed(1)}`}
                    </StatusBadge>
                    <span className={styles.rowAge} title={`Vu le ${fullDate(finding.firstSeen)}`}>
                        {ago(finding.firstSeen)}
                    </span>
                </span>
                <span className={styles.rowSummary}>{finding.title}</span>
                <span className={styles.rowFacts}>
                    <span className={styles.rowSubject}>
                        {finding.subject.name} {versionsOf(finding)}
                        {finding.fixed.length > 0 && ` → ${finding.fixed[0]}`}
                    </span>
                    <AssetChips finding={finding} />
                </span>
            </button>
        </li>
    );
}
