import { SENTINEL_RULES, type AllowScope } from '../contracts/domain';

import FindingActions from './FindingActions';
import { severityClass, type FindingGroup } from './FindingsList';
import styles from './style.module.css';

/**
 * Le détail d'un groupe : ce que la règle veut dire et quoi faire, une fois pour
 * tous. Les sujets restent dans la liste dépliée, d'où l'on ouvre chacun.
 */

interface Props {
    group: FindingGroup;
    onAcknowledge: (scope: AllowScope, reason: string | null) => Promise<void>;
    onResolve: () => Promise<void>;
    onClose: () => void;
}

export default function FindingGroupDetail({ group, onAcknowledge, onResolve, onClose }: Props) {
    const meta = SENTINEL_RULES[group.rule];
    const n = group.findings.length;
    const pending = group.findings.filter((f) => f.state !== 'acknowledged').length;

    return (
        <div className={styles.detail}>
            <header className={styles.detailHead}>
                <span className={`${styles.detailBar} ${severityClass(group.severity)}`} aria-hidden='true' />
                <div className={styles.detailTitles}>
                    <h3 className={styles.detailTitle}>{meta.label}</h3>
                    <p className={styles.detailCount}>
                        {n} constats sur « {group.deviceName} »
                    </p>
                </div>
                <button type='button' className={styles.detailClose} onClick={onClose} aria-label='Fermer le détail'>
                    <span className='icon icon-x' />
                </button>
            </header>

            <p className={styles.detailDescription}>{meta.description}</p>

            <div className={styles.remediation}>
                <span className={`icon icon-info ${styles.remediationIcon}`} aria-hidden='true' />
                <p>{meta.remediation}</p>
            </div>

            {pending === 0 ? (
                <p className={styles.ackNote}>Tous jugés légitimes. Pour en rouvrir un, ouvrez-le depuis la liste.</p>
            ) : (
                <FindingActions
                    key={group.key}
                    count={pending}
                    canResolve={group.findings.some((f) => f.state === 'open')}
                    onAcknowledge={onAcknowledge}
                    onResolve={onResolve}
                />
            )}
        </div>
    );
}
