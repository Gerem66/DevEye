import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import { invoicingClientList, invoicingClientRemove, invoicingClientSave } from '../../contracts/commands';
import {
    invoicingClientContentSchema,
    type ClientKind,
    type InvoicingClient,
    type InvoicingClientInput
} from '../../contracts/domain';
import { now, seal, settingsOf, today, WRITE, type Ctx } from '../_shared';
import type { InvoicingClientRow, InvoicingClientUsage } from '../repo';

export const EMPTY_CLIENT_USAGE: InvoicingClientUsage = {
    documents: 0,
    billedCents: 0,
    outstandingCents: 0,
    overdueCents: 0,
    lastIssuedOn: null
};

/**
 * Une ligne rendue au client. Un contenu illisible (scellé sous une clé serveur
 * précédente) devient un client sans nom plutôt qu'un écran en panne : c'est
 * pour cela que `tryDecrypt` est la règle sur les listes.
 */
export async function toClient(
    ctx: Ctx,
    row: InvoicingClientRow,
    usage: InvoicingClientUsage
): Promise<InvoicingClient> {
    const plain = await ctx.cipher().tryDecrypt(row.content);
    const parsed = plain === null ? null : invoicingClientContentSchema.safeParse(JSON.parse(plain));
    const content = parsed?.success
        ? parsed.data
        : invoicingClientContentSchema.parse({ name: 'Client illisible', country: '' });

    return {
        ...content,
        id: row.id,
        kind: row.kind as ClientKind,
        paymentTermsDays: row.payment_terms_days,
        defaultVatBp: row.default_vat_bp,
        archived: row.archived === 1,
        usage
    };
}

/** La ligne à écrire d'un client saisi, son identité scellée. */
export async function clientRowOf(
    ctx: Ctx,
    input: InvoicingClientInput,
    archived: boolean
): Promise<Omit<InvoicingClientRow, 'id'>> {
    const { kind, paymentTermsDays, defaultVatBp, ...content } = input;
    return {
        kind,
        payment_terms_days: paymentTermsDays,
        default_vat_bp: defaultVatBp,
        archived: archived ? 1 : 0,
        content: await seal(ctx, content)
    };
}

export const clientList = defineSdkFeature({
    ...invoicingClientList,
    handler: async (ctx: Ctx, input) => {
        const settings = await settingsOf(ctx);
        const [rows, usage, restrictions] = await Promise.all([
            ctx.repo.listClients(ctx.workspaceId, input.archived),
            ctx.repo.clientUsage(ctx.workspaceId, today(settings)),
            ctx.items.restrictions()
        ]);

        // Un client fermé par un rôle n'apparaît pas : ses documents non plus,
        // puisqu'ils le désignent.
        const visible = rows.filter((row) => restrictions.get(String(row.id)) !== 'none');
        const clients = await Promise.all(
            visible.map((row) => toClient(ctx, row, usage.get(row.id) ?? EMPTY_CLIENT_USAGE))
        );
        // Le nom est scellé : le tri se fait ici, après descellement, jamais en SQL.
        clients.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
        return { clients };
    }
});

export const clientSave = defineSdkFeature({
    ...invoicingClientSave,
    access: WRITE,
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const at = now();
        const row = await clientRowOf(ctx, input.client, input.archived);

        let id = input.id;
        if (id === null) {
            id = await ctx.repo.insertClient(ctx.workspaceId, row, at);
        } else {
            await ctx.items.assert(String(id), 'write');
            const touched = await ctx.repo.updateClient(id, ctx.workspaceId, row, at);
            if (touched === 0) throw new FeatureError('not_found', 'Ce client n’existe pas dans cet espace.');
        }

        const settings = await settingsOf(ctx);
        const usage = await ctx.repo.clientUsage(ctx.workspaceId, today(settings));
        const saved = await ctx.repo.findClient(id, ctx.workspaceId);
        if (saved === null) throw new FeatureError('not_found', 'Ce client n’existe pas dans cet espace.');
        return { client: await toClient(ctx, saved, usage.get(id) ?? EMPTY_CLIENT_USAGE) };
    }
});

/**
 * Le retrait définitif. Il est refusé dès qu'un document porte ce client : ce
 * n'est pas la base qui l'interdit (sa clé étrangère détache plutôt qu'elle
 * refuse, sans quoi la suppression d'un espace entier pourrait buter dessus),
 * c'est la règle du module, et la mise de côté est là pour tous les autres cas.
 */
export const clientRemove = defineSdkFeature({
    ...invoicingClientRemove,
    access: WRITE,
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        await ctx.items.assert(String(input.id), 'write');
        const documents = await ctx.repo.countDocsOfClient(input.id, ctx.workspaceId);
        if (documents > 0) {
            throw new FeatureError(
                'conflict',
                `${documents} document${documents > 1 ? 's portent' : ' porte'} ce client : mettez-le de côté plutôt que de le retirer.`
            );
        }

        const removed = await ctx.repo.deleteClient(input.id, ctx.workspaceId);
        if (removed === 0) throw new FeatureError('not_found', 'Ce client n’existe pas dans cet espace.');
        // Sans cet oubli, une route de notification et les restrictions de rôle
        // survivraient au client, et le prochain à reprendre son identifiant en
        // hériterait.
        await ctx.items.forget(String(input.id));
        return { ok: true as const };
    }
});

export const clientHandlers = [clientList, clientSave, clientRemove];
