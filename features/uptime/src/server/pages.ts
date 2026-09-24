import { randomBytes } from 'node:crypto';

import {
    uptimePageAdd,
    uptimePageList,
    uptimePageRemove,
    uptimePageUpdate,
    type UptimePageDraft
} from '../contracts/commands';
import type { UptimePage, UptimePageRow, UptimePageServiceRow } from '../contracts/domain';
import { defineSdkFeature, FeatureError, type SdkDomain } from '@deveye/types/sdk/server';

import { decryptPage, encryptPage, forgetStatusPage, statusPageUrl, type Ctx } from './_shared';
import type { UptimePageEntry } from './repoPages';

/**
 * Les pages de statut, côté membres : leur réglage dans l'onglet « Pages de
 * statut » de la feature. Une page appartient à son espace et ne montre que
 * les services de celui-ci : un service projeté d'ailleurs n'est pas le sien à
 * exposer.
 */

/** Le lien sous l'adresse de DevEye : assez long pour ne pas se deviner. */
function newPublicRef(): string {
    return randomBytes(8).toString('hex');
}

async function toPage(
    ctx: Ctx,
    row: UptimePageRow,
    entries: readonly UptimePageServiceRow[],
    domains: ReadonlyMap<number, SdkDomain>
): Promise<UptimePage> {
    const cipher = ctx.cipher();
    const payload = await decryptPage(cipher, row.content);
    return {
        id: row.id,
        title: payload.title,
        description: payload.description,
        url: statusPageUrl(
            ctx.origins.public,
            row.public_ref,
            row.domain_id === null ? null : (domains.get(row.domain_id) ?? null)
        ),
        domainId: row.domain_id,
        theme: row.theme,
        showErrors: row.show_errors === 1,
        showLatency: row.show_latency === 1,
        enabled: row.enabled === 1,
        services: await Promise.all(
            entries.map(async (entry) => ({
                id: entry.service_id,
                label: entry.label === null ? null : await cipher.tryDecrypt(entry.label)
            }))
        ),
        created: row.created
    };
}

/** Les services qu'une restriction de rôle masque à l'appelant : ni montrés, ni retirés par lui. */
async function hiddenServices(ctx: Ctx): Promise<Set<number>> {
    const restrictions = await ctx.items.restrictions();
    return new Set([...restrictions].filter(([, level]) => level === 'none').map(([id]) => Number(id)));
}

async function loadPages(ctx: Ctx, rows: readonly UptimePageRow[]): Promise<UptimePage[]> {
    const [entries, domains, hidden] = await Promise.all([
        ctx.repo.pages.entriesOf(rows.map((row) => row.id)),
        ctx.domains.list(),
        hiddenServices(ctx)
    ]);
    const byId = new Map(domains.map((domain) => [domain.id, domain]));
    return Promise.all(
        rows.map((row) =>
            toPage(
                ctx,
                row,
                entries.filter((entry) => entry.page_id === row.id && !hidden.has(entry.service_id)),
                byId
            )
        )
    );
}

/**
 * Les services d'un brouillon : ceux de l'espace, lisibles par l'appelant.
 * Chaque nom public est scellé, sous la clé de l'espace de la page.
 */
async function draftEntries(ctx: Ctx, draft: UptimePageDraft): Promise<UptimePageEntry[]> {
    const own = new Set((await ctx.repo.services.listByWorkspace(ctx.workspaceId)).map((row) => row.id));
    const cipher = ctx.cipher();
    const entries: UptimePageEntry[] = [];
    for (const service of draft.services) {
        if (!own.has(service.id)) {
            throw new FeatureError('validation', 'Une page ne montre que les services de son propre espace.');
        }
        await ctx.items.assert(String(service.id), 'read');
        entries.push({
            serviceId: service.id,
            label: service.label === null ? null : await cipher.encrypt(service.label)
        });
    }
    return entries;
}

/**
 * Le domaine d'un brouillon : un domaine de l'espace, vérifié, que nulle autre
 * page ne sert déjà. Celui que la page a déjà reste accepté s'il retombe en
 * attente : le retirer en silence changerait son adresse.
 */
