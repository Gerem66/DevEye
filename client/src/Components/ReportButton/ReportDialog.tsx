import { useEffect, useMemo, useState } from 'react';
import { FEEDBACK_MESSAGE_MAX, type FeedbackKind, type FeedbackSnapshot } from '@deveye/types';

import { ws } from '@/api/ws';
import { humanizeError } from '@/api/useResource';
import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import SegmentedControl from '@/Components/SegmentedControl';
import { buildSnapshot, snapshotBytes } from '@/diagnostics/snapshot';
import { formatBytesFr } from '@/format';

import styles from './ReportButton.module.css';

const KINDS: readonly { value: FeedbackKind; label: string; title: string }[] = [
    { value: 'general', label: 'Retour', title: 'Une idée, une suggestion, une question' },
    { value: 'bug', label: 'Bug', title: 'Quelque chose ne marche pas comme prévu' }
];

const PLACEHOLDERS: Record<FeedbackKind, string> = {
    general: 'Une idée, une suggestion, une question…',
    bug: 'Ce que vous faisiez, ce que vous attendiez, ce qui s’est passé…'
};

/** L'issue de l'envoi, portée par la confirmation empilée. */
type Outcome = { ok: true } | { ok: false; reason: string };

export interface ReportDialogProps {
    open: boolean;
    onClose: () => void;
    /** Ce qui a échoué, quand le formulaire est ouvert depuis un refus. */
    context?: string | null;
}

export function ReportDialog({ open, onClose, context = null }: ReportDialogProps) {
    const [kind, setKind] = useState<FeedbackKind>('general');
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [outcome, setOutcome] = useState<Outcome | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);
    const [snapshot, setSnapshot] = useState<FeedbackSnapshot | null>(null);

    // Le rapport est figé à l'ouverture, pas à l'envoi : il doit décrire
    // l'instant où le problème a été rencontré, et non celui où l'utilisateur
    // a fini d'écrire, plusieurs minutes de trafic de fond plus tard.
    useEffect(() => {
        if (!open) return;
        setSnapshot(buildSnapshot());
        setDetailOpen(false);
        // Ouvert depuis un refus : le message est amorcé par ce qui a échoué, et
        // le rapport technique suit, faute de quoi le signalement arriverait
        // sans rien de ce que l'utilisateur venait de voir.
        if (context !== null) {
            setKind('bug');
            setMessage(`Erreur rencontrée : « ${context} »\n\n`);
        }
    }, [open, context]);

    const detail = useMemo(() => (snapshot ? JSON.stringify(snapshot, null, 2) : ''), [snapshot]);
    const weight = useMemo(() => (snapshot ? formatBytesFr(snapshotBytes(snapshot)) : ''), [snapshot]);

    /** Referme tout et repart d'une page blanche : l'envoi est passé. */
    const finish = (): void => {
        setOutcome(null);
        setMessage('');
        setKind('general');
        onClose();
    };

    const send = (): void => {
        if (busy || !message.trim()) return;
        setBusy(true);
        void ws
            .send('feedback.submit', {
                kind,
                message: message.trim(),
                snapshot: kind === 'bug' ? snapshot : null
            })
            .then(
                () => setOutcome({ ok: true }),
                (e: unknown) =>
                    setOutcome({ ok: false, reason: humanizeError(e, 'Le signalement n’a pas pu être envoyé.') })
            )
            .finally(() => setBusy(false));
    };

    return (
        <>
            <Dialog
                open={open}
                onClose={onClose}
                title='Signalement'
                width={560}
                onSubmit={send}
                footer={
                    <>
                        <Button variant='secondary' onClick={onClose} disabled={busy}>
                            Annuler
                        </Button>
                        <Button onClick={send} disabled={busy || !message.trim()}>
                            {busy ? 'Envoi…' : 'Envoyer'}
                        </Button>
                    </>
                }
            >
                <SegmentedControl
                    options={KINDS}
                    value={kind}
                    onChange={setKind}
                    disabled={busy}
                    fullWidth
                    aria-label='Nature du signalement'
                />

                {/* Le champ grandit avec son texte par le CSS seul : `.grow`
                    superpose la saisie et une copie invisible du même texte,
                    et c'est la copie qui donne la hauteur. */}
                <div className={styles.grow} data-value={message}>
                    <textarea
                        className={styles.textarea}
                        value={message}
                        rows={4}
                        maxLength={FEEDBACK_MESSAGE_MAX}
                        placeholder={PLACEHOLDERS[kind]}
                        disabled={busy}
                        onChange={(e) => setMessage(e.target.value)}
                        data-autofocus
                    />
                </div>

                <p className={styles.notice}>
                    {kind === 'bug' ? (
                        <>
                            Un rapport technique de {weight} accompagne ce signalement : votre navigateur et sa version,
                            la taille de la fenêtre, les vues que vous avez ouvertes, les dernières requêtes (leur
                            adresse et leur issue, jamais leur contenu) et les erreurs récentes.
                        </>
                    ) : (
                        <>Seuls votre message, votre compte et la version de DevEye sont envoyés.</>
                    )}{' '}
                    {kind === 'bug' && (
                        <button type='button' className={styles.detailToggle} onClick={() => setDetailOpen((v) => !v)}>
                            {detailOpen ? 'Masquer le détail' : 'Voir le détail'}
                        </button>
                    )}
                </p>

                {kind === 'bug' && detailOpen && <pre className={styles.detail}>{detail}</pre>}
            </Dialog>

            {/* La confirmation, empilée par-dessus : elle possède la couche du
                dessus, donc Échap la ferme en premier. La refermer après un
                succès referme le formulaire avec elle, l'envoi étant passé ;
                après un échec elle ne ferme qu'elle, et le texte reste. */}
            <Dialog
                open={outcome !== null}
                onClose={() => (outcome?.ok ? finish() : setOutcome(null))}
                title={outcome?.ok ? 'Signalement envoyé' : 'Envoi impossible'}
                width={420}
                footer={<Button onClick={() => (outcome?.ok ? finish() : setOutcome(null))}>Fermer</Button>}
            >
                <p>
                    {outcome?.ok ? (
                        <p>
                            Merci, c’est bien reçu !
                            <br />
                            Chaque retour sert à corriger et à améliorer DevEye.
                            <br />
                            <br />
                            GLOIRE À ZAP
                        </p>
                    ) : (
                        outcome?.reason
                    )}
                </p>
            </Dialog>
        </>
    );
}

export default ReportDialog;
