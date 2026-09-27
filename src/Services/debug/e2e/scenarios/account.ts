import { accountDeletedMail } from '@/Services/accountMails';
import { maintenance } from '@/Services/maintenance';
import { verificationMail } from '@/Services/signup/mails';
import type { TestClient } from '../client';
import { e2eRunOf, type TestIdentity } from '../identity';
import { check, type E2eContext, type E2eScenario } from '../scenario';

const VERIFY_LINK = /\/signup\/verify#([\w-]+)/;
const DELETED_SUBJECT = accountDeletedMail({ username: '', by: 'self', at: 0, notes: [], site: null }).subject;

const identityOf = (ctx: E2eContext): TestIdentity => ctx.state.get('identity') as TestIdentity;
const clientOf = (ctx: E2eContext): TestClient => ctx.state.get('client') as TestClient;

/** Le parcours d'une personne, de la demande d'inscription à la suppression de son compte, mails compris. */
export const accountLifecycle: E2eScenario = {
    id: 'core.account',
    label: 'Cycle de vie d’un compte',
    sourceLabel: 'DevEye',
    accounts: 0,
    skip: async (deps) => {
        if (maintenance.siteDown()) return 'Le site est en maintenance';
        if (!(await deps.signupOpen())) return 'Les inscriptions sont fermées sur ce serveur';
        if (!deps.mailer.configured) return 'Aucun serveur SMTP : la validation par mail ne peut pas être éprouvée';
        return null;
    },
    steps: [
        {
            label: 'Demander l’inscription',
            run: async (ctx) => {
                const identity = ctx.newIdentity();
                const client = ctx.newClient();
                ctx.state.set('identity', identity);
                ctx.state.set('client', client);
                ctx.deps.mailbox.expect(identity.email);
                ctx.ledger.defer('Oublier la boîte d’essai', async () => ctx.deps.mailbox.forget(identity.email));
                // Le compte n'existe qu'au milieu du parcours, et il se supprime
                // lui-même à la fin : on le cherche au moment du ménage, et ses
                // journaux partent avec lui dans les deux cas.
                ctx.ledger.defer('Supprimer le compte s’il existe encore', async () => {
                    const row = await ctx.deps.db.users.findByEmail(identity.email);
                    if (row) await ctx.removeAccount({ userId: row.id, email: row.email });
                    await ctx.deps.db.debug.purgeSignupsLike(identity.email);
                    const userId = ctx.state.get('userId');
                    if (typeof userId === 'number') await ctx.deps.db.debug.purgeLogsOf([userId]);
                });
                await client.api('/api/auth/signup', {
                    username: identity.username,
                    email: identity.email,
                    termsAccepted: true
                });
                return identity.email;
            }
        },
        {
            label: 'Recevoir le mail de validation',
            run: async (ctx) => {
                const mail = await ctx.deps.mailbox.next(identityOf(ctx).email, 15_000, ctx.signal);
                check(mail.subject === verificationMail('', '').subject, `Sujet inattendu : ${mail.subject}`);
                const token = VERIFY_LINK.exec(mail.text)?.[1];
                check(token, 'Aucun lien de validation dans le mail');
                check(mail.html.includes(`#${token}`), 'Le lien manque à la version HTML');
                ctx.state.set('token', token);
                return `« ${mail.subject} »`;
            }
        },
        {
            label: 'Ouvrir le lien',
            run: async (ctx) => {
                const opened = await clientOf(ctx).api<{ email: string }>('/api/auth/signup/verify', {
                    token: ctx.state.get('token')
                });
                check(opened.email === identityOf(ctx).email, 'Le lien désigne une autre adresse');
            }
        },
        {
            label: 'Choisir le mot de passe',
            run: async (ctx) => {
                const identity = identityOf(ctx);
                const bundle = await clientOf(ctx).api<{ user: { id: number } }>('/api/auth/signup/complete', {
                    token: ctx.state.get('token'),
                    password: identity.password
                });
                ctx.state.set('userId', bundle.user.id);
                const row = await ctx.deps.db.users.findById(bundle.user.id);
                check(row?.e2e_run === e2eRunOf(identity.email), 'Le compte n’est pas marqué comme compte d’essai');
                return `Compte ${bundle.user.id} créé`;
            }
        },
        {
            label: 'Se déconnecter puis se reconnecter',
            run: async (ctx) => {
                const client = clientOf(ctx);
                const identity = identityOf(ctx);
                await client.api('/api/auth/logout', {});
                check((await client.http('/api/auth/me')).status === 401, 'La session survit à la déconnexion');
                await client.api('/api/auth/login', { username: identity.username, password: identity.password });
                check((await client.http('/api/auth/me')).status === 200, 'La reconnexion n’ouvre pas de session');
            }
        },
        {
            label: 'Supprimer le compte',
            run: async (ctx) => {
                const client = clientOf(ctx);
                await client.connect();
                await client.send('user.deleteAccount', { password: identityOf(ctx).password });
            }
        },
        {
            label: 'Recevoir la confirmation de suppression',
            run: async (ctx) => {
                const mail = await ctx.deps.mailbox.next(identityOf(ctx).email, 10_000, ctx.signal);
                check(mail.subject === DELETED_SUBJECT, `Sujet inattendu : ${mail.subject}`);
                return `« ${mail.subject} »`;
            }
        },
        {
            label: 'Vérifier que tout a disparu',
            run: async (ctx) => {
                const userId = ctx.state.get('userId') as number;
                check(!(await ctx.deps.db.users.findByEmail(identityOf(ctx).email)), 'Le compte existe encore');
                check((await ctx.deps.db.workspaces.listOwnedIds(userId)).length === 0, 'Un espace a survécu');
                check((await clientOf(ctx).http('/api/auth/me')).status === 401, 'L’ancienne session répond encore');
            }
        }
    ]
};
