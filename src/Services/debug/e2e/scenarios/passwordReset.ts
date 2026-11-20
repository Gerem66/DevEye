import { randomBytes } from 'node:crypto';

import { maintenance } from '@/Services/maintenance';
import { passwordResetMail } from '@/Services/passwordReset/mails';
import type { TestSession } from '../accounts';
import { check, expectRefusal, type E2eContext, type E2eScenario } from '../scenario';

const RESET_SUBJECT = passwordResetMail('', '', false).subject;
const RESET_LINK = /\/reset-password#([\w-]+)/;

type LoginReply = { status: string; step?: string };
type Verified = { username: string; recoveryRequired: boolean };
type Completed = { username: string; recoveryCode: string | null };

const newPassword = (): string => randomBytes(24).toString('base64url');

/** Demande un lien et rend son jeton, lu dans le mail de la boîte d'essai. */
async function mailedToken(ctx: E2eContext, account: TestSession): Promise<{ token: string; text: string }> {
    await account.client.api('/api/auth/password-reset', { email: account.email });
    const mail = await ctx.deps.mailbox.next(account.email, 15_000, ctx.signal);
    check(mail.subject === RESET_SUBJECT, `Sujet inattendu : ${mail.subject}`);
    const token = RESET_LINK.exec(mail.text)?.[1];
    check(token, 'Aucun lien de réinitialisation dans le mail');
    return { token, text: mail.text };
}

async function logIn(account: TestSession, password: string): Promise<LoginReply> {
    account.client.close();
    return account.client.api<LoginReply>('/api/auth/login', { username: account.username, password });
}

/**
 * « Mot de passe oublié » : le lien par mail, le nouveau mot de passe, puis le
 * même geste sur un compte chiffré, qui exige son code de récupération et
 * garde ses données.
 */
export const passwordReset: E2eScenario = {
    id: 'core.passwordReset',
    label: 'Mot de passe oublié',
    sourceLabel: 'DevEye',
    accounts: 1,
    skip: (deps) => {
        if (maintenance.siteDown()) return 'Le site est en maintenance';
        if (!deps.mailer.configured) return 'Aucun serveur SMTP : le lien par mail ne peut pas être éprouvé';
        return null;
    },
    steps: [
        {
            label: 'Recevoir le lien',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                ctx.deps.mailbox.expect(account.email);
                ctx.ledger.defer('Oublier la boîte d’essai', async () => ctx.deps.mailbox.forget(account.email));
                const { token } = await mailedToken(ctx, account);
                const who = await account.client.api<Verified>('/api/auth/password-reset/verify', { token });
                check(who.username === account.username, 'Le lien ne désigne pas le bon compte');
                check(!who.recoveryRequired, 'Un compte non chiffré se voit demander un code');
                ctx.state.set('token', token);
            }
        },
        {
            label: 'Choisir le nouveau mot de passe, une seule fois',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                const token = ctx.state.get('token') as string;
                const password = newPassword();
                const done = await account.client.api<Completed>('/api/auth/password-reset/complete', {
                    token,
                    password
                });
                check(done.recoveryCode === null, 'Un code de récupération est revenu sans chiffrement');
                await expectRefusal(
                    account.client.api('/api/auth/password-reset/complete', { token, password: newPassword() }),
                    'not_found'
                );
                ctx.state.set('old', account.password);
                account.password = password;
            }
        },
        {
            label: 'L’ancien mot de passe est refusé, le nouveau ouvre la session',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                await expectRefusal(logIn(account, ctx.state.get('old') as string), 'auth_invalid');
                const login = await logIn(account, account.password);
                check(login.status === 'signedIn', 'Le nouveau mot de passe n’a pas ouvert la session');
                await account.client.connect();
            }
        },
        {
            label: 'Chiffrer le compte : le lien demande le code de récupération',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                const { recoveryCode } = await account.client.send<{ recoveryCode?: string }>('secrecy.enable', {
                    password: account.password,
                    recovery: true
                });
                check(recoveryCode, 'Le chiffrement n’a pas remis de code de récupération');
                ctx.state.set('recoveryCode', recoveryCode);

                const { token, text } = await mailedToken(ctx, account);
                check(text.includes('code de récupération'), 'Le mail ne prévient pas que le code sera demandé');
                const who = await account.client.api<Verified>('/api/auth/password-reset/verify', { token });
                check(who.recoveryRequired, 'Le lien d’un compte chiffré ne demande pas le code');
                await expectRefusal(
                    account.client.api('/api/auth/password-reset/complete', { token, password: newPassword() }),
                    'validation'
                );
                await expectRefusal(
                    account.client.api('/api/auth/password-reset/complete', {
                        token,
                        password: newPassword(),
                        recoveryCode: 'AAAA-AAAA-AAAA-AAAA'
                    }),
                    'auth_invalid'
                );
                ctx.state.set('token', token);
            }
        },
        {
            label: 'Le bon code garde les données et en remet un nouveau',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                const previous = ctx.state.get('recoveryCode') as string;
                const password = newPassword();
                const done = await account.client.api<Completed>('/api/auth/password-reset/complete', {
                    token: ctx.state.get('token') as string,
                    password,
                    recoveryCode: previous
                });
                check(done.recoveryCode && done.recoveryCode !== previous, 'Le code de récupération n’a pas changé');
                ctx.state.set('recoveryCode', done.recoveryCode);
                account.password = password;

                const login = await logIn(account, password);
                check(login.status === 'signedIn', 'Le nouveau mot de passe n’a pas ouvert la session');
                await account.client.connect();
                const { status } = await account.client.send<{ status: { enabled: boolean; unlocked: boolean } }>(
                    'secrecy.unlock',
                    { password }
                );
                check(status.enabled && status.unlocked, 'Le nouveau mot de passe n’ouvre pas les données chiffrées');
            }
        },
        {
            label: 'Un code refait depuis la session remplace l’ancien',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                const previous = ctx.state.get('recoveryCode') as string;
                const { recoveryCode } = await account.client.send<{ recoveryCode: string }>(
                    'secrecy.regenerateRecovery',
                    { password: account.password }
                );
                check(recoveryCode !== previous, 'Le code refait est identique à l’ancien');

                const { token } = await mailedToken(ctx, account);
                const password = newPassword();
                await expectRefusal(
                    account.client.api('/api/auth/password-reset/complete', {
                        token,
                        password,
                        recoveryCode: previous
                    }),
                    'auth_invalid'
                );
                await account.client.api('/api/auth/password-reset/complete', { token, password, recoveryCode });
                account.password = password;
                const login = await logIn(account, password);
                check(login.status === 'signedIn', 'Le nouveau mot de passe n’a pas ouvert la session');
                await account.client.connect();
            }
        }
    ]
};
