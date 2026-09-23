import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { effectiveStatus, type StatusInput } from './status';

const TODAY = '2026-09-22';

function doc(over: Partial<StatusInput> = {}): StatusInput {
    return {
        kind: 'invoice',
        status: 'issued',
        dueOn: '2026-10-22',
        validUntil: null,
        grossCents: 120_000,
        settledCents: 0,
        sentAt: null,
        ...over
    };
}

describe('effectiveStatus, une facture', () => {
    it('est à payer quand rien n’est réglé et que l’échéance vient', () => {
        assert.equal(effectiveStatus(doc(), TODAY), 'issued');
    });

    it('est payée en partie', () => {
        assert.equal(effectiveStatus(doc({ settledCents: 50_000 }), TODAY), 'partial');
    });

    it('est payée au centime près', () => {
        assert.equal(effectiveStatus(doc({ settledCents: 120_000 }), TODAY), 'paid');
        assert.equal(effectiveStatus(doc({ settledCents: 119_999 }), TODAY), 'partial');
    });

    it('est en retard passé l’échéance', () => {
        assert.equal(effectiveStatus(doc({ dueOn: '2026-09-21' }), TODAY), 'late');
    });

    it('n’est pas en retard le jour de l’échéance', () => {
        assert.equal(effectiveStatus(doc({ dueOn: TODAY }), TODAY), 'issued');
    });

    it('payée hier n’est plus en retard aujourd’hui', () => {
        assert.equal(effectiveStatus(doc({ dueOn: '2026-08-01', settledCents: 120_000 }), TODAY), 'paid');
    });

    it('en retard et payée en partie dit le retard, qui est ce qui presse', () => {
        assert.equal(effectiveStatus(doc({ dueOn: '2026-08-01', settledCents: 50_000 }), TODAY), 'late');
    });

    it('annulée le reste, quoi qu’il arrive par ailleurs', () => {
        assert.equal(
            effectiveStatus(doc({ status: 'cancelled', dueOn: '2026-01-01', settledCents: 0 }), TODAY),
            'cancelled'
        );
    });

    it('reste un brouillon tant qu’elle n’est pas émise', () => {
        assert.equal(effectiveStatus(doc({ status: 'draft', grossCents: null, dueOn: null }), TODAY), 'draft');
    });

    it('à zéro euro ne se dit pas payée toute seule', () => {
        assert.equal(effectiveStatus(doc({ grossCents: 0, settledCents: 0 }), TODAY), 'issued');
    });
});

describe('effectiveStatus, un devis', () => {
    const quote = (over: Partial<StatusInput> = {}) =>
        doc({ kind: 'quote', status: 'sent', dueOn: null, validUntil: '2026-10-22', ...over });

    it('est émis tant que rien n’est parti par mail', () => {
        assert.equal(effectiveStatus(quote(), TODAY), 'issued');
    });

    it('n’est envoyé qu’une fois le mail parti', () => {
        assert.equal(effectiveStatus(quote({ sentAt: 1_700_000_000 }), TODAY), 'sent');
    });

    it('expire le lendemain de sa validité', () => {
        assert.equal(effectiveStatus(quote({ validUntil: TODAY }), TODAY), 'issued');
        assert.equal(effectiveStatus(quote({ validUntil: '2026-09-21' }), TODAY), 'expired');
    });

    it('expiré l’emporte sur envoyé', () => {
        assert.equal(effectiveStatus(quote({ validUntil: '2026-09-21', sentAt: 1_700_000_000 }), TODAY), 'expired');
    });

    it('accepté ou refusé l’emporte sur l’expiration', () => {
        assert.equal(effectiveStatus(quote({ status: 'accepted', validUntil: '2026-01-01' }), TODAY), 'accepted');
        assert.equal(effectiveStatus(quote({ status: 'declined', validUntil: '2026-01-01' }), TODAY), 'declined');
    });

    it('ne se dit jamais payé, même avec un total', () => {
        assert.equal(effectiveStatus(quote({ settledCents: 120_000 }), TODAY), 'issued');
    });
});

describe('effectiveStatus, un avoir', () => {
    it('est émis, et rien d’autre : il ne s’encaisse pas', () => {
        const credit = doc({ kind: 'credit', dueOn: '2026-01-01', settledCents: 0 });
        assert.equal(effectiveStatus(credit, TODAY), 'issued');
    });
});
