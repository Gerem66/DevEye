import {
    Button,
    CopyButton,
    CountBadge,
    Dialog,
    DialogCancelButton,
    humanizeError,
    invalidate,
    settingsStyles as shell,
    StatusBadge,
    TextArea,
    useResource,
    useSubView
} from 'deveye-sdk-client';
import { useState } from 'react';

import { SHORTLINK_REPORT_REASON_LABELS, type ShortlinkReport } from '../contracts/domain';
import { api } from './api';
import { momentLabel } from './format';
import styles from './style.module.css';

type Decision = { report: ShortlinkReport; kind: 'block' | 'dismiss' } | null;

interface CardActions {
    onDecide(report: ShortlinkReport, kind: 'block' | 'dismiss'): void;
    onRestore(report: ShortlinkReport): void;
}

const NOTE_MAX = 1000;
const READ_FAILED = 'Les signalements n’ont pas pu être lus.';

/**
 * Les signalements des liens courts, l'onglet de modération. Bloquer un lien le
 * coupe pour tout le monde sans rien supprimer, et prévient son auteur avec la
 * note ; classer sans suite ne prévient personne. Les adresses signalées
 * s'affichent sans lien cliquable : les suivre mènerait là où le signalement
 * dit qu'il ne faut pas aller.
 */
export default function Reports() {
    const [decision, setDecision] = useState<Decision>(null);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showClosed, setShowClosed] = useState(false);
    useSubView('signalements');

    const pending = useResource(
        'shortlinks.reports',
        () => api.send('shortlinks.reports', { status: 'open' }),
        READ_FAILED
    );

    const actions: CardActions = {
        onDecide(report, kind) {
            setNote('');
            setError(null);
            setDecision({ report, kind });
        },
        onRestore(report) {
            setError(null);
            void api
                .send('shortlinks.restore', { reportId: report.id })
                .then(() => invalidate('shortlinks.reports'))
                .catch((failure: unknown) =>
                    setError(humanizeError(failure, 'Le lien n’a pas pu être remis en service.'))
                );
        }
    };

    const decide = async (): Promise<void> => {
        if (decision === null || busy) return;
        setBusy(true);
        setError(null);
        try {
            await api.send('shortlinks.reportDecide', {
                reportId: decision.report.id,
                decision: decision.kind,
                note: note.trim()
            });
            setDecision(null);
            invalidate('shortlinks.reports');
        } catch (failure) {
            setError(humanizeError(failure, 'La décision n’a pas pu être enregistrée.'));
        } finally {
            setBusy(false);
        }
    };

    const blocking = decision?.kind === 'block';

    return (
        <div className={styles.reportsTab}>
            {error !== null && decision === null && <p className={styles.error}>{error}</p>}

            <section className={styles.section}>
                <div className={styles.sectionHead}>
                    <h3 className={styles.sectionTitle}>
                        À traiter
                        {pending.data !== null && pending.data.open > 0 && (
                            <CountBadge count={pending.data.open} tone='neutral' />
                        )}
                    </h3>
                </div>
                <ReportList
                    reports={pending.data?.reports ?? null}
                    error={pending.error}
                    empty='Aucun signalement à traiter.'
                    actions={actions}
                />
            </section>

            <details
                className={styles.foldedSection}
                open={showClosed}
                onToggle={(event) => setShowClosed(event.currentTarget.open)}
            >
                <summary className={styles.foldedTitle}>
                    <span className={`icon icon-chevron-down ${styles.foldedChevron}`} aria-hidden='true' />
                    Traités
                </summary>
                {showClosed && <ClosedReports actions={actions} />}
            </details>

            <Dialog
                open={decision !== null}
                onClose={() => setDecision(null)}
                title={blocking ? 'Bloquer le lien' : 'Classer sans suite'}
                description={
                    blocking
                        ? 'Toutes ses adresses cessent de rediriger. Rien n’est supprimé, et le compte n’est pas touché. L’auteur du lien reçoit un e-mail avec la note ci-dessous.'
                        : 'Le signalement est clos sans rien changer au lien. Personne n’est prévenu.'
                }
                onSubmit={() => void decide()}
                footer={
                    <>
                        <DialogCancelButton variant='ghost'>Annuler</DialogCancelButton>
                        <Button variant={blocking ? 'danger' : 'primary'} disabled={busy} onClick={() => void decide()}>
                            {blocking ? 'Bloquer le lien' : 'Classer sans suite'}
                        </Button>
                    </>
                }
            >
                <div className={shell.field}>
                    <label className={shell.fieldLabel} htmlFor='shortlinks-decision-note'>
                        {blocking ? 'Note, lue par l’auteur du lien' : 'Note (facultative)'}
                    </label>
                    <TextArea
                        id='shortlinks-decision-note'
                        value={note}
                        maxLength={NOTE_MAX}
                        autoGrow
                        data-autofocus=''
                        onChange={(event) => setNote(event.target.value)}
                    />
                    {blocking && (
                        <span className={shell.fieldHint}>
                            Une décision se motive : dites ce qui enfreint la loi ou les conditions du service.
                        </span>
                    )}
                </div>
                {error !== null && <p className={styles.error}>{error}</p>}
            </Dialog>
        </div>
    );
}

