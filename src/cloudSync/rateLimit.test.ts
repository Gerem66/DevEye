import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { makeBucket, TokenBucket } from './rateLimit';

describe('TokenBucket', () => {
    it('laisse passer sans attendre tant qu’il reste du crédit', async () => {
        const bucket = new TokenBucket(1_000_000);
        const started = Date.now();
        await bucket.take(500_000);
        assert.ok(Date.now() - started < 50, 'le premier envoi ne doit pas être retardé');
    });

    it('ralentit une fois le crédit épuisé', async () => {
        // Seau d'une seconde de crédit : le deuxième envoi doit attendre.
        const bucket = new TokenBucket(100_000);
        await bucket.take(100_000);
        const started = Date.now();
        await bucket.take(50_000);
        assert.ok(Date.now() - started >= 200, 'le débit doit être effectivement bridé');
    });

    it('laisse passer un bloc plus gros que le débit par seconde', async () => {
        // Sinon un chunk de 256 Ko sous une limite de 100 Ko/s bloquerait POUR
        // TOUJOURS : il ne pourrait jamais réunir assez de crédit.
        const bucket = new TokenBucket(50_000);
        await bucket.take(50_000);
        const started = Date.now();
        await bucket.take(200_000);
        assert.ok(Date.now() - started < 3_000, 'un gros bloc doit finir par passer');
    });

    it('n’accumule pas plus d’une seconde de crédit', async () => {
        const bucket = new TokenBucket(10_000);
        await new Promise((r) => setTimeout(r, 300));
        // Après une pause, la rafale autorisée reste bornée au seau : un partage
        // inactif ne doit pas saturer le lien à la reprise.
        await bucket.take(10_000);
        const started = Date.now();
        await bucket.take(10_000);
        assert.ok(Date.now() - started >= 500, 'le crédit ne doit pas s’être accumulé');
    });

    it('makeBucket rend null quand aucune limite n’est réglée', () => {
        assert.equal(makeBucket(null), null);
        assert.equal(makeBucket(0), null);
        assert.ok(makeBucket(1_000) instanceof TokenBucket);
    });
});
