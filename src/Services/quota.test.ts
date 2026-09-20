import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ACCOUNT_PLAN_PROVIDER, type AccountPlan } from '@deveye/types/sdk';

import { limitIn, planOf } from './quota';

const logger = { error: () => undefined };
const FREE: AccountPlan = { id: 'free', label: 'Gratuite', limits: { 'uptime.monitors': 5 } };

const providers = (planFor?: () => Promise<AccountPlan>) => ({
    get: <T>(key: string) => (key === ACCOUNT_PLAN_PROVIDER && planFor ? ({ planFor } as T) : undefined)
});

describe("l'offre d'un compte", () => {
    it('est absente, donc sans limite, quand aucun module ne la fournit', async () => {
        const plan = await planOf(providers(), 1, logger);
        assert.equal(plan, null);
        assert.equal(limitIn(plan, 'uptime.monitors'), null);
    });

    it('borne les clés qu’elle nomme et laisse les autres illimitées', async () => {
        const plan = await planOf(
            providers(() => Promise.resolve(FREE)),
            1,
            logger
        );
        assert.equal(limitIn(plan, 'uptime.monitors'), 5);
        assert.equal(limitIn(plan, 'notes.items'), null);
    });

    it('ne bloque rien quand le fournisseur tombe', async () => {
        const plan = await planOf(
            providers(() => Promise.reject(new Error('facturation injoignable'))),
            1,
            logger
        );
        assert.equal(plan, null);
    });
});
