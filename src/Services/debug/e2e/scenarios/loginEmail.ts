import { loginCodeMail } from '@/Services/accountMails';
import { maintenance } from '@/Services/maintenance';
import type { TestSession } from '../accounts';
import { check, expectRefusal, type E2eContext, type E2eScenario } from '../scenario';

const CODE_SUBJECT = loginCodeMail({ username: '', code: '', browser: '', ip: '', at: 0 }).subject;
const CODE = /Votre code : (\d{6})/;

type LoginReply = { status: string; step?: string };

async function logIn(account: TestSession): Promise<LoginReply> {
    account.client.close();
    await account.client.api('/api/auth/logout', {});
    return account.client.api<LoginReply>('/api/auth/login', {
        username: account.username,
        password: account.password
    });
}

/** Le code du dernier mail de connexion de la boîte d'essai. */
async function mailedCode(ctx: E2eContext, account: TestSession): Promise<string> {
    const mail = await ctx.deps.mailbox.next(account.email, 15_000, ctx.signal);
    check(mail.subject === CODE_SUBJECT, `Sujet inattendu : ${mail.subject}`);
    const code = CODE.exec(mail.text)?.[1];
    check(code, 'Aucun code dans le mail');
    return code;
}

/**
 * Un navigateur inconnu confirme sa connexion par un code envoyé par mail ; un
 * navigateur de confiance passe sans, jusqu'à ce que le compte l'oublie.
 */
export const loginEmail: E2eScenario = {
    id: 'core.loginEmail',
    label: 'Code par mail aux nouveaux navigateurs',
    sourceLabel: 'DevEye',
    accounts: 1,
    skip: (deps) => {
        if (maintenance.siteDown()) return 'Le site est en maintenance';
        if (!deps.mailer.configured) return 'Aucun serveur SMTP : le code par mail ne peut pas être éprouvé';
        return null;
    },
    steps: [
        {
            label: 'L’activer',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                ctx.deps.mailbox.expect(account.email);
                ctx.ledger.defer('Oublier la boîte d’essai', async () => ctx.deps.mailbox.forget(account.email));
                const { status } = await account.client.send<{ status: { email: { enabled: boolean } } }>(
                    'loginChecks.setEmail',
                    { enabled: true }
                );
                check(status.email.enabled, 'Le code par mail ne s’est pas activé');
            }
        },
        {
            label: 'Se reconnecter : un code part par mail',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                const login = await logIn(account);
                check(login.status === 'pending' && login.step === 'email', 'La connexion n’a pas demandé de code');
                ctx.state.set('code', await mailedCode(ctx, account));
            }
        },
        {
            label: 'Un code faux est refusé',
            run: async (ctx) => {
                const code = ctx.state.get('code') as string;
                const wrong = code === '000000' ? '111111' : '000000';
                await expectRefusal(
                    ctx.accounts[0].client.api('/api/auth/login/verify', { code: wrong }),
                    'auth_invalid'
                );
            }
        },
        {
            label: 'Le bon code, et la confiance accordée',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                const done = await account.client.api<LoginReply>('/api/auth/login/verify', {
                    code: ctx.state.get('code') as string,
                    trust: true
                });
                check(done.status === 'signedIn', 'Le bon code n’a pas ouvert la session');
                await account.client.connect();
            }
        },
        {
            label: 'Ce navigateur passe désormais sans code',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                const login = await logIn(account);
                check(login.status === 'signedIn', 'Le navigateur de confiance a encore dû donner un code');
                await account.client.connect();
            }
        },
        {
            label: 'Oublié, il redemande un code',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                await account.client.send('loginChecks.forgetBrowsers', {});
                const login = await logIn(account);
                check(login.status === 'pending' && login.step === 'email', 'Le navigateur oublié est passé sans code');
                const done = await account.client.api<LoginReply>('/api/auth/login/verify', {
                    code: await mailedCode(ctx, account)
                });
                check(done.status === 'signedIn', 'Le code n’a pas ouvert la session');
                await account.client.connect();
            }
        },
        {
            label: 'L’historique garde chaque connexion',
            run: async (ctx) => {
                const [account] = ctx.accounts;
                const { entries } = await account.client.send<{
                    entries: { steps: string[]; trusted: boolean; current: boolean }[];
                }>('loginChecks.history', {});
                check(entries.length >= 3, `L’historique ne compte que ${entries.length} connexion(s)`);
                const [last, trusted] = entries;
                check(
                    last.current && last.steps.includes('email'),
                    'La dernière connexion n’est pas celle-ci, par code'
                );
                check(trusted.trusted && trusted.steps.length === 0, 'La connexion de confiance n’est pas marquée');
            }
        }
    ]
};
