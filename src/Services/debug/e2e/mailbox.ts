import type { Logger } from 'pino';

import { logger } from '@/logger';
import type { MailMessage, Mailer } from '@/Services/mailer';
import { isTestEmail } from './identity';

interface Box {
    queue: MailMessage[];
    waiters: ((message: MailMessage) => void)[];
}

/**
 * La boîte des essais : tout mail vers le domaine réservé est retenu ici et
 * jamais remis au serveur SMTP, attendu ou non. Une adresse qu'un essai attend
 * reçoit ses mails dans l'ordre ; les autres sont jetés. C'est aussi ce qui
 * ferme ce domaine à un inconnu : le lien d'inscription ne lui arrive jamais.
 */
export function createMailbox(log: Pick<Logger, 'warn'>) {
    const boxes = new Map<string, Box>();
    const key = (address: string): string => address.trim().toLowerCase();

    return {
        /** L'expéditeur du serveur, derrière la boîte. `configured` reste le vrai : un essai ne change rien aux vraies inscriptions. */
        tap(inner: Mailer): Mailer {
            return {
                get configured() {
                    return inner.configured;
                },
                async send(message) {
                    if (!isTestEmail(message.to)) return inner.send(message);
                    const box = boxes.get(key(message.to));
                    if (!box) {
                        log.warn({ subject: message.subject }, 'Mail vers une adresse d’essai inattendue, jeté');
                        return;
                    }
                    const waiter = box.waiters.shift();
                    if (waiter) waiter(message);
                    else box.queue.push(message);
                },
                verify: () => inner.verify()
            };
        },

        expect(address: string): void {
            if (!boxes.has(key(address))) boxes.set(key(address), { queue: [], waiters: [] });
        },

        /** Le prochain mail reçu à cette adresse, ou un rejet passé le délai. */
        next(address: string, timeoutMs: number, signal?: AbortSignal): Promise<MailMessage> {
            const box = boxes.get(key(address));
            if (!box) return Promise.reject(new Error(`Aucun mail attendu à ${address}`));
            const queued = box.queue.shift();
            if (queued) return Promise.resolve(queued);
            return new Promise((resolve, reject) => {
                const done = (message: MailMessage): void => {
                    clearTimeout(timer);
                    signal?.removeEventListener('abort', onAbort);
                    resolve(message);
                };
                const fail = (reason: string): void => {
                    box.waiters = box.waiters.filter((w) => w !== done);
                    signal?.removeEventListener('abort', onAbort);
                    reject(new Error(reason));
                };
                const onAbort = (): void => {
                    clearTimeout(timer);
                    fail('Essai arrêté');
                };
                const timer = setTimeout(() => fail(`Aucun mail reçu en ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
                signal?.addEventListener('abort', onAbort, { once: true });
                box.waiters.push(done);
            });
        },

        forget(address: string): void {
            boxes.delete(key(address));
        }
    };
}

export type Mailbox = ReturnType<typeof createMailbox>;

export const mailbox = createMailbox(logger);
