import type { ReactNode } from 'react';

import Button from '@/Components/Button';
import { useFeedbackEnabled } from '@/stores/feedbackEnabled';
import { requestOpenReport } from '@/stores/reportRequest';

import styles from './ErrorNote.module.css';

/**
 * Les refus dont le texte se suffit : l'utilisateur a mal saisi, n'a pas le
 * droit, a atteint sa limite, doit se reconnecter, ou regarde une donnée
 * disparue. Les signaler n'apprendrait rien à personne. Une connexion coupée
 * (`closed`, `network`) revient seule, et le signalement ne partirait pas.
 */
const SPOKEN_FOR: readonly string[] = [
    'validation',
    'conflict',
    'forbidden',
    'not_found',
    'locked',
    'rate_limited',
    'quota_exceeded',
    'maintenance',
    'auth_invalid',
    'auth_expired',
    'auth_required',
    'stepup_required',
    'closed',
    'network'
];

export interface ErrorNoteInput {
    message: string;
    /** Le code du refus, `null` quand l'échec n'en porte pas. */
    code: string | null;
}

export interface ErrorNoteProps {
    note: ErrorNoteInput | null;
    /** Les gestes de réparation propres à l'appelant, quand il en offre. */
    children?: ReactNode;
    /** Rend le bandeau refermable : la croix vient en bout de rangée, après le signalement. */
    onDismiss?: () => void;
}

/**
 * Le bandeau d'un refus, et ce qu'on peut en faire. Les gestes de réparation
 * viennent de l'appelant, qui seul sait où se répare son erreur ; le
 * signalement vient d'ici, parce qu'une erreur que personne ne sait réparer
 * doit au moins pouvoir remonter.
 *
 * Le signalement ne s'offre pas sur un refus qui se suffit : inviter à signaler
 * une date mal saisie remplirait la boîte de l'administrateur de choses qu'il
 * ne peut pas corriger.
 */
export default function ErrorNote({ note, children, onDismiss }: ErrorNoteProps) {
    const feedback = useFeedbackEnabled();
    if (note === null) return null;

    const reportable = feedback && (note.code === null || !SPOKEN_FOR.includes(note.code));

    return (
        <div className={styles.note} role='alert'>
            <span className={styles.text}>{note.message}</span>
            {children}
            {reportable && (
                <Button
                    variant='secondary'
                    icon='bug'
                    title='Envoyer ce refus à l’administrateur de ce DevEye'
                    onClick={() => requestOpenReport(note.message)}
                >
                    Signaler
                </Button>
            )}
            {onDismiss && (
                <button type='button' className={styles.dismiss} onClick={onDismiss} title='Fermer' aria-label='Fermer'>
                    <span className='icon icon-x' />
                </button>
            )}
        </div>
    );
}
