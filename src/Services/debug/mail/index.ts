import type { DebugMailPreview, DebugMailSample, DebugWorkspaceSender } from '@deveye/types';
import { MAIL_TRANSPORT_PROVIDER, type MailTransportProvider } from '@deveye/types/sdk';

import type { Database } from '@/db';
import { FeatureError } from '@/features/_define';
import { ORIGINS } from '@/features/_sdk/context';
import { moduleProvider } from '@/features/_sdk/register';
import type { Mailer } from '@/Services/mailer';
import { env } from '@/Utils/Env';
import { isTestEmail } from '../e2e/identity';
import { createBudget } from './budget';
import { mailCatalog, renderSample, type CatalogEntry } from './catalog';

const SENDS_PER_WINDOW = 10;
const WINDOW_MS = 10 * 60_000;

export type MailSender = { kind: 'server' } | { kind: 'workspace'; workspaceId: number; accountId: number };

export interface MailTesterDeps {
    db: Pick<Database, 'workspaces'>;
    /** L'expéditeur du serveur, derrière la boîte des essais : une adresse d'essai n'y reçoit rien. */
    mailer: Mailer;
}

/** Envoie n'importe quel mail du serveur, rendu comme en vrai, à une adresse choisie. */
export function createMailTester({ db, mailer }: MailTesterDeps) {
    const budget = createBudget(SENDS_PER_WINDOW, WINDOW_MS);
    const transport = (): MailTransportProvider | undefined =>
        moduleProvider<MailTransportProvider>(MAIL_TRANSPORT_PROVIDER);

    const find = (key: string): CatalogEntry => {
        const entry = mailCatalog().find((e) => e.fullKey === key);
        if (!entry) throw new FeatureError('not_found', 'Ce mail n’existe pas sur ce serveur');
        return entry;
    };

    const render = (entry: CatalogEntry) => renderSample(entry, { origins: ORIGINS, now: Date.now() });

    /** Les boîtes prêtes des espaces que l'administrateur possède : jamais la boîte d'un autre. */
    const senders = async (adminId: number): Promise<DebugWorkspaceSender[]> => {
        const provider = transport();
        if (!provider) return [];
        const owned = (await db.workspaces.findAccessibleByUser(adminId)).filter((w) => w.owner_user_id === adminId);
        const lists = await Promise.all(
            owned.map(async (w) =>
                (await provider.listSenders(w.id)).map((s) => ({
                    workspaceId: w.id,
                    workspaceName: w.name,
                    accountId: s.id,
                    label: s.label,
                    address: s.address
                }))
            )
        );
        return lists.flat();
    };

    return {
        async catalog(adminId: number) {
            const samples: DebugMailSample[] = mailCatalog().map((e) => ({
                key: e.fullKey,
                label: e.label,
                sourceLabel: e.sourceLabel,
                sender: e.sender
            }));
            return {
                samples,
                server: { configured: mailer.configured, from: env.SMTP_FROM ?? null },
                senders: await senders(adminId)
            };
        },

        async preview(key: string): Promise<DebugMailPreview> {
            const mail = await render(find(key));
            return {
                subject: mail.subject,
                text: mail.text,
                html: mail.html,
                attachments: mail.attachments.map((a) => ({
                    filename: a.filename,
                    contentType: a.contentType,
                    size: a.content.byteLength
                }))
            };
        },

        async send(adminId: number, key: string, to: string, sender: MailSender): Promise<{ captured: boolean }> {
            const entry = find(key);
            if (entry.sender !== sender.kind) {
                throw new FeatureError('validation', 'Ce mail ne part pas de cet expéditeur');
            }
            if (!budget.take(String(adminId))) {
                throw new FeatureError('rate_limited', `Au plus ${SENDS_PER_WINDOW} envois toutes les 10 minutes.`);
            }
            const mail = await render(entry);
            if (sender.kind === 'server') {
                if (!mailer.configured) throw new FeatureError('conflict', 'Aucun serveur SMTP configuré (SMTP_HOST)');
                await mailer.send({ to, subject: mail.subject, text: mail.text, html: mail.html ?? '' });
                return { captured: isTestEmail(to) };
            }
            const provider = transport();
            if (!provider) throw new FeatureError('conflict', 'Le module Mail n’est pas installé');
            const workspace = await db.workspaces.findById(sender.workspaceId);
            if (!workspace || workspace.owner_user_id !== adminId) {
                throw new FeatureError('forbidden', 'Seules les boîtes de vos propres espaces peuvent envoyer');
            }
            if (!(await provider.isReady(sender.accountId, sender.workspaceId))) {
                throw new FeatureError('conflict', 'Cette boîte n’est pas prête à envoyer');
            }
            const sent = await provider.send(sender.accountId, sender.workspaceId, {
                to,
                subject: mail.subject,
                text: mail.text,
                ...(mail.html !== null ? { html: mail.html } : {}),
                ...(mail.attachments.length > 0 ? { attachments: mail.attachments } : {})
            });
            if (!sent) throw new FeatureError('internal', 'La boîte a refusé l’envoi : voir les journaux du serveur');
            return { captured: false };
        }
    };
}

export type MailTester = ReturnType<typeof createMailTester>;