/** Lus à l'ouverture de la section seulement : on vient rarement les relire. */
function ClosedReports({ actions }: { actions: CardActions }) {
    const closed = useResource(
        'shortlinks.reports',
        () => api.send('shortlinks.reports', { status: 'closed' }),
        READ_FAILED
    );
    return (
        <ReportList
            reports={closed.data?.reports ?? null}
            error={closed.error}
            empty='Aucun signalement traité pour l’instant.'
            actions={actions}
        />
    );
}

function ReportList({
    reports,
    error,
    empty,
    actions
}: {
    reports: readonly ShortlinkReport[] | null;
    error: string | null;
    empty: string;
    actions: CardActions;
}) {
    if (error !== null) return <p className={styles.error}>{error}</p>;
    if (reports === null) return <p className={styles.reportsNote}>Chargement…</p>;
    if (reports.length === 0) return <p className={shell.empty}>{empty}</p>;
    return (
        <ul className={styles.reports}>
            {reports.map((report) => (
                <ReportCard key={report.id} report={report} actions={actions} />
            ))}
        </ul>
    );
}

function ReportCard({ report, actions }: { report: ShortlinkReport; actions: CardActions }) {
    return (
        <li className={styles.report}>
            <div className={styles.reportHead}>
                <span className={styles.reportTitle}>
                    {report.linkTitle || 'Lien sans titre'}
                    <StatusBadge tone='warning' dot={false}>
                        {SHORTLINK_REPORT_REASON_LABELS[report.reason]}
                    </StatusBadge>
                    {report.linkBlocked && <StatusBadge tone='danger'>Retiré</StatusBadge>}
                    {report.linkId === null && <StatusBadge tone='neutral'>Lien supprimé</StatusBadge>}
                </span>
                <span className={styles.reportMeta}>
                    {report.ref} · {momentLabel(report.created)}
                </span>
            </div>
            <dl className={styles.facts}>
                <div className={styles.fact}>
                    <dt>Adresse signalée</dt>
                    <dd className={styles.reportUrl}>
                        <span className={styles.factUrl}>{report.url}</span>
                        <CopyButton value={report.url} label='Copier l’adresse signalée' />
                    </dd>
                </div>
                <div className={styles.fact}>
                    <dt>Menait vers</dt>
                    <dd className={styles.reportUrl}>
                        <span className={styles.factUrl}>{report.target}</span>
                        <CopyButton value={report.target} label='Copier la destination' />
                    </dd>
                </div>
            </dl>
            {report.message.length > 0 && <p className={styles.reportMessage}>{report.message}</p>}
            <p className={styles.reportMeta}>
                Par {report.reporterName || 'une personne anonyme'}
                {report.reporterEmail ? ` (${report.reporterEmail})` : ''}
                {report.ip !== null ? `, depuis ${report.ip || 'une adresse inconnue'}` : ''}
            </p>
            {report.status !== 'open' && (
                <p className={styles.reportMeta}>
                    {report.status === 'actioned' ? 'Lien bloqué' : 'Classé sans suite'}
                    {report.closedAt !== null ? ` le ${momentLabel(report.closedAt)}` : ''}
                    {report.decision.length > 0 ? ` : ${report.decision}` : ''}
                </p>
            )}
            <div className={styles.inlineActions}>
                {report.status === 'open' && (
                    <>
                        {report.linkId !== null && !report.linkBlocked && (
                            <Button variant='danger' onClick={() => actions.onDecide(report, 'block')}>
                                Bloquer le lien
                            </Button>
                        )}
                        <Button variant='secondary' onClick={() => actions.onDecide(report, 'dismiss')}>
                            Classer sans suite
                        </Button>
                    </>
                )}
                {report.linkBlocked && report.linkId !== null && (
                    <Button variant='ghost' onClick={() => actions.onRestore(report)}>
                        Remettre en service
                    </Button>
                )}
            </div>
        </li>
    );
}
