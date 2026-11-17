import { useMemo } from 'react';
import { ErrorNote, StatusBadge } from 'deveye-sdk-client';

import type { ExposureFinding, FindingKind } from '../contracts/exposure';

import AssetChips from './AssetChips';
import DetailPane from './DetailPane';
import { behindLine, eolBadge, eolName, eolReached, versionsOf } from './exposureLabels';
import FindingDetail from './FindingDetail';
import FindingFilters, { emptyFindingsLine } from './FindingFilters';
import { dayMs } from './softwareLabels';
import styles from './style.module.css';
import { useFindings } from './useFindings';

const KINDS: readonly FindingKind[] = ['eol', 'deprecated', 'outdated'];

type ObsoleteKind = Exclude<FindingKind, 'vuln'>;

const SECTIONS: readonly { kind: ObsoleteKind; title: string; hint: string }[] = [
    { kind: 'eol', title: 'Fins de vie', hint: 'Plus de correctifs de sécurité, ou bientôt plus.' },
    { kind: 'deprecated', title: 'Versions dépréciées', hint: 'Leur auteur demande de ne plus les utiliser.' },
    {
        kind: 'outdated',
        title: 'En retard d’une version majeure',
        hint: 'Une dépendance que le projet déclare a une version majeure plus récente.'
    }
];

/** Les atteintes d'abord, puis la date la plus proche ; sans date, en dernier de leur groupe. */
function eolOrder(a: ExposureFinding, b: ExposureFinding): number {
    const reached = Number(eolReached(b)) - Number(eolReached(a));
    if (reached !== 0) return reached;
    const at = (f: ExposureFinding): number => (f.eol?.date ? dayMs(f.eol.date) : Infinity);
    return at(a) - at(b) || eolName(a).localeCompare(eolName(b));
}

const ORDER: Record<ObsoleteKind, (a: ExposureFinding, b: ExposureFinding) => number> = {
    eol: eolOrder,
    deprecated: (a, b) => a.subject.name.localeCompare(b.subject.name),
    outdated: (a, b) => (b.behind ?? 0) - (a.behind ?? 0) || a.subject.name.localeCompare(b.subject.name)
};

/** Ce qui vieillit dans l'espace : les fins de vie, les versions dépréciées, les dépendances en retard. */
export default function ObsolescenceView({
    canWrite,
    onDetailChange
}: {
    canWrite: boolean;
    onDetailChange: (open: boolean) => void;
}) {
    const findings = useFindings(KINDS, onDetailChange);
    const sections = useMemo(
        () =>
            SECTIONS.map((s) => ({
                ...s,
                items: findings.findings.filter((f) => f.kind === s.kind).sort(ORDER[s.kind])
            })).filter((s) => s.items.length > 0),
        [findings.findings]
    );
    const selected = findings.selected;

    return (
        <>
            <FindingFilters findings={findings} />
            <ErrorNote note={findings.error} />

            <div className={styles.split}>
                <div className={styles.listPane}>
                    {sections.length === 0 && !findings.loading ? (
                        <p className={styles.empty}>
                            {emptyFindingsLine(
                                findings,
                                'Rien d’obsolète dans ce que l’espace fait tourner : aucune fin de vie dans les trente jours, aucune version dépréciée ni en retard d’une version majeure.'
                            )}
                        </p>
                    ) : (
                        <div className={styles.sections}>
                            {sections.map((s) => (
                                <section key={s.kind} className={styles.section}>
                                    <header className={styles.sectionHead}>
                                        <h3 className={styles.sectionTitle}>
                                            {s.title} <span className={styles.sectionCount}>{s.items.length}</span>
                                        </h3>
                                        <p className={styles.sectionHint}>{s.hint}</p>
                                    </header>
                                    <ul className={styles.list}>
                                        {s.items.map((f) => (
                                            <ObsoleteRow
                                                key={f.id}
                                                finding={f}
                                                selected={f.id === selected?.id}
                                                onOpen={() => findings.toggle(f.id)}
                                            />
                                        ))}
                                    </ul>
                                </section>
                            ))}
                        </div>
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

function ObsoleteRow({
    finding: f,
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
                {f.kind === 'eol' ? <EolLines finding={f} /> : null}
                {f.kind === 'deprecated' ? <DeprecatedLines finding={f} /> : null}
                {f.kind === 'outdated' ? <OutdatedLines finding={f} /> : null}
                <span className={styles.rowFacts}>
                    <AssetChips finding={f} />
                </span>
            </button>
        </li>
    );
}

function EolLines({ finding: f }: { finding: ExposureFinding }) {
    const badge = eolBadge(f);
    return (
        <>
            <span className={styles.rowHead}>
                <span className={styles.rowId}>{eolName(f)}</span>
                <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
            </span>
            <span className={styles.rowLine}>
                <span className={styles.rowSubject}>{versionsOf(f)}</span>
                {f.fixed.length > 0 && ` · passer à ${f.fixed.join(' ou ')}`}
            </span>
        </>
    );
}

function DeprecatedLines({ finding: f }: { finding: ExposureFinding }) {
    return (
        <>
            <span className={styles.rowHead}>
                <span className={styles.rowId}>
                    {f.subject.name} <span className={styles.rowSubject}>{versionsOf(f)}</span>
                </span>
                <StatusBadge tone='warning'>Dépréciée</StatusBadge>
            </span>
            <span className={styles.rowLine}>
                {f.summary}
                {f.fixed.length > 0 && ` · dernière : ${f.fixed[0]}`}
            </span>
        </>
    );
}

function OutdatedLines({ finding: f }: { finding: ExposureFinding }) {
    return (
        <span className={styles.rowHead}>
            <span className={styles.rowId}>{f.subject.name}</span>
            <span className={styles.rowSubject}>
                {versionsOf(f)} → {f.fixed[0] ?? '?'}
            </span>
            {f.behind !== null && <StatusBadge tone='neutral'>{behindLine(f.behind)}</StatusBadge>}
        </span>
    );
}
