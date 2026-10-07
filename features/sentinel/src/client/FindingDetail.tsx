import { Button } from 'deveye-sdk-client';

import { SENTINEL_RULES, type AllowScope, type Finding } from '../contracts/domain';

import FindingActions, { useAction } from './FindingActions';
import { ago, persistedFor, severityClass } from './FindingsList';
import styles from './style.module.css';

/**
 * Le détail d'un constat : ce qui a été vu, ce que ça veut dire, quoi faire.
 * Deux portées d'acquittement (cette machine, partout). « C'est réglé » est
 * l'autre réponse : corrigé, pas devenu normal ; nécessaire pour les constats
 * d'événement que le moteur ne peut pas rejouer.
 */

interface Props {
    finding: Finding;
    onAcknowledge: (scope: AllowScope, reason: string | null) => Promise<void>;
    onResolve: () => Promise<void>;
    onReopen: () => Promise<void>;
    onClose: () => void;
}

export default function FindingDetail({ finding, onAcknowledge, onResolve, onReopen, onClose }: Props) {
    const meta = SENTINEL_RULES[finding.rule];
    const persisted = persistedFor(finding);
    const { busy, error, run } = useAction();

    return (
        <div className={styles.detail}>
            <header className={styles.detailHead}>
                <span className={`${styles.detailBar} ${severityClass(finding.severity)}`} aria-hidden='true' />
                <div className={styles.detailTitles}>
                    <h3 className={styles.detailTitle}>{meta.label}</h3>
                    <p className={styles.detailSubject}>{finding.subject}</p>
                </div>
                <button type='button' className={styles.detailClose} onClick={onClose} aria-label='Fermer le détail'>
                    <span className='icon icon-x' />
                </button>
            </header>

            <p className={styles.detailDescription}>{meta.description}</p>

            <dl className={styles.evidence}>
                {finding.evidence.map((item, i) => (
                    <div key={`${item.label}-${i}`} className={styles.evidenceRow}>
                        <dt>{item.label}</dt>
                        <dd>{item.value}</dd>
                    </div>
                ))}
                <div className={styles.evidenceRow}>
                    <dt>Appareil</dt>
                    <dd>{finding.deviceName}</dd>
                </div>
                <div className={styles.evidenceRow}>
                    <dt>Première fois</dt>
                    <dd>{ago(finding.firstSeen)}</dd>
                </div>
                <div className={styles.evidenceRow}>
                    <dt>Dernière fois</dt>
                    <dd>
                        {ago(finding.lastSeen)}
                        {persisted !== null && (
                            <span
                                className={styles.evidenceNote}
                                title={`${finding.occurrences} relevés depuis le premier signalement`}
                            >
                                présent depuis {persisted}
                            </span>
                        )}
                    </dd>
                </div>
                {finding.snapshotTs !== null && (
                    <div className={styles.evidenceRow}>
                        <dt>Instant conservé</dt>
                        <dd>
                            {new Date(finding.snapshotTs).toLocaleString()}
                            <span className={styles.evidenceNote}>épinglé : la rétention ne l’effacera pas</span>
                        </dd>
                    </div>
                )}
            </dl>

            <div className={styles.remediation}>
                <span className={`icon icon-info ${styles.remediationIcon}`} aria-hidden='true' />
                <p>{meta.remediation}</p>
            </div>

            {finding.state === 'acknowledged' ? (
                <div className={styles.actions}>
                    {error && <p className={styles.error}>{error}</p>}
                    <p className={styles.ackNote}>
                        Jugé légitime : ce constat ne se rouvrira plus. Le rouvrir retire aussi l’autorisation qui le
                        couvrait.
                    </p>
                    <Button variant='secondary' disabled={busy} onClick={() => void run(onReopen)}>
                        Rouvrir
                    </Button>
                </div>
            ) : (
                // La clé remet la raison à vide d'un constat à l'autre.
                <FindingActions
                    key={finding.id}
                    count={1}
                    canResolve={finding.state === 'open'}
                    onAcknowledge={onAcknowledge}
                    onResolve={onResolve}
                />
            )}
        </div>
    );
}