async function assertDomain(ctx: Ctx, domainId: number | null, page: UptimePageRow | null): Promise<void> {
    if (domainId === null) return;
    const domain = await ctx.domains.get(domainId);
    if (!domain) throw new FeatureError('not_found', 'Ce domaine n’existe plus dans cet espace.');
    if (!domain.verified && domainId !== page?.domain_id) {
        throw new FeatureError(
            'validation',
            'Ce domaine n’est pas encore vérifié : finissez sa vérification dans l’onglet Domaines.'
        );
    }
    const taken = await ctx.repo.pages.findByDomain(domainId);
    if (taken && taken.id !== page?.id) {
        const { title } = await decryptPage(ctx.cipher(), taken.content);
        throw new FeatureError(
            'conflict',
            `Ce domaine sert déjà la page « ${title} ». Un domaine ne sert qu’une page.`
        );
    }
}

function configOf(draft: UptimePageDraft, content: string) {
    return {
        content,
        domainId: draft.domainId,
        theme: draft.theme,
        showErrors: draft.showErrors,
        showLatency: draft.showLatency,
        enabled: draft.enabled
    };
}

export const pageHandlers = [
    defineSdkFeature({
        ...uptimePageList,
        handler: async (ctx: Ctx) => {
            const [rows, limit] = await Promise.all([
                ctx.repo.pages.listByWorkspace(ctx.workspaceId),
                ctx.quota.limit('pages')
            ]);
            return { pages: await loadPages(ctx, rows), limit };
        }
    }),
    defineSdkFeature({
        ...uptimePageAdd,
        access: { level: 'write' },
        mutates: ['uptimePages'],
        handler: async (ctx: Ctx, input) => {
            const draft = input.page;
            await ctx.quota.assert('pages', async (owned) => (await ctx.repo.pages.countInWorkspaces(owned)) + 1);
            const entries = await draftEntries(ctx, draft);
            await assertDomain(ctx, draft.domainId, null);
            const content = await encryptPage(ctx.cipher(), { title: draft.title, description: draft.description });
            const row = await ctx.repo.pages.create({
                workspaceId: ctx.workspaceId,
                publicRef: newPublicRef(),
                ...configOf(draft, content)
            });
            await ctx.repo.pages.setEntries(row.id, entries);
            ctx.audit({
                action: 'uptime.pageAdd',
                description: `Page de statut créée : « ${draft.title} »`,
                metadata: { pageId: row.id }
            });
            const [page] = await loadPages(ctx, [row]);
            return { page };
        }
    }),
    defineSdkFeature({
        ...uptimePageUpdate,
        access: { level: 'write' },
        mutates: ['uptimePages'],
        handler: async (ctx: Ctx, input) => {
            const existing = await ctx.repo.pages.find(input.id, ctx.workspaceId);
            if (!existing) throw new FeatureError('not_found', 'Cette page de statut n’existe plus.');
            const draft = input.page;
            const entries = await draftEntries(ctx, draft);
            await assertDomain(ctx, draft.domainId, existing);
            // Ce que l'appelant ne voit pas reste où il était : une restriction
            // de rôle ne se contourne pas en réécrivant la liste.
            const hidden = await hiddenServices(ctx);
            const kept = (await ctx.repo.pages.entriesOf([existing.id]))
                .filter((entry) => hidden.has(entry.service_id))
                .map((entry) => ({ serviceId: entry.service_id, label: entry.label }));
            const content = await encryptPage(ctx.cipher(), { title: draft.title, description: draft.description });
            const row = await ctx.repo.pages.update(existing.id, ctx.workspaceId, configOf(draft, content));
            if (!row) throw new FeatureError('not_found', 'Cette page de statut n’existe plus.');
            await ctx.repo.pages.setEntries(row.id, [...entries, ...kept]);
            forgetStatusPage(row.id);
            ctx.audit({
                action: 'uptime.pageUpdate',
                description: `Page de statut modifiée : « ${draft.title} »`,
                metadata: { pageId: row.id }
            });
            const [page] = await loadPages(ctx, [row]);
            return { page };
        }
    }),
    defineSdkFeature({
        ...uptimePageRemove,
        access: { level: 'write' },
        mutates: ['uptimePages'],
        handler: async (ctx: Ctx, input) => {
            const removed = await ctx.repo.pages.delete(input.id, ctx.workspaceId);
            if (!removed) throw new FeatureError('not_found', 'Cette page de statut n’existe plus.');
            forgetStatusPage(input.id);
            ctx.audit({
                action: 'uptime.pageRemove',
                description: 'Page de statut supprimée',
                metadata: { pageId: input.id }
            });
            return { id: input.id };
        }
    })
];
