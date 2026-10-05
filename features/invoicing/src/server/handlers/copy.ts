import { defineSdkFeature, FeatureError } from '@deveye/types/sdk/server';

import {
    invoicingDocArchive,
    invoicingDocDuplicate,
    invoicingDocExport,
    invoicingDocImport
} from '../../contracts/commands';
import {
    invoicingClientContentSchema,
    invoicingDocContentSchema,
    invoicingLineInputSchema,
    type ClientKind,
    type DocumentKind,
    type InvoicingClientInput,
    type InvoicingDocCopy
} from '../../contracts/domain';
import { assertClient, docOr404, draftDeadlines, now, openJson, seal, settingsOf, WRITE, type Ctx } from '../_shared';
import { toDoc } from '../views';
import type { InvoicingDocRow, LineWrite } from '../repo';
import { clientRowOf } from './clients';
import { copyLines, linesOf } from './derive';
import { viewContextOf } from './docs';

/**
 * Archiver, dupliquer, et porter un document d'un espace à l'autre. Tous ces
 * gestes rendent un brouillon ou laissent la pièce émise intacte : une pièce
 * émise ne se dé-émet pas, on repart d'un brouillon neuf.
 */

const EMPTY_CONTENT = invoicingDocContentSchema.parse({});
const lineContentSchema = invoicingLineInputSchema.pick({ label: true, description: true });

async function docView(ctx: Ctx, row: InvoicingDocRow) {
    const settings = await settingsOf(ctx);
    const [view, lines] = await Promise.all([viewContextOf(ctx, [row]), linesOf(ctx, row, settings.vatRegime)]);
    return toDoc(ctx, row, lines, view);
}

export const docArchive = defineSdkFeature({
    ...invoicingDocArchive,
    access: WRITE,
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const row = await docOr404(ctx, input.id);
        await assertClient(ctx, row.client_id, 'write');
        if (row.status === 'draft') {
            throw new FeatureError('conflict', 'Un brouillon ne s’archive pas : supprimez-le s’il ne sert plus.');
        }
        await ctx.repo.setArchived(row.id, ctx.workspaceId, input.archived, now());
        return { doc: await docView(ctx, await docOr404(ctx, row.id)) };
    }
});

export const docDuplicate = defineSdkFeature({
    ...invoicingDocDuplicate,
    access: WRITE,
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const source = await docOr404(ctx, input.id);
        await assertClient(ctx, source.client_id, 'write');

        const settings = await settingsOf(ctx);
        const at = now();
        const content = await openJson(ctx, source.content, invoicingDocContentSchema, EMPTY_CONTENT);

        // Les échéances repartent d'aujourd'hui : celles de la pièce d'origine
        // sont celles d'une autre date. La réponse du client ne suit pas.
        const deadlines = await draftDeadlines(ctx, settings, source.kind as DocumentKind, source.client_id);
        const id = await ctx.repo.insertDoc(
            ctx.workspaceId,
            {
                client_id: source.client_id,
                kind: source.kind,
                parent_doc_id: source.parent_doc_id,
                is_deposit: source.is_deposit,
                currency: settings.currency,
                vat_regime: settings.vatRegime,
                ...deadlines,
                deposit_bp: source.deposit_bp,
                performed_on: source.performed_on,
                content: await seal(ctx, { ...content, acceptance: null }),
                created_by: ctx.userId
            },
            at
        );
        await copyLines(ctx, source, id, settings.vatRegime);
        for (const deduction of await ctx.repo.listDeductions(source.id, ctx.workspaceId)) {
            await ctx.repo.insertDeduction(
                ctx.workspaceId,
                { doc_id: id, deducted_doc_id: deduction.deducted_doc_id, amount: deduction.amount },
                at
            );
        }

        return { doc: await docView(ctx, await docOr404(ctx, id)) };
    }
});

/** Le client d'un document, tel qu'il existe encore, ou tel qu'il était à l'émission. */
async function clientOf(ctx: Ctx, row: InvoicingDocRow): Promise<InvoicingClientInput | null> {
    if (row.client_id !== null) {
        const client = await ctx.repo.findClient(row.client_id, ctx.workspaceId);
        if (client !== null) {
            const content = await openJson(ctx, client.content, invoicingClientContentSchema, null);
            if (content !== null && content.name.trim().length > 0) {
                return {
                    ...content,
                    kind: client.kind as ClientKind,
                    paymentTermsDays: client.payment_terms_days,
                    defaultVatBp: client.default_vat_bp
                };
            }
        }
    }
    if (row.client_snapshot === null) return null;
    const snapshot = await openJson(ctx, row.client_snapshot, invoicingClientContentSchema, null);
    if (snapshot === null || snapshot.name.trim().length === 0) return null;
    // L'instantané ne garde pas le type : un SIRET ou un numéro de TVA dit une entreprise.
    const company = snapshot.siret.trim().length > 0 || snapshot.vatNumber.trim().length > 0;
    return { ...snapshot, kind: company ? 'company' : 'person', paymentTermsDays: null, defaultVatBp: null };
}

