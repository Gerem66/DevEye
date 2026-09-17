import crypto from 'node:crypto';

import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    mailserverActivity,
    mailserverAppPasswordCreate,
    mailserverAppPasswordList,
    mailserverAppPasswordRevoke,
    mailserverCount,
    mailserverCreate,
    mailserverDelete,
    mailserverGet,
    mailserverList,
    mailserverPasswordReset,
    mailserverQueueDrop,
    mailserverQueueList,
    mailserverQueueRetry,
    mailserverServerStatus,
    mailserverSetBanner,
    mailserverUpdate
} from '../contracts/commands';
import {
    MAILSERVER_DAILY_LIMIT_DEFAULT,
    MAILSERVER_LOCAL_PART_PATTERN,
    type Credential,
    type DailyPoint,
    type ServerStatus
} from '../contracts/domain';
import {
    bytesOfMb,
    dayOf,
    getEngine,
    loadHomeMailbox,
    loadMailbox,
    now,
    seal,
    toEvent,
    toMailbox,
    toQueueEntry,
    type Ctx
} from './_shared';
import { createInitialFolders } from './folders';
import { generateSecret, hashSecret } from './passwords';
import type { CredentialRow, MailboxRow } from './repo';

/** Le domaine d'une adresse se lit dans l'adresse : celui d'une boîte projetée vit dans un autre espace. */
const hostOf = (row: MailboxRow): string => row.address.slice(row.address.indexOf('@') + 1);

const RECENT_EVENTS = 50;

const NOT_CONFIGURED: ServerStatus = {
    configured: false,
    hostname: '',
    listeners: [],
    certificate: null,
    certificateError: '',
    queueDepth: 0
};

function toCredential(row: CredentialRow): Credential {
    return { id: row.id, label: row.label, origin: row.origin, created: row.created, lastUsedAt: row.last_used_at };
}

async function visibleRows(ctx: Ctx): Promise<MailboxRow[]> {
    const [rows, hidden] = await Promise.all([ctx.repo.listVisible(ctx.workspaceId), ctx.items.restrictions()]);
    return rows.filter((row) => hidden.get(String(row.id)) !== 'none');
}

/** La boîte relue après une écriture, toujours chez elle. */
async function reload(ctx: Ctx, id: number) {
    const row = await ctx.repo.find(id, ctx.workspaceId);
    if (!row) throw new FeatureError('not_found', 'Adresse introuvable.');
    return toMailbox(ctx.cipher(), row, hostOf(row), false);
}

