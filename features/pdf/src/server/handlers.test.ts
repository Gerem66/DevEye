import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { z, ZodType } from 'zod';

import { FeatureError, type SdkFeatureContext } from '@deveye/types/sdk/server';
import { createTestContext, type TestContextOverrides } from '@deveye/types/sdk/testing';

import { pdfPrefs, pdfPrefsSet, pdfSignatureRemove, pdfSignatures, pdfSignatureSave } from '../contracts/commands';
import { DEFAULT_PREFS, type Prefs } from '../contracts/prefs';
import { SIGNATURES_MAX } from '../contracts/signatures';
import { pdfHandlers } from './handlers';
import type { PdfRepo } from './repo';
import { memoryRepo } from './testing';

function handlerFor<C extends { command: string; input: ZodType; output: ZodType }>(contract: C) {
    const def = pdfHandlers.find((h) => h.command === contract.command);
    assert.ok(def, `handler ${contract.command} manquant`);
    return def.handler as (
        ctx: SdkFeatureContext<PdfRepo>,
        input: z.output<C['input']>
    ) => Promise<z.input<C['output']>>;
}

const context = (repo: PdfRepo, over: TestContextOverrides<PdfRepo> = {}) => createTestContext({ repo, ...over });

describe('signatures gardées', () => {
    const drawn = {
        role: 'signature' as const,
        data: { kind: 'path' as const, path: 'M 0 0 L 10 10', width: 10, height: 10, stroke: 2 }
    };

    it('garde, relit déchiffré, et ne montre à un compte que les siennes', async () => {
        const repo = memoryRepo();
        const mine = context(repo);
        const { signature } = await handlerFor(pdfSignatureSave)(mine, drawn);
        const listed = await handlerFor(pdfSignatures)(mine, {});
        assert.deepEqual(
            listed.signatures.map((s) => s.id),
            [signature.id]
        );
        assert.deepEqual(listed.signatures[0].data, drawn.data);
        const other = context(repo, { userId: 2 });
        assert.equal((await handlerFor(pdfSignatures)(other, {})).signatures.length, 0);
        assert.deepEqual(await handlerFor(pdfSignatureRemove)(other, { id: signature.id }), { removed: false });
        assert.deepEqual(await handlerFor(pdfSignatureRemove)(mine, { id: signature.id }), { removed: true });
    });

    it('en garde six au plus', async () => {
        const repo = memoryRepo();
        const ctx = context(repo);
        for (let i = 0; i < SIGNATURES_MAX; i++) await handlerFor(pdfSignatureSave)(ctx, drawn);
        await assert.rejects(
            handlerFor(pdfSignatureSave)(ctx, drawn),
            (e: unknown) => e instanceof FeatureError && e.code === 'conflict'
        );
    });
});

describe('réglages du compte', () => {
    it('vaut les défauts tant que rien n’est écrit, puis ce qui a été écrit', async () => {
        const ctx = context(memoryRepo());
        assert.deepEqual(await handlerFor(pdfPrefs)(ctx, {}), { prefs: DEFAULT_PREFS });
        const prefs: Prefs = { inks: ['#ff8000', null, '#123456'], signature: 4, initials: null, thumbs: 'large' };
        await handlerFor(pdfPrefsSet)(ctx, { prefs });
        assert.deepEqual(await handlerFor(pdfPrefs)(ctx, {}), { prefs });
    });
});
