import { errorNote, type ErrorNoteInput } from 'deveye-sdk-client';

import { api } from './api';

/** Ce que la fenêtre de la banque a dit, en une phrase à montrer telle quelle. */
export class ConsentError extends Error {
    /** Le code du refus, pour le bandeau : `null` laisse le signalement s'offrir. */
    readonly code: string | null;

    constructor(message: string, code: string | null) {
        super(message);
        this.code = code;
    }
}

/** Le bandeau d'un échec où la banque a pu avoir son mot à dire. */
export function consentNote(e: unknown, fallback: string): ErrorNoteInput {
    return e instanceof ConsentError ? { message: e.message, code: e.code } : errorNote(e, fallback);
}

/** Ce que la fenêtre rapporte : le code à échanger, ou le refus de la banque. */
type Relay = { code: string; state: string } | { error: string };

/**
 * La fenêtre où l'on consent chez sa banque. Elle passe par la banque, qui
 * tient donc `window.opener` : seul un message venu de l'origine de DevEye ET
 * de cette fenêtre fait foi. Une fenêtre fermée avant la fin rend `null`.
 */
export function awaitBankWindow(popup: Window): Promise<Relay | null> {
    return new Promise((resolve) => {
        const finish = (relay: Relay | null) => {
            window.removeEventListener('message', onMessage);
            window.clearInterval(poll);
            resolve(relay);
        };
        function onMessage(e: MessageEvent) {
            if (e.origin !== window.location.origin || e.source !== popup) return;
            const data = e.data as
                { source?: string; code?: string; state?: string; error?: string | null } | undefined;
            if (data?.source !== 'deveye-finance-bank') return;
            finish(
                data.code && data.state
                    ? { code: data.code, state: data.state }
                    : { error: data.error ?? 'raison inconnue' }
            );
        }
        const poll = window.setInterval(() => {
            if (popup.closed) finish(null);
        }, 500);
        window.addEventListener('message', onMessage);
    });
}

/**
 * Ouvre la banque dans une fenêtre, attend son accord, et relie la banque ICI,
 * dans la session qui a lancé le consentement : la page de retour ne fait que
 * rapporter le code, `finance.bankFinish` fait le reste. Lève `ConsentError`
 * sur tout autre dénouement.
 */
export async function consentAtBank(authUrl: string): Promise<void> {
    const popup = window.open(authUrl, 'deveye-finance-bank', 'width=520,height=720');
    if (!popup)
        throw new ConsentError(
            'Fenêtre bloquée par le navigateur : autorisez les fenêtres de DevEye, puis recommencez.',
            'validation'
        );
    const relayed = await awaitBankWindow(popup);
    if (relayed === null) throw new ConsentError('La fenêtre de la banque s’est fermée avant la fin.', 'validation');
    if ('error' in relayed) throw new ConsentError(`La banque n’a pas été reliée : ${relayed.error}`, 'conflict');
    try {
        await api.send('finance.bankFinish', relayed);
    } catch (e) {
        const { code } = errorNote(e, '');
        throw new ConsentError(`La banque n’a pas été reliée : ${e instanceof Error ? e.message : String(e)}`, code);
    }
}
