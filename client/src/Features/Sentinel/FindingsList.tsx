import { SENTINEL_RULES, type Finding, type FindingSeverity } from 'deveye-types';

import styles from './style.module.css';

/**
 * Les constats, groupés par gravité, le pire en tête.
 *
 * Le tri vient du serveur (`severity DESC, last_seen DESC`) ; on ne fait que le
 * découper en sections. Regrouper côté client sur une liste déjà triée évite de
 * refaire le tri et garantit que l'ordre affiché est celui que la commande a
 * produit — deux tris qui se croiseraient finiraient par diverger.
 */

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

/** « il y a 3 min », « il y a 2 j » — la précision utile, pas la date exacte. */
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
    findings: Finding[];
    selectedId: number | null;
    onSelect: (finding: Finding) => void;
    /** Affiche le nom de l'appareil (vue de flotte ; inutile en vue d'appareil). */
    showDevice: boolean;
    /** La machine apprend encore : le vide veut dire autre chose. */
    learning: boolean;
}

export default function FindingsList({ findings, selectedId, onSelect, showDevice, learning }: Props) {
    if (findings.length === 0) {
        return (
            <p className={styles.empty}>
                {learning
                    ? 'Rien à signaler pour l’instant — et l’apprentissage court encore, donc les écarts de comportement ne sont pas encore jugés.'
                    : 'Rien à signaler.'}
            </p>
        );
    }

    return (
        <div className={styles.findings}>
            {SEVERITY_ORDER.map((severity) => {
                const group = findings.filter((f) => f.severity === severity);
                if (group.length === 0) return null;
                return (
                    <section key={severity} className={styles.findingGroup}>
                        <h4 className={styles.groupTitle}>
                            <span className={`${styles.sevDot} ${severityClass(severity)}`} />
                            {SEVERITY_LABEL[severity]}
                            <span className={styles.groupCount}>{group.length}</span>
                        </h4>
                        <ul className={styles.findingRows}>
                            {group.map((finding) => (
                                <li key={finding.id}>
                                    <button
                                        type='button'
                                        className={`${styles.findingRow} ${
                                            finding.id === selectedId ? styles.findingRowActive : ''
                                        } ${finding.state !== 'open' ? styles.findingRowMuted : ''}`}
                                        onClick={() => onSelect(finding)}
                                    >
                                        <span
                                            className={`${styles.findingBar} ${severityClass(finding.severity)}`}
                                            aria-hidden='true'
                                        />
                                        <span className={styles.findingMain}>
                                            <span className={styles.findingRule}>
                                                {SENTINEL_RULES[finding.rule].label}
                                            </span>
                                            <span className={styles.findingSubject}>{finding.subject}</span>
                                        </span>
                                        <span className={styles.findingMeta}>
                                            {finding.state === 'acknowledged' && (
                                                <span className={styles.chip}>légitime</span>
                                            )}
                                            {finding.state === 'resolved' && (
                                                <span className={styles.chip}>résolu</span>
                                            )}
                                            {finding.occurrences > 1 && (
                                                <span className={styles.chip}>×{finding.occurrences}</span>
                                            )}
                                            {showDevice && (
                                                <span className={styles.findingDevice}>{finding.deviceName}</span>
                                            )}
                                            <span className={styles.findingAgo}>{ago(finding.lastSeen)}</span>
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                );
            })}
        </div>
    );
}
