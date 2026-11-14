import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    ErrorNote,
    invalidate,
    SegmentedControl,
    StatusBadge,
    useResource,
    useSubView,
    type ErrorNoteInput
} from 'deveye-sdk-client';

import type { CveSeverityFilter } from '../contracts/domain';
import type { ExposureFinding, FindingKind } from '../contracts/exposure';

import { api } from './api';
import DetailPane from './DetailPane';
import { cveError } from './errors';
import { FINDING_KINDS, since, SOURCE_ICON, versionsOf } from './exposureLabels';
import FindingDetail from './FindingDetail';
import { ago, fullDate, SEVERITY_FILTERS, SEVERITY_LABEL, severityTone } from './severity';
import styles from './style.module.css';

/** Ce que la liste montre : ce qui demande une décision, ce qui en a reçu une, ce qui est réglé. */
type StateFilter = 'open' | 'ignored' | 'resolved';

const STATE_FILTERS: readonly { value: StateFilter; label: string }[] = [
    { value: 'open', label: 'À traiter' },
    { value: 'ignored', label: 'Ignorés' },
    { value: 'resolved', label: 'Résolus' }
];

const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, none: 0 };

/** Ce que la veille a trouvé dans l'espace : un constat par faille, avec ce qu'il touche. */
export default function ExposureView({
    canWrite,
    onDetailChange
}: {
    canWrite: boolean;
    onDetailChange: (open: boolean) => void;
}) {
    const [kind, setKind] = useState<FindingKind>('vuln');
    const [state, setState] = useState<StateFilter>('open');
    const [severity, setSeverity] = useState<CveSeverityFilter>('all');
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    const view = state === 'resolved' ? 'resolved' : 'active';
    const exposure = useResource(
        'cve.exposure',
        () => api.send('cve.exposure', { view }),
        'Les constats n’ont pas pu être lus.',
        [view]
    );
    const findings = useMemo(
        () => (exposure.data?.findings ?? []).filter((f) => f.state === state),
        [exposure.data, state]
    );
    const shown = useMemo(
        () =>
            findings
                .filter((f) => f.kind === kind && (severity === 'all' || f.severity === severity))
                .sort(
                    (a, b) =>
                        (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || b.firstSeen - a.firstSeen
                ),
        [findings, kind, severity]
    );
    const kinds = useMemo(
        () =>
            FINDING_KINDS.map((k) => {
                const n = findings.filter((f) => f.kind === k.value).length;
                return { value: k.value, label: n > 0 ? `${k.label} ${n}` : k.label };
            }),
        [findings]
    );
    const selected = shown.find((f) => f.id === selectedId) ?? findings.find((f) => f.id === selectedId) ?? null;

    useSubView(selected ? 'finding' : null);
    useEffect(() => {
        onDetailChange(selected !== null);
        return () => onDetailChange(false);
    }, [selected, onDetailChange]);

    const act = useCallback(async (run: () => Promise<{ finding: ExposureFinding }>, fallback: string) => {
        setBusy(true);
        setError(null);
        try {
            await run();
            invalidate('cve.exposure', 'cve.exposureCount', 'cve.inventory');
        } catch (e) {
            setError(cveError(e, fallback));
        } finally {
            setBusy(false);
        }
    }, []);

    const scannedAt = exposure.data?.scannedAt ?? null;
    const notices = exposure.data?.notices ?? [];
    const kindLabel = FINDING_KINDS.find((k) => k.value === kind);

    return (
        <>
            <div className={styles.listTools}>
                <div className={styles.filters}>
                    <SegmentedControl options={kinds} value={kind} onChange={setKind} aria-label='Genre de constat' />
                    <div className={styles.severityChips} role='group' aria-label='Filtrer par état'>
                        {STATE_FILTERS.map((f) => (
                            <button
                                key={f.value}
                                type='button'
                                className={`${styles.chip} ${f.value === state ? styles.chipActive : ''}`}
                                aria-pressed={f.value === state}
                                onClick={() => setState(f.value)}
                            >
                                {f.label}
                            </button>
                        ))}
                    </div>
                </div>
                {kind === 'vuln' && (
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
                )}
                <p className={styles.status}>
                    {exposure.loading
                        ? 'Chargement…'
                        : scannedAt === null
                          ? 'Rien n’a encore été analysé.'
                          : `Dernière lecture ${since(scannedAt)}.`}
                </p>
                {notices.map((n) => (
                    <p key={n} className={styles.notice}>
                        <span className={`icon icon-warning ${styles.noticeIcon}`} aria-hidden='true' />
                        {n} Les constats d’avant restent affichés.
                    </p>
                ))}
            </div>

            <ErrorNote note={error ?? exposure.error} />

            <div className={styles.split}>
                <div className={styles.listPane}>
                    {shown.length === 0 && !exposure.loading ? (
                        <p className={styles.empty}>
                            {scannedAt === null
                                ? 'La veille lit les dépôts de la feature Git : un dépôt ajouté est analysé dans les minutes qui suivent.'
                                : state === 'open'
                                  ? (kindLabel?.empty ?? 'Rien à signaler.')
                                  : state === 'ignored'
                                    ? 'Aucun constat ignoré.'
                                    : 'Rien de résolu ces trente derniers jours.'}
                        </p>
                    ) : (
                        <ul className={styles.list}>
                            {shown.map((f) => (
                                <FindingRow
                                    key={f.id}
                                    finding={f}
                                    selected={f.id === selectedId}
                                    onOpen={() => setSelectedId((cur) => (cur === f.id ? null : f.id))}
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
                            busy={busy}
                            onIgnore={(f, reason) =>
                                void act(
                                    () => api.send('cve.findingIgnore', { id: f.id, reason }),
                                    'Le constat n’a pas pu être ignoré.'
                                )
                            }
                            onRestore={(f) =>
                                void act(
                                    () => api.send('cve.findingRestore', { id: f.id }),
                                    'Le constat n’a pas pu être rétabli.'
                                )
                            }
                            onClose={() => setSelectedId(null)}
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
    const shownAssets = finding.affected.slice(0, 3);
    const more = finding.affected.length - shownAssets.length;
    return (
        <li className={`${styles.row} ${selected ? styles.rowSelected : ''}`}>
            <button type='button' className={styles.rowMain} onClick={onOpen}>
                <span className={styles.rowHead}>
                    <span className={styles.rowId}>{finding.advisoryId ?? finding.subject.name}</span>
                    {finding.kind === 'vuln' && (
                        <StatusBadge tone={severityTone(finding.severity)}>
                            {finding.score === null
                                ? SEVERITY_LABEL[finding.severity]
                                : `${SEVERITY_LABEL[finding.severity]} ${finding.score.toFixed(1)}`}
                        </StatusBadge>
                    )}
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
                    {shownAssets.map((a) => (
                        <span key={a.assetId} className={styles.assetChip}>
                            <span
                                className={`icon ${SOURCE_ICON[a.source]} ${styles.assetChipIcon}`}
                                aria-hidden='true'
                            />
                            {a.label}
                        </span>
                    ))}
                    {more > 0 && <span className={styles.assetChip}>+{more}</span>}
                </span>
            </button>
        </li>
    );
}
