import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeatureError } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { addDays, todayIn } from '../contracts/calendar';
import { numberLabel, seqYearOf } from './numbering';
import { DEFAULT_SETTINGS } from '../contracts/defaults';
import { invoicingErrorDetailsSchema, type InvoicingLineInput } from '../contracts/domain';
import { docRow, emptyStore, memoryRepo, type MemoryStore } from './_memoryRepo';
import { clientSave } from './handlers/clients';
import { docSave, linesSet } from './handlers/docs';
import { docIssue, docStatus } from './handlers/issue';

/**
 * Les dates sont relatives au jour courant, jamais écrites en dur : une borne
 * d'antériorité d'un mois ferait tomber ces tests le mois prochain.
 */
const DAY = todayIn('Europe/Paris');
const YEAR = Number(DAY.slice(0, 4));

const MANIFEST = {
    extraPermissions: [
        { key: 'issue', label: 'Émettre', description: '', type: 'toggle' as const },
        { key: 'issuer', label: 'Émetteur', description: '', type: 'toggle' as const }
    ]
};

function ctxOf(store: MemoryStore, over: Record<string, unknown> = {}) {
    return createTestContext({
        repo: memoryRepo(store),
        workspaceId: 1,
        manifest: MANIFEST,
        extras: { issue: true, issuer: true },
        ...over
    });
}

/** Un espace prêt à émettre : assujetti, avec une identité complète. */
function readyWorkspace(store: MemoryStore, over: Record<string, unknown> = {}): void {
    store.settings.set(1, {
        currency: 'EUR',
        time_zone: 'Europe/Paris',
        vat_regime: 'standard',
        default_vat_bp: 2000,
        payment_terms_days: 30,
        quote_validity_days: 30,
        quote_prefix: 'D',
        invoice_prefix: 'F',
        credit_prefix: 'A',
        number_reset: 'yearly',
        number_start: 1,
        number_pad: 4,
        mail_sender_id: null,
        content: JSON.stringify({
            issuer: { ...DEFAULT_SETTINGS.issuer, legalName: 'Atelier Dupont', siret: '81234567800017' },
            wording: DEFAULT_SETTINGS.wording
        }),
        ...over
    });
}

/** Les champs d'un client, hors nom : la fiche complète tient en une constante. */
const CLIENT_FIELDS = {
    kind: 'company' as const,
    contactName: '',
    email: '',
    phone: '',
    address: '1 place du Marché',
    postalCode: '38000',
    city: 'Grenoble',
    country: 'France',
    siret: '',
    vatNumber: '',
    note: '',
    paymentTermsDays: null,
    defaultVatBp: null
};

function line(over: Partial<InvoicingLineInput> = {}): InvoicingLineInput {
    return {
        id: null,
        kind: 'service',
        label: 'Développement',
        description: '',
        quantityMilli: 2000,
        unit: 'day',
        unitPrice: 50_000,
        vatRateBp: 2000,
        ...over
    };
}

/** Un brouillon complet, prêt à être émis. */
async function readyDraft(store: MemoryStore, kind: 'quote' | 'invoice' = 'invoice') {
    readyWorkspace(store);
    const ctx = ctxOf(store);
    const client = await clientSave.handler(ctx, {
        id: null,
        client: { ...CLIENT_FIELDS, name: 'Mairie de Nowhere' },
        archived: false
    });
    const doc = await docSave.handler(ctx, {
        id: null,
        kind,
        doc: {
            clientId: client.client.id,
            subject: 'Refonte',
            intro: '',
            notes: '',
            terms: '',
            purchaseOrder: '',
            performedOn: null,
            dueOn: null,
            validUntil: null
        }
    });
    await linesSet.handler(ctx, { docId: doc.doc.id, lines: [line()] });
    return { ctx, store, id: doc.doc.id, clientId: client.client.id };
}

describe('numérotation', () => {
    it('écrit le numéro tel qu’il paraîtra', () => {
        const settings = { ...DEFAULT_SETTINGS, invoicePrefix: 'FA', numberPad: 4 };
        assert.equal(numberLabel(settings, 'invoice', 2026, 7), 'FA2026-0007');
        assert.equal(numberLabel({ ...settings, numberPad: 2 }, 'invoice', 2026, 7), 'FA2026-07');
    });

    it('n’écrit pas d’année quand la suite ne repart jamais', () => {
        const settings = { ...DEFAULT_SETTINGS, numberReset: 'never' as const };
        assert.equal(seqYearOf(settings, '2026-09-22'), 0);
        assert.equal(numberLabel(settings, 'invoice', 0, 43), 'F0043');
    });
});

