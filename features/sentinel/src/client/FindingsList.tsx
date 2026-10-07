import { useState } from 'react';

import { SENTINEL_RULES, type Finding, type FindingSeverity } from '../contracts/domain';

import { formatDuration } from './format';
import styles from './style.module.css';

/** Groupés par gravité, le pire en tête. Le tri vient du serveur ; on ne fait que découper en sections. */

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'low', 'info'];

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
    critical: 'Critique',
    high: 'Élevé',
    low: 'À surveiller',
    info: 'Information'
};

export function severityClass(severity: FindingSeverity): string {
    switch (severity) {
        case 'critical':
            return styles.sevCritical;
        case 'high':
            return styles.sevHigh;
        case 'low':
            return styles.sevLow;
        default:
            return styles.sevInfo;
    }
}

/**
 * Depuis combien de temps la situation dure. Un décompte d'occurrences se
 * lisait comme autant de problèmes. `null` sous la minute.
 */
export function persistedFor(finding: Pick<Finding, 'firstSeen' | 'lastSeen'>): string | null {
    const span = finding.lastSeen - finding.firstSeen;
    return span < 60_000 ? null : formatDuration(span);
}

/**
 * Les constats d'une même règle sur un même appareil, dans le même état : une
 * seule ligne dans la liste, qu'on déplie, et qu'on règle d'un geste.
 */
export interface FindingGroup {
    key: string;
    rule: Finding['rule'];
    severity: FindingSeverity;
    deviceName: string;
    /** Dans l'ordre du serveur, le plus récent d'abord. */
    findings: Finding[];
}

/** Regroupe sans réordonner : un groupe prend la place de son constat le plus récent. */
export function groupFindings(findings: readonly Finding[]): FindingGroup[] {
    const groups = new Map<string, FindingGroup>();
    for (const finding of findings) {
        const key = `${finding.severity}|${finding.state}|${finding.rule}|${finding.deviceId}`;
        const group = groups.get(key);
        if (group) group.findings.push(finding);
        else
            groups.set(key, {
                key,
                rule: finding.rule,
                severity: finding.severity,
                deviceName: finding.deviceName,
                findings: [finding]
            });
    }
    return [...groups.values()];
}

/** « il y a 3 min », « il y a 2 j » : la précision utile, pas la date exacte. */
export function ago(ts: number): string {
    const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (seconds < 60) return "à l'instant";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    const days = Math.floor(hours / 24);
    return `il y a ${days} j`;
}

interface Props {
    groups: FindingGroup[];
    selectedId: number | null;
    onSelect: (finding: Finding) => void;
    selectedGroupKey: string | null;
    /** `null` quand le groupe se replie : son détail se ferme avec lui. */
    onSelectGroup: (key: string | null) => void;
    /** Affiche le nom de l'appareil (vue de flotte ; inutile en vue d'appareil). */
    showDevice: boolean;
    /** La machine apprend encore : le vide veut dire autre chose. */
    learning: boolean;
}

