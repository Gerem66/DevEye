import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fakeQueryable } from '../pool.fake';
import { twoFactorRepo } from './twoFactor';

/**
 * La double authentification : les codes de secours se remplacent en bloc,
 * et un code ou un pas TOTP ne se consomme qu'une fois, le refus venant du
 * nombre de lignes touchées et de rien d'autre.
 */

describe('les codes de secours', () => {
    it('efface les anciens puis insère les nouveaux d’un coup, chacun lié à son compte', async () => {
        const q = fakeQueryable();
        await twoFactorRepo(q).replaceBackupCodes(7, ['a', 'b', 'c']);
        const [purge, insert] = q.queries;
        assert.match(purge!.sql, /^DELETE FROM user_2fa_backup_codes WHERE user_id = \?$/);
        assert.deepEqual(purge!.params, [7]);
        assert.equal(q.queries.length, 2);
        assert.match(insert!.sql, /VALUES \(\?, \?\), \(\?, \?\), \(\?, \?\)$/);
        assert.deepEqual(insert!.params, [7, 'a', 7, 'b', 7, 'c']);
    });

    it('n’insère rien sur une liste vide, mais efface quand même', async () => {
        const q = fakeQueryable();
        await twoFactorRepo(q).replaceBackupCodes(7, []);
        assert.equal(q.queries.length, 1);
        assert.match(q.queries[0]!.sql, /^DELETE/);
    });

    it('ne brûle un code qu’une fois : la seconde tentative ne touche aucune ligne', async () => {
        assert.equal(await twoFactorRepo(fakeQueryable(() => ({ rowCount: 1 }))).markBackupCodeUsed(3), true);
        assert.equal(await twoFactorRepo(fakeQueryable(() => ({ rowCount: 0 }))).markBackupCodeUsed(3), false);
    });
});

describe('le pas TOTP', () => {
    it('n’avance que strictement, le compteur lié deux fois', async () => {
        const q = fakeQueryable(() => ({ rowCount: 1 }));
        assert.equal(await twoFactorRepo(q).claimTotpCounter(7, 42), true);
        assert.match(q.queries[0]!.sql, /last_used_counter IS NULL OR last_used_counter < \?/);
        assert.deepEqual(q.queries[0]!.params, [42, 7, 42]);
    });

    it('refuse un pas déjà pris, par un rejeu ou une soumission parallèle', async () => {
        const q = fakeQueryable(() => ({ rowCount: 0 }));
        assert.equal(await twoFactorRepo(q).claimTotpCounter(7, 42), false);
    });
});
