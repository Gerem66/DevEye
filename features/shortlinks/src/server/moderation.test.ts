import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SdkFeatureContext, SdkServerKeys } from '@deveye/types/sdk/server';
import { createTestContext, createTestServiceDeps } from '@deveye/types/sdk/testing';
import type { z, ZodType } from 'zod';

import { shortlinksReportDecide, shortlinksReports } from '../contracts/commands';
import { linkRow, memoryRepo, type MemoryRepo } from './_testing';
import { moderationHandlers } from './moderation';
import type { ShortlinksRepo } from './repo';
import { sealReport } from './reports';

/**
 * La modération : un modérateur juge le contenu d'un signalement sans savoir
 * d'où il vient, l'administrateur voit tout, et chaque décision relance le
 * compte de ce qui attend.
 */

function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = moderationHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return (ctx: SdkFeatureContext<ShortlinksRepo>, input: z.input<C['input']>) =>
        def.handler(ctx, contract.input.parse(input) as never) as Promise<z.input<C['output']>>;
}

/** Un signalement scellé par de vraies clés de test : le contexte de commande du harnais n'ouvre rien. */
async function reported(): Promise<{ repo: MemoryRepo; keys: SdkServerKeys }> {
    const repo = memoryRepo([linkRow({ id: 1, code: 'abcdef' })]);
    const { keys } = createTestServiceDeps();
    await repo.reports.insert({
        ref: '3FA92C1B07DE',
        linkId: 1,
        workspaceId: 1,
        reason: 'phishing',
        content: sealReport(keys, '3FA92C1B07DE', {
            url: 'https://public.deveye.test/l/abcdef',
            title: 'Rentrée',
            target: 'https://exemple.fr/offre',
            message: 'Cette page imite ma banque.',
            name: 'Camille',
            email: 'camille@exemple.fr',
            ip: '203.0.113.7'
        })
    });
    return { repo, keys };
}

describe('shortlinks.reports', () => {
    it('tait l’adresse et l’IP du signalant à un modérateur, pas à un administrateur', async () => {
        const { repo, keys } = await reported();
        const read = (isAdmin: boolean) =>
            handlerFor(shortlinksReports)({ ...createTestContext({ repo, isAdmin }), keys }, { status: 'open' });

        const moderator = await read(false);
        assert.equal(moderator.reports[0].reporterName, 'Camille');
        assert.equal(moderator.reports[0].message, 'Cette page imite ma banque.');
        assert.equal(moderator.reports[0].reporterEmail, null);
        assert.equal(moderator.reports[0].ip, null);

        const admin = await read(true);
        assert.equal(admin.reports[0].reporterEmail, 'camille@exemple.fr');
        assert.equal(admin.reports[0].ip, '203.0.113.7');
    });
});

describe('shortlinks.reportDecide', () => {
    it('relance le compte de ce qui attend, et rend la décision sans l’origine à un modérateur', async () => {
        const { repo, keys } = await reported();
        const ctx = { ...createTestContext({ repo }), keys };
        const { report } = await handlerFor(shortlinksReportDecide)(ctx, {
            reportId: 1,
            decision: 'dismiss',
            note: ''
        });
        assert.equal(report.status, 'dismissed');
        assert.equal(report.ip, null);
        assert.equal(ctx.recorded.pendingChanges, 1);
        assert.equal(await repo.reports.countOpen(), 0);
    });
});