describe('invoicing.docIssue', () => {
    it('numérote, fige les totaux et les lignes', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store);

        const res = await docIssue.handler(ctx, { id, issuedOn: DAY });

        assert.equal(res.doc.status, 'issued');
        assert.equal(res.doc.numberLabel, `F${YEAR}-0001`);
        assert.equal(res.doc.issuedOn, DAY);
        assert.equal(res.doc.dueOn, addDays(DAY, 30));
        assert.equal(res.doc.totals.grossCents, 120_000);

        const row = store.docs.find((d) => d.id === id);
        assert.equal(row?.total_net, 100_000);
        assert.equal(row?.total_vat, 20_000);
        assert.ok(row?.issuer_snapshot !== null, 'l’émetteur est figé');
        assert.ok(row?.client_snapshot !== null, 'le client est figé');
        assert.equal(store.lines.find((l) => l.doc_id === id)?.net_amount, 100_000);
    });

    it('envoie un devis plutôt que de l’émettre, et le date de sa validité', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store, 'quote');
        const res = await docIssue.handler(ctx, { id, issuedOn: DAY });

        assert.equal(res.doc.status, 'sent');
        assert.equal(res.doc.numberLabel, `D${YEAR}-0001`);
        assert.equal(res.doc.validUntil, addDays(DAY, 30));
        assert.equal(res.doc.dueOn, null);
    });

    it('garde l’instantané du client même s’il change de nom ensuite', async () => {
        const store = emptyStore();
        const { ctx, id, clientId } = await readyDraft(store);
        await docIssue.handler(ctx, { id, issuedOn: DAY });

        await clientSave.handler(ctx, {
            id: clientId,
            client: {
                kind: 'company',
                name: 'Commune de Nowhere',
                contactName: '',
                email: '',
                phone: '',
                address: '',
                postalCode: '',
                city: '',
                country: 'France',
                siret: '',
                vatNumber: '',
                note: '',
                paymentTermsDays: null,
                defaultVatBp: null
            },
            archived: false
        });

        const { docGet } = await import('./handlers/docs');
        const after = await docGet.handler(ctx, { id });
        assert.equal(after.doc.clientName, 'Mairie de Nowhere');
    });

    it('suit la suite des numéros', async () => {
        const store = emptyStore();
        const first = await readyDraft(store);
        await docIssue.handler(first.ctx, { id: first.id, issuedOn: DAY });

        const second = await docSave.handler(first.ctx, {
            id: null,
            kind: 'invoice',
            doc: {
                clientId: first.clientId,
                subject: '',
                intro: '',
                notes: '',
                terms: '',
                purchaseOrder: '',
                performedOn: null,
                dueOn: null,
                validUntil: null
            }
        });
        await linesSet.handler(first.ctx, { docId: second.doc.id, lines: [line()] });
        const res = await docIssue.handler(first.ctx, { id: second.doc.id, issuedOn: DAY });

        assert.equal(res.doc.numberLabel, `F${YEAR}-0002`);
    });

    it('reprend le rang d’une émission interrompue au lieu d’en consommer un autre', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store);
        // Le rang est posé, mais l'émission s'est arrêtée là.
        const row = store.docs.find((d) => d.id === id);
        Object.assign(row!, { seq_year: YEAR, number: 5, number_label: `F${YEAR}-0005` });

        const res = await docIssue.handler(ctx, { id, issuedOn: DAY });
        assert.equal(res.doc.numberLabel, `F${YEAR}-0005`);
    });

    it('démarre à la reprise d’historique demandée', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store);
        store.settings.get(1)!.number_start = 43;

        const res = await docIssue.handler(ctx, { id, issuedOn: DAY });
        assert.equal(res.doc.numberLabel, `F${YEAR}-0043`);
    });

    it('refuse sans identité d’émetteur', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store);
        store.settings.get(1)!.content = JSON.stringify({
            issuer: DEFAULT_SETTINGS.issuer,
            wording: DEFAULT_SETTINGS.wording
        });

        await assert.rejects(
            () => docIssue.handler(ctx, { id, issuedOn: DAY }),
            (error: unknown) =>
                error instanceof FeatureError && error.code === 'validation' && error.message.includes('dénomination')
        );
        assert.equal(store.docs.find((d) => d.id === id)?.number, null, 'aucun rang n’est consommé');
    });

    it('dit où se répare un refus : l’onglet des réglages, ou la fiche du client', async () => {
        const store = emptyStore();
        const { ctx, id, clientId } = await readyDraft(store);
        store.settings.get(1)!.content = JSON.stringify({
            issuer: DEFAULT_SETTINGS.issuer,
            wording: DEFAULT_SETTINGS.wording
        });

        // L'écran monte son bouton à partir de ces détails : sans eux, l'utilisateur
        // devrait retrouver seul le chemin au moment où il est bloqué.
        await assert.rejects(
            () => docIssue.handler(ctx, { id, issuedOn: DAY }),
            (error: unknown) =>
                error instanceof FeatureError &&
                invoicingErrorDetailsSchema.parse(error.details).settingsSection === 'general'
        );

        readyWorkspace(store);
        await clientSave.handler(ctx, {
            id: clientId,
            client: { ...CLIENT_FIELDS, name: ' ' },
            archived: false
        });

        await assert.rejects(
            () => docIssue.handler(ctx, { id, issuedOn: DAY }),
            (error: unknown) =>
                error instanceof FeatureError && invoicingErrorDetailsSchema.parse(error.details).clientFiche === true
        );
    });

    it('refuse sans SIRET quand l’émetteur est en France', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store);
        store.settings.get(1)!.content = JSON.stringify({
            issuer: { ...DEFAULT_SETTINGS.issuer, legalName: 'Atelier Dupont', country: 'France', siret: '' },
            wording: DEFAULT_SETTINGS.wording
        });

        await assert.rejects(
            () => docIssue.handler(ctx, { id, issuedOn: DAY }),
            (error: unknown) =>
                error instanceof FeatureError && error.code === 'validation' && error.message.includes('SIRET')
        );
    });

    it('refuse un document sans ligne, et un document à zéro', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store);
        await linesSet.handler(ctx, { docId: id, lines: [] });

        await assert.rejects(
            () => docIssue.handler(ctx, { id, issuedOn: DAY }),
            (error: unknown) => error instanceof FeatureError && error.code === 'validation'
        );
    });

    it('refuse une date future, et une date trop ancienne', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store);
        await assert.rejects(
            () => docIssue.handler(ctx, { id, issuedOn: addDays(DAY, 1) }),
            (error: unknown) => error instanceof FeatureError && error.message.includes('future')
        );
        await assert.rejects(
            () => docIssue.handler(ctx, { id, issuedOn: addDays(DAY, -40) }),
            (error: unknown) => error instanceof FeatureError && error.message.includes('un mois')
        );
    });

    it('refuse une date antérieure au dernier document de la suite', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store);
        store.docs.push(
            docRow({
                id: 500,
                kind: 'invoice',
                seq_year: YEAR,
                number: 9,
                issued_on: addDays(DAY, -2),
                status: 'issued'
            })
        );

        await assert.rejects(
            () => docIssue.handler(ctx, { id, issuedOn: addDays(DAY, -5) }),
            (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
        );
    });

    it('refuse une deuxième émission', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store);
        await docIssue.handler(ctx, { id, issuedOn: DAY });

        await assert.rejects(
            () => docIssue.handler(ctx, { id, issuedOn: DAY }),
            (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
        );
    });

    it('refuse au-delà de la limite de l’offre, sans consommer de rang', async () => {
        const store = emptyStore();
        const { id } = await readyDraft(store);
        const ctx = ctxOf(store, { quotaLimits: { invoicesPerMonth: 0 } });

        await assert.rejects(
            () => docIssue.handler(ctx, { id, issuedOn: DAY }),
            (error: unknown) => error instanceof FeatureError && error.code === 'quota_exceeded'
        );
        assert.equal(store.docs.find((d) => d.id === id)?.number, null);
    });

    it('laisse passer un avoir même à la limite : corriger n’est pas facturer', async () => {
        const store = emptyStore();
        const { id } = await readyDraft(store);
        store.docs.find((d) => d.id === id)!.kind = 'credit';
        const ctx = ctxOf(store, { quotaLimits: { quotesPerMonth: 0, invoicesPerMonth: 0 } });

        const res = await docIssue.handler(ctx, { id, issuedOn: DAY });
        assert.equal(res.doc.numberLabel, `A${YEAR}-0001`);
    });

    it('ne fait pas payer au devis la place de sa facture', async () => {
        const store = emptyStore();
        const quote = await readyDraft(store, 'quote');
        // Une facture a déjà été émise ce mois-ci : le devis ne doit pas en pâtir.
        store.docs.push(docRow({ id: 900, kind: 'invoice', issued_on: DAY }));
        const ctx = ctxOf(store, { quotaLimits: { quotesPerMonth: 1, invoicesPerMonth: 1 } });

        const res = await docIssue.handler(ctx, { id: quote.id, issuedOn: DAY });
        assert.equal(res.doc.numberLabel, `D${YEAR}-0001`);
    });

    it('laisse une trace au journal d’audit', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store);
        await docIssue.handler(ctx, { id, issuedOn: DAY });

        assert.equal(ctx.recorded.audits.at(-1)?.action, 'invoicing.issue');
    });
});

