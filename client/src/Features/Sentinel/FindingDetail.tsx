import { useState } from 'react';
import { SENTINEL_RULES, type AllowScope, type Finding } from 'deveye-types';

import Button from '@/Components/Button';
import TextInput from '@/Components/TextInput';

import { ago, persistedFor, severityClass } from './FindingsList';
import styles from './style.module.css';

/**
 * Le détail d'un constat : ce qui a été vu, ce que ça veut dire, et quoi faire.
 *
 * Les trois blocs sont délibérément dans cet ordre, et la conduite à tenir n'est
 * pas facultative — un constat qui n'y répond pas ne sert personne.
 *
 * L'acquittement propose deux portées parce que les deux situations existent :
 * « ce port ouvert est normal **sur cette machine** » et « notre agent de
 * sauvegarde est légitime **partout** ». N'offrir que la première ferait rejuger
 * huit fois la même décision.
 *
 * « C'est réglé » n'est pas une troisième portée mais l'autre réponse possible :
 * on a corrigé, ce n'est pas devenu normal. Elle existe parce que le moteur ne
 * résout de lui-même que ce qu'il peut rejouer — une authentification suspecte ou
 * une entrée de persistance décrivent un fait passé, que plus aucun relevé ne
 * viendra contredire. Sans elle, la seule façon de ranger un constat corrigé
 * était de le déclarer légitime.
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

            {error && <p className={styles.error}>{error}</p>}

            {finding.state === 'acknowledged' ? (
                <div className={styles.actions}>
                    <p className={styles.ackNote}>
                        Jugé légitime : ce constat ne se rouvrira plus. Le rouvrir retire aussi l’autorisation qui le
                        couvrait.
                    </p>
                    <Button variant='secondary' disabled={busy} onClick={() => void run(onReopen)}>
                        Rouvrir
                    </Button>
                </div>
            ) : (
                <div className={styles.actions}>
                    {finding.state === 'open' && (
                        <div className={styles.settled}>
                            <p className={styles.settledNote}>
                                Corrigé ? Fermez-le sans le déclarer normal : il rouvrira de lui-même si la situation
                                revient.
                            </p>
                            <Button
                                variant='secondary'
                                icon='check-circle'
                                disabled={busy}
                                onClick={() => void run(onResolve)}
                            >
                                C’est réglé
                            </Button>
                        </div>
                    )}

                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>Raison (facultatif)</span>
                        <TextInput
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
                            Légitime ici
                        </Button>
                        <Button
                            variant='ghost'
                            disabled={busy}
                            onClick={() => void run(() => onAcknowledge('fleet', reason.trim() || null))}
                        >
                            Légitime partout
                        </Button>
                    </div>
                </div>
            )}
        </div>
    );
}
