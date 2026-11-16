import { useEffect, useRef, useState } from 'react';
import {
    Button,
    Dialog,
    ErrorNote,
    errorNote,
    settingsStyles as shell,
    TextArea,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { APPSTORES_REPLY_MAX_LENGTH, type AppStore, type AppStoresReview } from '../contracts/domain';

import { api } from './api';
import { formatCount, STORE_LABELS } from './format';
import { Stars } from './Stats/StarBars';
import styles from './style.module.css';

/** Publier passe par le store, qui répond parfois lentement. */
const REPLY_TIMEOUT_MS = 30_000;

const PUBLISHING: Record<AppStore, string> = {
    apple: 'Apple relit chaque réponse avant de la publier : elle reste « en attente de publication » quelques heures, parfois plus.',
    google: 'Google la publie aussitôt.'
};

interface ReplyDialogProps {
    /** L'avis auquel on répond ; `null` ferme le dialogue. */
    review: AppStoresReview | null;
    onClose: () => void;
    onReplied: (review: AppStoresReview) => void;
}

/**
 * Répondre à un avis, ou remplacer sa réponse. La limite est celle du store
 * de l'avis, et le compteur la suit à la frappe : le store refuserait le
 * surplus, autant le voir avant d'envoyer.
 */
export function ReplyDialog({ review, onClose, onReplied }: ReplyDialogProps) {
    const [body, setBody] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    /** L'avis reste affiché le temps de l'animation de sortie. */
    const kept = useRef<AppStoresReview | null>(review);
    if (review) kept.current = review;
    const shown = review ?? kept.current;

    useEffect(() => {
        if (!review) return;
        setBody(review.reply?.body ?? '');
        setError(null);
    }, [review]);

    const max = shown ? APPSTORES_REPLY_MAX_LENGTH[shown.store] : 0;
    const length = body.trim().length;
    const over = length > max;
    const unchanged = shown?.reply?.body === body.trim();

    const submit = async () => {
        if (!review || busy || length === 0 || over || unchanged) return;
        setBusy(true);
        setError(null);
        try {
            const res = await api.send(
                'appstores.replyReview',
                { reviewId: review.id, body: body.trim() },
                { timeoutMs: REPLY_TIMEOUT_MS }
            );
            onReplied(res.review);
        } catch (e) {
            setError(errorNote(e, 'La réponse n’a pas pu être publiée.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={review !== null}
            onClose={onClose}
            title={shown?.reply ? 'Modifier la réponse' : 'Répondre à l’avis'}
            description='Votre réponse est publique : elle s’affiche sous l’avis, sur la fiche de l’app, au nom de votre compte développeur.'
            width={580}
            onSubmit={() => void submit()}
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={() => void submit()} disabled={busy || length === 0 || over || unchanged}>
                        {busy ? 'Publication…' : shown?.reply ? 'Remplacer la réponse' : 'Publier la réponse'}
                    </Button>
                </>
            }
        >
            {shown && (
                <div className={shell.section}>
                    <blockquote className={styles.replyQuote}>
                        <Stars rating={shown.rating} />
                        {shown.title && <p className={styles.reviewTitle}>{shown.title}</p>}
                        {shown.body && <p className={styles.reviewBody}>{shown.body}</p>}
                        <p className={styles.reviewAuthor}>
                            {shown.author} · {STORE_LABELS[shown.store]}
                        </p>
                    </blockquote>

                    <label className={shell.field}>
                        <span className={shell.sectionLabel}>Votre réponse</span>
                        <TextArea
                            data-autofocus
                            value={body}
                            rows={5}
                            autoGrow
                            disabled={busy}
                            onChange={(e) => setBody(e.target.value)}
                        />
                        <span className={styles.counter} data-over={over ? '' : undefined}>
                            {formatCount(length)} / {formatCount(max)} caractères
                        </span>
                    </label>

                    <p className={shell.fieldHint}>
                        {PUBLISHING[shown.store]}
                        {shown.reply && ' La modifier remplace la réponse en place.'}
                    </p>

                    <ErrorNote note={error} />
                </div>
            )}
        </Dialog>
    );
}

export default ReplyDialog;