describe('invoicing.docStatus', () => {
    it('accepte un devis envoyé', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store, 'quote');
        await docIssue.handler(ctx, { id, issuedOn: DAY });

        const res = await docStatus.handler(ctx, { id, status: 'accepted' });
        assert.equal(res.doc.status, 'accepted');
        assert.equal(res.doc.displayStatus, 'accepted');
    });

    it('rejoué, ne se plaint pas', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store, 'quote');
        await docIssue.handler(ctx, { id, issuedOn: DAY });
        await docStatus.handler(ctx, { id, status: 'accepted' });

        const res = await docStatus.handler(ctx, { id, status: 'accepted' });
        assert.equal(res.doc.status, 'accepted');
    });

    it('refuse un devis encore en brouillon', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store, 'quote');

        await assert.rejects(
            () => docStatus.handler(ctx, { id, status: 'accepted' }),
            (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
        );
    });

    it('refuse de changer l’état d’une facture à la main', async () => {
        const store = emptyStore();
        const { ctx, id } = await readyDraft(store);
        await docIssue.handler(ctx, { id, issuedOn: DAY });

        await assert.rejects(
            () => docStatus.handler(ctx, { id, status: 'accepted' }),
            (error: unknown) => error instanceof FeatureError && error.code === 'conflict'
        );
    });
});