export const mailserverHandlers = [
    defineSdkFeature({
        ...mailserverCount,
        handler: async (ctx: Ctx) => {
            const rows = await visibleRows(ctx);
            const deliveries = rows.map((row) => row.last_delivery_at).filter((ts): ts is number => ts !== null);
            return { count: rows.length, lastDeliveryAt: deliveries.length > 0 ? Math.max(...deliveries) : null };
        }
    }),

    defineSdkFeature({
        ...mailserverList,
        handler: async (ctx: Ctx) => {
            const [rows, shares] = await Promise.all([visibleRows(ctx), ctx.sharing.scope()]);
            return {
                mailboxes: await Promise.all(
                    rows.map(async (row) =>
                        toMailbox(
                            await shares.cipherFor(String(row.id)),
                            row,
                            hostOf(row),
                            row.workspace_id !== ctx.workspaceId
                        )
                    )
                )
            };
        }
    }),

    defineSdkFeature({
        ...mailserverGet,
        handler: async (ctx: Ctx, input) => {
            const row = await loadMailbox(ctx, input.id);
            const cipher = await (await ctx.sharing.scope()).cipherFor(String(row.id));
            return {
                mailbox: await toMailbox(cipher, row, hostOf(row), row.workspace_id !== ctx.workspaceId),
                connection: getEngine()?.connection() ?? null
            };
        }
    }),

    defineSdkFeature({
        ...mailserverCreate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const localPart = input.localPart.trim().toLowerCase();
            if (!MAILSERVER_LOCAL_PART_PATTERN.test(localPart)) {
                throw new FeatureError(
                    'validation',
                    'Avant l’arobase : des minuscules, des chiffres, et « . », « _ » ou « - » entre deux.'
                );
            }
            const domain = await ctx.domains.get(input.domainId);
            if (domain === null) throw new FeatureError('not_found', 'Ce domaine n’existe plus.');
            if (!domain.verified) {
                throw new FeatureError(
                    'validation',
                    'Ce domaine n’est pas encore vérifié : l’adresse ne recevrait rien.'
                );
            }
            const address = `${localPart}@${domain.host}`;
            if ((await ctx.repo.findByAddress(address)) !== null) {
                throw new FeatureError('conflict', 'Cette adresse existe déjà.');
            }

            const password = generateSecret();
            const id = await ctx.repo.createMailbox({
                workspaceId: ctx.workspaceId,
                domainId: domain.id,
                localPart,
                address,
                passwordHash: await hashSecret(password),
                quotaBytes: bytesOfMb(input.quotaMb),
                outboundDailyLimit: MAILSERVER_DAILY_LIMIT_DEFAULT,
                // La clé des corps de la boîte, scellée sous celle du serveur : la
                // remise d'un message entrant n'a ni session ni membre sous la main.
                blobKey: ctx.keys.sealBytes(crypto.randomBytes(32)),
                content: await seal(ctx.cipher(), { displayName: input.displayName.trim() }),
                now: now()
            });
            await createInitialFolders(ctx.repo, id);
            ctx.audit({ action: 'mailserver.create', description: `Adresse ${address} créée.` });
            return { mailbox: await reload(ctx, id), password };
        }
    }),

    defineSdkFeature({
        ...mailserverUpdate,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadHomeMailbox(ctx, input.id);
            await ctx.repo.updateMailbox(row.id, {
                enabled: input.enabled,
                quotaBytes: bytesOfMb(input.quotaMb),
                outboundDailyLimit: input.outboundDailyLimit,
                content: await seal(ctx.cipher(), { displayName: input.displayName.trim() })
            });
            // Une boîte éteinte ne garde pas ses sessions ouvertes.
            if (!input.enabled && row.enabled === 1) await getEngine()?.dropMailbox(row.id, false);
            return { mailbox: await reload(ctx, row.id) };
        }
    }),

    defineSdkFeature({
        ...mailserverDelete,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadHomeMailbox(ctx, input.id);
            await getEngine()?.dropMailbox(row.id, true);
            await ctx.repo.deleteMailbox(row.id);
            await ctx.items.forget(String(row.id));
            ctx.audit({
                action: 'mailserver.delete',
                level: 'warning',
                description: `Adresse ${row.address} supprimée, avec ${row.message_count} message(s).`
            });
            return { ok: true as const };
        }
    }),

    defineSdkFeature({
        ...mailserverSetBanner,
        access: { level: 'write' },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadHomeMailbox(ctx, input.id);
            await ctx.repo.setBanner(row.id, input.dismissed);
            return { mailbox: await reload(ctx, row.id) };
        }
    }),

    defineSdkFeature({
        ...mailserverPasswordReset,
        access: { level: 'write', extras: ['managePasswords'] },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadHomeMailbox(ctx, input.id);
            const password = generateSecret();
            await ctx.repo.setPassword(row.id, await hashSecret(password), now());
            // Qui tenait l'ancien mot de passe ne garde pas sa session.
            await getEngine()?.dropMailbox(row.id, false);
            ctx.audit({
                action: 'mailserver.passwordReset',
                level: 'warning',
                description: `Mot de passe de ${row.address} réinitialisé.`
            });
            return { password };
        }
    }),

    defineSdkFeature({
        ...mailserverAppPasswordList,
        handler: async (ctx: Ctx, input) => {
            const row = await loadMailbox(ctx, input.id);
            return { credentials: (await ctx.repo.listCredentials(row.id)).map(toCredential) };
        }
    }),

    defineSdkFeature({
        ...mailserverAppPasswordCreate,
        access: { level: 'write', extras: ['managePasswords'] },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadHomeMailbox(ctx, input.id);
            const secret = generateSecret();
            const id = await ctx.repo.createCredential({
                mailboxId: row.id,
                label: input.label.trim(),
                secretHash: await hashSecret(secret),
                origin: input.forMails ? 'mails' : 'user',
                saveSent: input.forMails,
                createdBy: ctx.userId,
                now: now()
            });
            ctx.audit({
                action: 'mailserver.appPasswordCreate',
                description: `Mot de passe d’application « ${input.label.trim()} » créé pour ${row.address}.`
            });
            const created = (await ctx.repo.listCredentials(row.id)).find((held) => held.id === id);
            if (!created) throw new FeatureError('internal', 'Le mot de passe d’application n’a pas pu être relu.');
            return { credential: toCredential(created), secret };
        }
    }),

    defineSdkFeature({
        ...mailserverAppPasswordRevoke,
        access: { level: 'write', extras: ['managePasswords'] },
        mutates: true,
        handler: async (ctx: Ctx, input) => {
            const row = await loadHomeMailbox(ctx, input.id);
            if (!(await ctx.repo.deleteCredential(input.credentialId, row.id))) {
                throw new FeatureError('not_found', 'Ce mot de passe d’application n’existe plus.');
            }
            await getEngine()?.dropMailbox(row.id, false);
            ctx.audit({
                action: 'mailserver.appPasswordRevoke',
                description: `Mot de passe d’application révoqué pour ${row.address}.`
            });
            return { ok: true as const };
        }
    }),

    defineSdkFeature({
        ...mailserverActivity,
        handler: async (ctx: Ctx, input) => {
            const row = await loadMailbox(ctx, input.id);
            const cipher = await (await ctx.sharing.scope()).cipherFor(String(row.id));
            const today = now();
            const since = dayOf(today - (input.days - 1) * 86_400);
            const [held, events, counts] = await Promise.all([
                ctx.repo.dailySince(row.id, since),
                ctx.repo.recentEvents(row.id, RECENT_EVENTS),
                ctx.repo.queueCounts(row.id)
            ]);

            // Un jour sans courrier n'a pas de ligne : le graphique veut pourtant son point.
            const byDay = new Map(held.map((point) => [point.day, point]));
            const daily: DailyPoint[] = [];
            for (let offset = input.days - 1; offset >= 0; offset -= 1) {
                const day = dayOf(today - offset * 86_400);
                const point = byDay.get(day);
                daily.push({
                    day,
                    received: point?.received ?? 0,
                    sent: point?.sent ?? 0,
                    rejected: point?.rejected ?? 0,
                    bounced: point?.bounced ?? 0
                });
            }
            const sum = (key: 'received' | 'sent' | 'rejected' | 'bounced'): number =>
                daily.reduce((total, point) => total + point[key], 0);

            return {
                daily,
                totals: {
                    received: sum('received'),
                    sent: sum('sent'),
                    rejected: sum('rejected'),
                    bounced: sum('bounced')
                },
                recent: await Promise.all(events.map((event) => toEvent(cipher, event))),
                queued: counts.queued,
                deferred: counts.deferred
            };
        }
    }),

    defineSdkFeature({
        ...mailserverQueueList,
        handler: async (ctx: Ctx, input) => {
            if (input.id !== undefined) {
                const row = await loadMailbox(ctx, input.id);
                const cipher = await (await ctx.sharing.scope()).cipherFor(String(row.id));
                const entries = await ctx.repo.listQueue(row.workspace_id, row.id);
                return { entries: await Promise.all(entries.map((entry) => toQueueEntry(cipher, entry))) };
            }
            // À l'échelle de l'espace : ses propres boîtes seulement, et pas celles qu'un rôle masque.
            const hidden = await ctx.items.restrictions();
            const entries = (await ctx.repo.listQueue(ctx.workspaceId, null)).filter(
                (entry) => hidden.get(String(entry.mailbox_id)) !== 'none'
            );
            return { entries: await Promise.all(entries.map((entry) => toQueueEntry(ctx.cipher(), entry))) };
        }
    }),

    defineSdkFeature({
        ...mailserverQueueRetry,
        access: { level: 'write', extras: ['manageQueue'] },
        mutates: ['mailserverFlow'],
        handler: async (ctx: Ctx, input) => {
            const entry = await ctx.repo.findQueue(input.queueId);
            if (!entry || entry.workspace_id !== ctx.workspaceId) {
                throw new FeatureError('not_found', 'Ce message n’est plus dans la file.');
            }
            await ctx.items.assert(String(entry.mailbox_id), 'write');
            await ctx.repo.retryQueueNow(entry.id, now());
            getEngine()?.kickQueue();
            return { ok: true as const };
        }
    }),

    defineSdkFeature({
        ...mailserverQueueDrop,
        access: { level: 'write', extras: ['manageQueue'] },
        mutates: ['mailserverFlow'],
        handler: async (ctx: Ctx, input) => {
            const entry = await ctx.repo.findQueue(input.queueId);
            if (!entry || entry.workspace_id !== ctx.workspaceId) {
                throw new FeatureError('not_found', 'Ce message n’est plus dans la file.');
            }
            await ctx.items.assert(String(entry.mailbox_id), 'write');
            if (entry.status === 'sending') {
                throw new FeatureError('conflict', 'Ce message est en cours de remise : réessayez dans un instant.');
            }
            await ctx.repo.removeQueue(entry.id);
            await getEngine()?.releaseBlob(entry.blob_id);
            ctx.audit({
                action: 'mailserver.queueDrop',
                level: 'warning',
                description: 'Message retiré de la file d’envoi avant sa remise.'
            });
            return { ok: true as const };
        }
    }),

    defineSdkFeature({
        ...mailserverServerStatus,
        handler: async () => {
            const engine = getEngine();
            if (!engine) return { status: NOT_CONFIGURED, connection: null };
            return { status: await engine.status(), connection: engine.connection() };
        }
    })
];
