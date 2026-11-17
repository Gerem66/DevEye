import { useEffect, useState } from 'react';
import { Button, openFeature, safeHref, StatusBadge, TextInput } from 'deveye-sdk-client';

import { FINDING_REASON_MAX } from '../contracts/commands';
import type { ExposureFinding, FindingKind } from '../contracts/exposure';
import type { Software } from '../contracts/software';

import { api } from './api';
import {
    behindLine,
    eolBadge,
    eolName,
    since,
    SOURCE_FEATURE,
    SOURCE_ICON,
    versionsOf,
    whereLine
} from './exposureLabels';
import { useDetailAsPage } from './layout';
import { fullDate, SEVERITY_LABEL, severityTone } from './severity';
import SoftwareTable from './SoftwareTable';
import styles from './style.module.css';

interface Props {
    finding: ExposureFinding;
    canWrite: boolean;
    busy: boolean;
    onIgnore: (finding: ExposureFinding, reason: string) => void;
    onRestore: (finding: ExposureFinding) => void;
    onClose: () => void;
}

const REFERENCE_TITLE: Record<FindingKind, string> = {
    vuln: 'Ouvrir l’avis publié',
    eol: 'Voir sur endoflife.date',
    deprecated: 'Voir sur deps.dev',
    outdated: 'Voir sur deps.dev'
};

function titleOf(f: ExposureFinding): string {
    if (f.kind === 'vuln') return f.advisoryId ?? f.subject.name;
    if (f.kind === 'eol') return eolName(f);
    return f.subject.name;
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
                <h3 className={styles.detailTitle}>{titleOf(finding)}</h3>
                {reference && (
                    <a
                        className={styles.iconBtn}
                        href={reference}
                        target='_blank'
                        rel='noreferrer'
                        title={REFERENCE_TITLE[finding.kind]}
                        aria-label={REFERENCE_TITLE[finding.kind]}
                    >
                        <span className='icon icon-move-to-right' />
                    </a>
                )}
            </header>

            <div className={styles.detailMeta}>
                <KindBadge finding={finding} />
                {finding.state === 'ignored' && <StatusBadge tone='neutral'>Ignoré</StatusBadge>}
                {finding.state === 'resolved' && <StatusBadge tone='success'>Résolu</StatusBadge>}
                <span className={styles.detailDate}>Vu pour la première fois le {fullDate(finding.firstSeen)}</span>
            </div>

            {finding.kind === 'vuln' && <VulnBody finding={finding} />}
            {finding.kind === 'eol' && <EolBody finding={finding} />}
            {finding.kind === 'deprecated' && <PackageBody finding={finding} quote />}
            {finding.kind === 'outdated' && <PackageBody finding={finding} quote={false} />}

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

function KindBadge({ finding: f }: { finding: ExposureFinding }) {
    if (f.kind === 'vuln') {
        return (
            <StatusBadge tone={severityTone(f.severity)}>
                {f.score === null ? SEVERITY_LABEL[f.severity] : `${SEVERITY_LABEL[f.severity]} ${f.score.toFixed(1)}`}
            </StatusBadge>
        );
    }
    if (f.kind === 'eol') {
        const badge = eolBadge(f);
        return <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>;
    }
    if (f.kind === 'deprecated') return <StatusBadge tone='warning'>Dépréciée par son auteur</StatusBadge>;
    return f.behind === null ? null : <StatusBadge tone='neutral'>{behindLine(f.behind)}</StatusBadge>;
}

function Resolved({ finding }: { finding: ExposureFinding }) {
    if (finding.resolvedAt === null) return null;
    return (
        <>
            <dt>Résolu</dt>
            <dd>{since(finding.resolvedAt)}</dd>
        </>
    );
}

function VulnBody({ finding }: { finding: ExposureFinding }) {
    return (
        <>
            <p className={styles.detailSummary}>{finding.summary}</p>
            <dl className={styles.detailFacts}>
                <dt>Touche</dt>
                <dd>
                    {finding.subject.name}
                    {finding.subject.kind === 'package' && ` (${finding.subject.ecosystem})`}
                </dd>
                <dt>Corrigé en</dt>
                <dd>{finding.fixed.length > 0 ? finding.fixed.join(', ') : 'aucune version corrigée publiée'}</dd>
                {finding.aliases.length > 0 && (
                    <>
                        <dt>Aussi publié sous</dt>
                        <dd>{finding.aliases.join(', ')}</dd>
                    </>
                )}
                <Resolved finding={finding} />
            </dl>
        </>
    );
}

/** Une fin de vie : la phrase de la veille, puis les branches du logiciel, la sienne surlignée. */
function EolBody({ finding }: { finding: ExposureFinding }) {
    const product = finding.eol?.product ?? null;
    const [software, setSoftware] = useState<Software | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (product === null) return;
        let cancelled = false;
        setSoftware(null);
        setFailed(false);
        void (async () => {
            try {
                const res = await api.send('cve.software', { name: product });
                if (!cancelled) setSoftware(res.software);
            } catch {
                // Le tableau est un plus : sans lui, la fiche garde les branches maintenues.
                if (!cancelled) setFailed(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [product]);

    return (
        <>
            <p className={styles.detailSummary}>{finding.summary}</p>
            {software && finding.eol ? (
                <section className={styles.detailSection}>
                    <h4 className={styles.detailSectionTitle}>Versions de {software.label}</h4>
                    <SoftwareTable software={software} highlight={[finding.eol.release]} />
                </section>
            ) : product !== null && !failed ? (
                <p className={styles.detailMore}>Chargement des versions…</p>
            ) : (
                <dl className={styles.detailFacts}>
                    <dt>Branches maintenues</dt>
                    <dd>{finding.fixed.length > 0 ? finding.fixed.join(', ') : 'aucune'}</dd>
                </dl>
            )}
            {finding.resolvedAt !== null && (
                <dl className={styles.detailFacts}>
                    <Resolved finding={finding} />
                </dl>
            )}
        </>
    );
}

/** Un paquet déprécié ou en retard : sa version, la dernière publiée, et le mot de l'auteur quand il y en a un. */
function PackageBody({ finding, quote }: { finding: ExposureFinding; quote: boolean }) {
    return (
        <>
            {quote && <blockquote className={styles.authorNote}>{finding.summary}</blockquote>}
            <dl className={styles.detailFacts}>
                <dt>Registre</dt>
                <dd>{finding.subject.ecosystem}</dd>
                <dt>Version utilisée</dt>
                <dd>{versionsOf(finding)}</dd>
                <dt>Dernière version</dt>
                <dd>{finding.fixed[0] ?? 'inconnue'}</dd>
                <Resolved finding={finding} />
            </dl>
        </>
    );
}
