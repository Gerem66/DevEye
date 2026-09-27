import type { SdkAccountMailMessage } from '@deveye/types/sdk/server';

import type { Mailer } from '@/Services/mailer';
import { renderAccountMail } from '@/Services/mailLayout';

let mailer: Mailer | null = null;

/**
 * L'expéditeur du serveur (`SMTP_*`) pour le code qui n'a pas de dépendance à
 * recevoir : la confirmation d'une suppression de compte, le testeur de mails.
 * Avant `init`, il n'est pas configuré.
 */
export const serverMail = {
    init(m: Mailer): void {
        mailer = m;
    },
    get configured(): boolean {
        return mailer?.configured ?? false;
    },
    async send(to: string, message: SdkAccountMailMessage): Promise<void> {
        if (!mailer?.configured) throw new Error('SMTP non configuré');
        await mailer.send({ to, ...renderAccountMail(message) });
    },
    async verify(): Promise<void> {
        if (!mailer?.configured) throw new Error('SMTP non configuré');
        await mailer.verify();
    }
};