export default function FindingsList({
    groups,
    selectedId,
    onSelect,
    selectedGroupKey,
    onSelectGroup,
    showDevice,
    learning
}: Props) {
    const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

    /** Déplié mais pas affiché à droite : le clic rouvre son détail plutôt que de le replier. */
    function toggle(key: string): void {
        const opening = !expanded.has(key);
        if (!opening && selectedGroupKey !== key) {
            onSelectGroup(key);
            return;
        }
        setExpanded((cur) => {
            const next = new Set(cur);
            if (opening) next.add(key);
            else next.delete(key);
            return next;
        });
        onSelectGroup(opening ? key : null);
    }

    function row(finding: Finding, nested: boolean) {
        const persisted = persistedFor(finding);
        return (
            <li key={finding.id}>
                <button
                    type='button'
                    className={`${styles.findingRow} ${nested ? styles.findingRowNested : ''} ${
                        finding.id === selectedId ? styles.findingRowActive : ''
                    } ${finding.state !== 'open' ? styles.findingRowMuted : ''}`}
                    onClick={() => onSelect(finding)}
                >
                    <span className={`${styles.findingBar} ${severityClass(finding.severity)}`} aria-hidden='true' />
                    <span className={styles.findingMain}>
                        {!nested && <span className={styles.findingRule}>{SENTINEL_RULES[finding.rule].label}</span>}
                        <span className={styles.findingSubject}>{finding.subject}</span>
                    </span>
                    <span className={styles.findingMeta}>
                        {finding.state === 'acknowledged' && <span className={styles.chip}>légitime</span>}
                        {finding.state === 'resolved' && <span className={styles.chip}>résolu</span>}
                        {persisted !== null && (
                            <span
                                className={styles.chip}
                                // Le décompte brut reste dans l'infobulle.
                                title={`Situation vue sans interruption depuis ${persisted} (${finding.occurrences} relevés)`}
                                aria-label={`Présent depuis ${persisted}`}
                            >
                                {persisted}
                            </span>
                        )}
                        {showDevice && !nested && <span className={styles.findingDevice}>{finding.deviceName}</span>}
                        <span className={styles.findingAgo}>{ago(finding.lastSeen)}</span>
                    </span>
                </button>
            </li>
        );
    }

    if (groups.length === 0) {
        return (
            <p className={styles.empty}>
                {learning
                    ? 'Rien à signaler pour l’instant, et l’apprentissage court encore, donc les écarts de comportement ne sont pas encore jugés.'
                    : 'Rien à signaler.'}
            </p>
        );
    }

    return (
        <div className={styles.findings}>
            {SEVERITY_ORDER.map((severity) => {
                const section = groups.filter((g) => g.severity === severity);
                if (section.length === 0) return null;
                const count = section.reduce((n, g) => n + g.findings.length, 0);
                return (
                    <section key={severity} className={styles.findingGroup}>
                        <h4 className={styles.groupTitle}>
                            <span className={`${styles.sevDot} ${severityClass(severity)}`} />
                            {SEVERITY_LABEL[severity]}
                            <span className={styles.groupCount}>{count}</span>
                        </h4>
                        <ul className={styles.findingRows}>
                            {section.map((group) => {
                                if (group.findings.length === 1) return row(group.findings[0]!, false);
                                const open = expanded.has(group.key);
                                const label = SENTINEL_RULES[group.rule].label;
                                const n = group.findings.length;
                                const muted = group.findings[0]!.state !== 'open';
                                return (
                                    <li key={group.key}>
                                        <button
                                            type='button'
                                            className={`${styles.findingRow} ${
                                                group.key === selectedGroupKey ? styles.findingRowActive : ''
                                            } ${muted ? styles.findingRowMuted : ''}`}
                                            aria-expanded={open}
                                            aria-label={`${n} constats « ${label} » sur ${group.deviceName}`}
                                            onClick={() => toggle(group.key)}
                                        >
                                            <span
                                                className={`${styles.findingBar} ${severityClass(group.severity)}`}
                                                aria-hidden='true'
                                            />
                                            <span className={styles.findingMain}>
                                                <span className={styles.findingRule}>{label}</span>
                                                <span className={styles.findingSubject}>
                                                    {group.findings
                                                        .slice(0, 3)
                                                        .map((f) => f.subject)
                                                        .join(', ')}
                                                    {n > 3 ? ', …' : ''}
                                                </span>
                                            </span>
                                            <span className={styles.findingMeta}>
                                                <span className={styles.chip}>{n} constats</span>
                                                {showDevice && (
                                                    <span className={styles.findingDevice}>{group.deviceName}</span>
                                                )}
                                                <span className={styles.findingAgo}>
                                                    {ago(Math.max(...group.findings.map((f) => f.lastSeen)))}
                                                </span>
                                                <span
                                                    className={`icon icon-chevron-down ${styles.groupChevron} ${
                                                        open ? styles.groupChevronOpen : ''
                                                    }`}
                                                    aria-hidden='true'
                                                />
                                            </span>
                                        </button>
                                        {open && (
                                            <ul className={`${styles.findingRows} ${styles.groupMembers}`}>
                                                {group.findings.map((f) => row(f, true))}
                                            </ul>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </section>
                );
            })}
        </div>
    );
}
