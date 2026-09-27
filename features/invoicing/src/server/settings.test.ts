import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FeatureError } from '@deveye/types/sdk/server';
import { createTestContext } from '@deveye/types/sdk/testing';

import { DEFAULT_SETTINGS } from '../contracts/defaults';
import type { InvoicingSettings } from '../contracts/domain';
import { memoryRepo } from './_memoryRepo';
import { settingsGet, settingsSave } from './handlers/settings';
import { serverEntry } from './index';

const MANIFEST = {
    extraPermissions: [
        { key: 'issue', label: 'Émettre', description: '', type: 'toggle' as const },
        { key: 'issuer', label: 'Émetteur', description: '', type: 'toggle' as const }
    ]
};

function settings(over: Partial<InvoicingSettings> = {}): InvoicingSettings {
    return { ...DEFAULT_SETTINGS, ...over };
}

describe('invoicing.config', () => {
    it('rend les valeurs du code sur un espace vierge, sans rien écrire', async () => {
        const repo = memoryRepo();
        const ctx = createTestContext({ repo });

        const res = await settingsGet.handler(ctx, {});

        assert.deepEqual(res.settings, DEFAULT_SETTINGS);
        assert.equal(repo.store.settings.size, 0, 'une lecture ne crée pas de ligne');
    });

    it('n’annonce aucune limite quand aucune offre n’est installée', async () => {
        const ctx = createTestContext({ repo: memoryRepo() });
        const res = await settingsGet.handler(ctx, {});
        assert.equal(res.usage, null);
    });

    it('compte les devis et les factures séparément, sur tous les espaces du propriétaire', async () => {
        let seen: readonly number[] = [];
        const repo = memoryRepo();
        repo.countIssuedSince = async (workspaceIds, _from, kind) => {
            seen = workspaceIds;
            return kind === 'quote' ? 2 : 1;
        };
        const ctx = createTestContext({
            repo,
            quotaLimits: { quotesPerMonth: 3, invoicesPerMonth: 3 },
            ownerWorkspaceIds: [1, 7],
            quotas: serverEntry.quotas
        });

        const res = await settingsGet.handler(ctx, {});

        assert.deepEqual(res.usage, { quotes: { limit: 3, used: 2 }, invoices: { limit: 3, used: 1 } });
        assert.deepEqual([...seen], [1, 7]);
    });

    it('n’annonce que ce qui est borné', async () => {
        const ctx = createTestContext({
            repo: memoryRepo(),
            quotaLimits: { invoicesPerMonth: 3 },
            quotas: serverEntry.quotas
        });
        const res = await settingsGet.handler(ctx, {});
        assert.deepEqual(res.usage, { quotes: null, invoices: { limit: 3, used: 0 } });
    });

    it('lit une limite à zéro comme une limite, pas comme une absence', async () => {
        const ctx = createTestContext({
            repo: memoryRepo(),
            quotaLimits: { quotesPerMonth: 0, invoicesPerMonth: 0 },
            quotas: serverEntry.quotas
        });
        const res = await settingsGet.handler(ctx, {});
        assert.deepEqual(res.usage, { quotes: { limit: 0, used: 0 }, invoices: { limit: 0, used: 0 } });
    });

    it('part en franchise de TVA, sans taux : les deux réglages ne peuvent pas se contredire', () => {
        assert.equal(DEFAULT_SETTINGS.vatRegime, 'exempt');
        assert.equal(DEFAULT_SETTINGS.defaultVatBp, 0);
    });
});

describe('invoicing.configSave', () => {
    it('enregistre puis relit à l’identique, texte libre compris', async () => {
        const repo = memoryRepo();
        const ctx = createTestContext({
            repo,
            manifest: MANIFEST,
            extras: { issuer: true }
        });

        const wanted = settings({
            currency: 'CHF',
            timeZone: 'Indian/Reunion',
            vatRegime: 'standard',
            paymentTermsDays: 15,
            invoicePrefix: 'FA',
            issuer: { ...DEFAULT_SETTINGS.issuer, legalName: 'Atelier Dupont', iban: 'FR7630001007941234567890185' }
        });

        await settingsSave.handler(ctx, { settings: wanted });
        const res = await settingsGet.handler(ctx, {});

        assert.deepEqual(res.settings, wanted);
        assert.equal(repo.store.settings.size, 1);
        assert.equal(repo.store.settings.get(ctx.workspaceId)?.currency, 'CHF');
    });

    it('garde le nom et l’IBAN hors des colonnes en clair', async () => {
        const repo = memoryRepo();
        const ctx = createTestContext({
            repo,
            manifest: MANIFEST,
            extras: { issuer: true }
        });

        await settingsSave.handler(ctx, {
            settings: settings({
                issuer: { ...DEFAULT_SETTINGS.issuer, legalName: 'Atelier Dupont', iban: 'FR7630001007941234567890185' }
            })
        });

        const row = repo.store.settings.get(ctx.workspaceId);
        assert.ok(row);
        // Le harnais scelle par l'identité, donc le contenu reste lisible ici :
        // ce qu'on vérifie est qu'il est dans `content` et nulle part ailleurs.
        const clear = JSON.stringify({ ...row, content: '' });
        assert.ok(!clear.includes('Dupont'));
        assert.ok(!clear.includes('FR7630001007941234567890185'));
        assert.ok(row.content.includes('Atelier Dupont'));
    });

    it('refuse un taux par défaut non nul en franchise de TVA', async () => {
        const ctx = createTestContext({
            repo: memoryRepo(),
            manifest: MANIFEST,
            extras: { issuer: true }
        });

        await assert.rejects(
            () => settingsSave.handler(ctx, { settings: settings({ vatRegime: 'exempt', defaultVatBp: 2000 }) }),
            (error: unknown) => error instanceof FeatureError && error.code === 'validation'
        );
    });

    it('accepte le régime assujetti avec son taux', async () => {
        const repo = memoryRepo();
        const ctx = createTestContext({
            repo,
            manifest: MANIFEST,
            extras: { issuer: true }
        });

        await settingsSave.handler(ctx, { settings: settings({ vatRegime: 'standard', defaultVatBp: 550 }) });
        assert.equal(repo.store.settings.get(ctx.workspaceId)?.default_vat_bp, 550);
    });

    it('laisse une trace au journal d’audit', async () => {
        const ctx = createTestContext({
            repo: memoryRepo(),
            manifest: MANIFEST,
            extras: { issuer: true }
        });

        await settingsSave.handler(ctx, { settings: settings() });
        assert.equal(ctx.recorded.audits.length, 1);
        assert.equal(ctx.recorded.audits[0].action, 'invoicing.config');
    });
});
