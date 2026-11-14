import { useState } from 'react';
import { Button, openFeature, safeHref, StatusBadge, TextInput } from 'deveye-sdk-client';

import { FINDING_REASON_MAX } from '../contracts/commands';
import type { ExposureFinding } from '../contracts/exposure';

import { FIXED_LABEL, since, SOURCE_FEATURE, SOURCE_ICON, whereLine } from './exposureLabels';
import { useDetailAsPage } from './layout';
import { fullDate, SEVERITY_LABEL, severityTone } from './severity';
import styles from './style.module.css';

interface Props {
    finding: ExposureFinding;
    canWrite: boolean;
    busy: boolean;
    onIgnore: (finding: ExposureFinding, reason: string) => void;
    onRestore: (finding: ExposureFinding) => void;
    onClose: () => void;
}

/** Un constat en détail : ce qu'il dit, ce qu'il touche dans l'espace, et la décision à prendre. */
export default function FindingDetail({ finding, canWrite, busy, onIgnore, onRestore, onClose }: Props) {
    const asPage = useDetailAsPage();
    const [asking, setAsking] = useState(false);
    const [reason, setReason] = useState('');
    const reference = safeHref(finding.reference);

    return (
        <div className={styles.detail}>
            <header className={styles.detailHead}>
                <button
                    type='button'
                    className={styles.iconBtn}
                    onClick={onClose}
                    title={asPage ? 'Revenir à la liste' : 'Fermer la fiche'}
                    aria-label={asPage ? 'Revenir à la liste' : 'Fermer la fiche'}
                >
                    <span className={`icon ${asPage ? 'icon-arrow-left' : 'icon-x'}`} />
                </button>
                <h3 className={styles.detailTitle}>{finding.advisoryId ?? finding.subject.name}</h3>
                {reference && (
                    <a
                        className={styles.iconBtn}
                        href={reference}
                        target='_blank'
                        rel='noreferrer'
                        title='Ouvrir l’avis publié'
                        aria-label='Ouvrir l’avis publié'
                    >
                        <span className='icon icon-move-to-right' />
                    </a>
                )}
            </header>

            <div className={styles.detailMeta}>
                {finding.kind === 'eol' && (
                    <StatusBadge tone={finding.severity === 'high' ? 'danger' : 'warning'}>
                        {finding.severity === 'high' ? 'Fin de vie atteinte' : 'Fin de vie proche'}
                    </StatusBadge>
                )}
                {finding.kind === 'vuln' && (
                    <StatusBadge tone={severityTone(finding.severity)}>
                        {finding.score === null
                            ? SEVERITY_LABEL[finding.severity]
                            : `${SEVERITY_LABEL[finding.severity]} ${finding.score.toFixed(1)}`}
                    </StatusBadge>
                )}
                {finding.state === 'ignored' && <StatusBadge tone='neutral'>Ignoré</StatusBadge>}
                {finding.state === 'resolved' && <StatusBadge tone='success'>Résolu</StatusBadge>}
                <span className={styles.detailDate}>Vu pour la première fois le {fullDate(finding.firstSeen)}</span>
            </div>

            <p className={styles.detailSummary}>{finding.summary}</p>

            <dl className={styles.detailFacts}>
                <dt>Touche</dt>
                <dd>
                    {finding.subject.name}
                    {finding.subject.kind === 'package' && ` (${finding.subject.ecosystem})`}
                </dd>
                <dt>{FIXED_LABEL[finding.kind]}</dt>
                <dd>{finding.fixed.length > 0 ? finding.fixed.join(', ') : 'aucune version corrigée publiée'}</dd>
                {finding.aliases.length > 0 && (
                    <>
                        <dt>Aussi publié sous</dt>
                        <dd>{finding.aliases.join(', ')}</dd>
                    </>
                )}
                {finding.resolvedAt !== null && (
                    <>
                        <dt>Résolu</dt>
                        <dd>{since(finding.resolvedAt)}</dd>
                    </>
                )}
            </dl>

            <section className={styles.detailSection}>
                <h4 className={styles.detailSectionTitle}>Ce qui est touché</h4>
                <ul className={styles.affectedList}>
                    {finding.affected.map((a) => (
                        <li key={a.assetId} className={styles.affectedRow}>
                            <span
                                className={`icon ${SOURCE_ICON[a.source]} ${styles.affectedIcon}`}
                                aria-hidden='true'
                            />
                            <span className={styles.affectedText}>
                                <button
                                    type='button'
                                    className={styles.linkBtn}
                                    title='Ouvrir l’élément'
                                    onClick={() => openFeature(SOURCE_FEATURE[a.source], a.ref)}
                                >
                                    {a.label}
                                </button>
                                <span className={styles.affectedWhere}>{whereLine(a)}</span>
                            </span>
                        </li>
                    ))}
                </ul>
            </section>

            {finding.state === 'ignored' && (
                <p className={styles.detailMore}>
                    Ignoré {finding.ignoredAt === null ? '' : since(finding.ignoredAt)}
                    {finding.reason ? ` : « ${finding.reason} »` : ''}. Un élément touché plus tard le rouvrira.
                </p>
            )}

            {canWrite && finding.state === 'open' && !asking && (
                <div className={styles.detailActions}>
                    <Button variant='secondary' icon='eye-close' onClick={() => setAsking(true)}>
                        Ignorer
                    </Button>
                </div>
            )}
            {canWrite && finding.state === 'open' && asking && (
                <div className={styles.ignoreForm}>
                    <TextInput
                        value={reason}
                        maxLength={FINDING_REASON_MAX}
                        placeholder='Pourquoi, en quelques mots (facultatif)'
                        aria-label='Raison de la décision'
                        onChange={(e) => setReason(e.target.value)}
                    />
                    <div className={styles.detailActions}>
                        <Button variant='ghost' onClick={() => setAsking(false)}>
                            Annuler
                        </Button>
                        <Button
                            variant='primary'
                            disabled={busy}
                            onClick={() => {
                                onIgnore(finding, reason.trim());
                                setAsking(false);
                                setReason('');
                            }}
                        >
                            Ignorer ce constat
                        </Button>
                    </div>
                </div>
            )}
            {canWrite && finding.state === 'ignored' && (
                <div className={styles.detailActions}>
                    <Button variant='secondary' icon='eye-open' disabled={busy} onClick={() => onRestore(finding)}>
                        Rétablir
                    </Button>
                </div>
            )}
        </div>
    );
}
