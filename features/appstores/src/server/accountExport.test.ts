import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { accountExportProblem, type SdkExportSkip, type SdkExportTable } from '@deveye/types/sdk/server';

import { serverEntry } from './index';

describe('l’export du compte', () => {
    it('déclare un sort valide pour chaque table', () => {
        assert.ok(serverEntry.accountExport, 'le module déclare son export');
        assert.equal(accountExportProblem(serverEntry.accountExport), null);
    });

    it('ne sort jamais une clé privée, et tait l’historique importé des stores', () => {
        const tables = serverEntry.accountExport?.tables ?? {};
        assert.deepEqual(Object.keys(tables).sort(), [
            'ft_appstores_apps',
            'ft_appstores_daily',
            'ft_appstores_listings',
            'ft_appstores_revenue',
            'ft_appstores_reviews',
            'ft_appstores_sources'
        ]);
        assert.deepEqual((tables.ft_appstores_sources as SdkExportTable).omit, ['secret_enc']);
        assert.ok('skip' in (tables.ft_appstores_daily as SdkExportSkip));
        assert.ok('skip' in (tables.ft_appstores_revenue as SdkExportSkip));
        assert.match(
            (tables.ft_appstores_reviews as SdkExportTable).where,
            /^app_id IN \(SELECT id FROM ft_appstores_apps/
        );
    });
});