export const docExport = defineSdkFeature({
    ...invoicingDocExport,
    handler: async (ctx: Ctx, input) => {
        const row = await docOr404(ctx, input.id);
        await assertClient(ctx, row.client_id, 'read');

        const settings = await settingsOf(ctx);
        const [content, lines, client] = await Promise.all([
            openJson(ctx, row.content, invoicingDocContentSchema, EMPTY_CONTENT),
            linesOf(ctx, row, settings.vatRegime),
            clientOf(ctx, row)
        ]);

        const copy: InvoicingDocCopy = {
            kind: row.kind as InvoicingDocCopy['kind'],
            doc: {
                subject: content.subject,
                intro: content.intro,
                notes: content.notes,
                terms: content.terms,
                purchaseOrder: content.purchaseOrder,
                performedOn: row.performed_on,
                depositBp: row.deposit_bp
            },
            lines: lines.map(({ netCents: _net, ...line }) => ({ ...line, id: null })),
            client
        };
        return { copy };
    }
});

function sameText(a: string, b: string): boolean {
    return a.trim().toLocaleLowerCase('fr') === b.trim().toLocaleLowerCase('fr');
}

/**
 * Le client d'ici qui est celui de la copie : même nom, et même SIRET quand les
 * deux en portent un. Un client mis de côté n'est pas repris, il sortirait du
 * sélecteur du brouillon. Le nom étant scellé, la recherche se fait après
 * descellement, sur le carnet déjà borné.
 */
async function matchingClient(ctx: Ctx, wanted: InvoicingClientInput): Promise<number | null> {
    const siret = wanted.siret.replace(/\s/g, '');
    for (const row of await ctx.repo.listClients(ctx.workspaceId, false)) {
        const content = await openJson(ctx, row.content, invoicingClientContentSchema, null);
        if (content === null || !sameText(content.name, wanted.name)) continue;
        const other = content.siret.replace(/\s/g, '');
        if (siret.length > 0 && other.length > 0 && siret !== other) continue;
        return row.id;
    }
    return null;
}

export const docImport = defineSdkFeature({
    ...invoicingDocImport,
    access: WRITE,
    mutates: true,
    handler: async (ctx: Ctx, input) => {
        const { copy } = input;
        const settings = await settingsOf(ctx);
        const at = now();

        let clientId: number | null = null;
        let clientCreated = false;
        if (copy.client !== null) {
            clientId = await matchingClient(ctx, copy.client);
            if (clientId !== null) {
                await assertClient(ctx, clientId, 'write');
            } else {
                clientId = await ctx.repo.insertClient(ctx.workspaceId, await clientRowOf(ctx, copy.client, false), at);
                clientCreated = true;
            }
        }

        const { performedOn, depositBp, ...text } = copy.doc;
        const deadlines = await draftDeadlines(ctx, settings, copy.kind, clientId);
        const id = await ctx.repo.insertDoc(
            ctx.workspaceId,
            {
                client_id: clientId,
                kind: copy.kind,
                parent_doc_id: null,
                is_deposit: 0,
                currency: settings.currency,
                vat_regime: settings.vatRegime,
                ...deadlines,
                deposit_bp: copy.kind === 'quote' ? depositBp : null,
                performed_on: performedOn,
                content: await seal(ctx, invoicingDocContentSchema.parse(text)),
                created_by: ctx.userId
            },
            at
        );

        const exempt = settings.vatRegime === 'exempt';
        const writes: LineWrite[] = [];
        for (const [index, line] of copy.lines.entries()) {
            writes.push({
                id: null,
                sort_order: index,
                kind: line.kind,
                quantity_milli: line.quantityMilli,
                unit: line.unit,
                unit_price: line.unitPrice,
                vat_bp: exempt ? 0 : line.vatRateBp,
                content: await seal(ctx, lineContentSchema.parse(line))
            });
        }
        await ctx.repo.setLines(id, ctx.workspaceId, writes);

        return { doc: await docView(ctx, await docOr404(ctx, id)), clientCreated };
    }
});

export const copyHandlers = [docArchive, docDuplicate, docExport, docImport];
