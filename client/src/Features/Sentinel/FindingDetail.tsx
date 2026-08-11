import { useState } from 'react';
import { SENTINEL_RULES, type AllowScope, type Finding } from 'deveye-types';

import Button from '@/Components/Button';

import { ago, severityClass } from './FindingsList';
import styles from './style.module.css';

/**
 * Le détail d'un constat : ce qui a été vu, ce que ça veut dire, et quoi faire.
 *
 * Les trois blocs sont délibérément dans cet ordre. Un constat qui n'annonce pas
 * de conduite à tenir ne sert personne — c'est pourquoi `remediation` est
 * obligatoire dans le catalogue de règles, et pourquoi elle s'affiche ici même
 * quand elle paraît évidente.
 *
 * L'acquittement propose deux portées parce que les deux situations existent
 * vraiment : « ce port ouvert est normal **sur cette machine** » et « notre agent
 * de sauvegarde est légitime **partout** ». Ne proposer que la première ferait
 * rejuger huit fois la même décision.
 */

interface Props {
    finding: Finding;
    onAcknowledge: (scope: AllowScope, reason: string | null) => Promise<void>;
    onReopen: () => Promise<void>;
    /** Ouvre Monitoring sur l'instant épinglé qui porte la preuve. */
    onOpenSnapshot: ((deviceId: string, ts: number) => void) | null;
}

export default function FindingDetail({ finding, onAcknowledge, onReopen, onOpenSnapshot }: Props) {
    const meta = SENTINEL_RULES[finding.rule];
    const [reason, setReason] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function run(action: () => Promise<void>): Promise<void> {
        setBusy(true);
        setError(null);
        try {
            await action();
        } catch {
            setError("L'action n'a pas abouti.");
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className={styles.detail}>
            <header className={styles.detailHead}>
                <span className={`${styles.sevDot} ${severityClass(finding.severity)}`} />
                <div>
                    <h2 className={styles.detailTitle}>{meta.label}</h2>
                    <p className={styles.detailSubject}>{finding.subject}</p>
                </div>
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
                        {finding.occurrences > 1 && ` — ${finding.occurrences} occurrences`}
                    </dd>
                </div>
            </dl>

            <div className={styles.remediation}>
                <span className={`icon icon-info ${styles.remediationIcon}`} />
                <p>{meta.remediation}</p>
            </div>

            {finding.snapshotTs !== null && onOpenSnapshot && (
                <Button
                    variant='secondary'
                    icon='activity'
                    onClick={() => onOpenSnapshot(finding.deviceId, finding.snapshotTs!)}
                >
                    Voir l’instant de la détection
                </Button>
            )}

            {error && <p className={styles.error}>{error}</p>}

            {finding.state === 'acknowledged' ? (
                <div className={styles.actions}>
                    <p className={styles.ackNote}>
                        Ce constat a été jugé légitime : il ne se rouvrira plus. Le rouvrir retire aussi l’autorisation
                        qui le couvrait.
                    </p>
                    <Button variant='secondary' disabled={busy} onClick={() => void run(onReopen)}>
                        Rouvrir
                    </Button>
                </div>
            ) : (
                <div className={styles.actions}>
                    <label className={styles.reasonLabel}>
                        Raison (facultatif)
                        <input
                            className={styles.reasonInput}
                            value={reason}
                            maxLength={255}
                            placeholder='ex. installé par nos soins le 3 mars'
                            onChange={(e) => setReason(e.target.value)}
                        />
                    </label>
                    <div className={styles.actionRow}>
                        <Button
                            variant='secondary'
                            disabled={busy}
                            onClick={() => void run(() => onAcknowledge('device', reason.trim() || null))}
                        >
                            Légitime sur cet appareil
                        </Button>
                        <Button
                            variant='ghost'
                            disabled={busy}
                            onClick={() => void run(() => onAcknowledge('fleet', reason.trim() || null))}
                        >
                            Légitime sur toute la flotte
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
