import {
    Button,
    CopyButton,
    Dialog,
    DialogCancelButton,
    humanizeError,
    SegmentedControl,
    settingsStyles as shell,
    StatusBadge,
    StickyHeader,
    TextArea,
    useResource,
    useSubView
} from 'deveye-sdk-client';
import type { AdminViewProps } from '@deveye/types/sdk/client';
import { useState } from 'react';

import { SHORTLINK_REPORT_REASON_LABELS, type ShortlinkReport } from '../contracts/domain';
import { api } from './api';
import { momentLabel } from './format';
import styles from './style.module.css';

type Tab = 'open' | 'closed';
type Decision = { report: ShortlinkReport; kind: 'block' | 'dismiss' } | null;

const NOTE_MAX = 1000;

/**
 * Les signalements des liens courts, pour l'administration du service. Bloquer
 * un lien le coupe pour tout le monde sans rien supprimer, et prévient son
 * auteur avec la note ; classer sans suite ne prévient personne. Les adresses
 * signalées s'affichent sans lien cliquable : les suivre mènerait là où le
 * signalement dit qu'il ne faut pas aller.
 */
export default function Reports(_props: AdminViewProps) {
    const [tab, setTab] = useState<Tab>('open');
    const [decision, setDecision] = useState<Decision>(null);
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    useSubView('signalements');

    const list = useResource(
        'shortlinks.reports',
        () => api.send('shortlinks.reports', { status: tab }),
        'Les signalements n’ont pas pu être lus.',
        [tab]
    );
    const reports = list.data?.reports ?? [];

    const open = (report: ShortlinkReport, kind: 'block' | 'dismiss') => {
        setNote('');
        setError(null);
        setDecision({ report, kind });
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
            list.reload();
        } catch (failure) {
            setError(humanizeError(failure, 'La décision n’a pas pu être enregistrée.'));
        } finally {
            setBusy(false);
        }
    };

    const restore = async (report: ShortlinkReport): Promise<void> => {
        setError(null);
        try {
            await api.send('shortlinks.restore', { reportId: report.id });
            list.reload();
        } catch (failure) {
            setError(humanizeError(failure, 'Le lien n’a pas pu être remis en service.'));
        }
    };

    const blocking = decision?.kind === 'block';

    return (
        <div className={styles.root}>
            <StickyHeader>
                <header className={styles.header}>
                    <div>
                        <h2 className={styles.heading}>Signalements des liens</h2>
                        <p className={styles.subheading}>
                            Ce que les visiteurs signalent sur les liens courts, tous comptes confondus.
                        </p>
                    </div>
                    <div className={styles.actions}>
                        <SegmentedControl<Tab>
                            value={tab}
                            aria-label='Signalements à afficher'
                            options={[
                                { value: 'open', label: `À traiter${list.data ? ` (${list.data.open})` : ''}` },
                                { value: 'closed', label: 'Traités' }
                            ]}
                            onChange={setTab}
                        />
                    </div>
                </header>
            </StickyHeader>

            {error !== null && decision === null && <p className={styles.error}>{error}</p>}
            {list.error !== null ? (
                <p className={styles.error}>{list.error}</p>
            ) : list.data === null ? (
                <p className={styles.empty}>Chargement…</p>
            ) : reports.length === 0 ? (
                <p className={styles.empty}>
                    {tab === 'open' ? 'Aucun signalement à traiter.' : 'Aucun signalement traité pour l’instant.'}
                </p>
            ) : (
                <ul className={styles.reports}>
                    {reports.map((report) => (
                        <li key={report.id} className={styles.report}>
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
                                {report.reporterEmail ? ` (${report.reporterEmail})` : ''}, depuis{' '}
                                {report.ip || 'une adresse inconnue'}
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
                                            <Button variant='danger' onClick={() => open(report, 'block')}>
                                                Bloquer le lien
                                            </Button>
                                        )}
                                        <Button variant='secondary' onClick={() => open(report, 'dismiss')}>
                                            Classer sans suite
                                        </Button>
                                    </>
                                )}
                                {report.linkBlocked && report.linkId !== null && (
                                    <Button variant='ghost' onClick={() => void restore(report)}>
                                        Remettre en service
                                    </Button>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}

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
