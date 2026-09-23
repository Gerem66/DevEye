import { humanizeError } from 'deveye-sdk-client';

import { invoicingErrorDetailsSchema, type InvoicingSettingsSection } from '../contracts/domain';

/**
 * Un refus, tel que l'écran doit le montrer : la phrase, et l'endroit qui la
 * lève quand le serveur en désigne un.
 */
export interface ErrorNote {
    message: string;
    /** Le code du refus, `null` quand l'échec n'en porte pas : il décide si un
     *  signalement a du sens. */
    code: string | null;
    /** L'onglet de réglages de la feature qui porte la réponse. */
    section: InvoicingSettingsSection | null;
    /** Ou bien : la réponse est dans la fiche du client de ce document. */
    clientFiche: boolean;
}

/**
 * Le chemin de la réparation voyage dans les détails de l'erreur, jamais dans son
 * texte. Lu sans `instanceof` : un module et l'app peuvent résoudre deux classes
 * d'erreur distinctes, et seule la forme compte ici.
 */
export function errorNote(e: unknown, fallback: string): ErrorNote {
    const details = (e as { details?: unknown } | null)?.details;
    const parsed = invoicingErrorDetailsSchema.safeParse(details);
    const code = (e as { code?: unknown } | null)?.code;
    return {
        message: humanizeError(e, fallback),
        code: typeof code === 'string' ? code : null,
        section: parsed.success ? (parsed.data.settingsSection ?? null) : null,
        clientFiche: parsed.success && parsed.data.clientFiche === true
    };
}
