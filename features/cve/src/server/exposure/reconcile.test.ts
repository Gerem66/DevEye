import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FindingDraft } from '../matching/match';
import { reconcile, type ExistingFinding } from './reconcile';

/**
 * Ce qui décide d'une alerte : un constat neuf, un constat qui revient, une
 * décision d'ignorer qui ne couvre pas un élément touché depuis, et un
 * catalogue muet qui ne fait rien disparaître.
 */

function draft(subjectKey: string, assets: number[], over: Partial<FindingDraft> = {}): FindingDraft {
    return {
        kind: 'vuln',
        origin: 'osv',
        subjectKey,
        advisoryId: 'CVE-2020-8203',
        severity: 'high',
        score: 7.4,
        content: {
            title: 'lodash : pollution de prototype',
            summary: '',
            subject: { kind: 'package', ecosystem: 'npm', name: 'lodash' },
            fixed: ['4.17.21'],
            reference: null,
            aliases: [],
            affected: assets.map((assetId) => ({ assetId, version: '4.17.20', path: 'package-lock.json', line: null }))
        },
        ...over
    };
}

function existing(id: number, subjectKey: string, over: Partial<ExistingFinding> = {}): ExistingFinding {
    return {
        id,
        kind: 'vuln',
        subjectKey,
        origin: 'osv',
        state: 'open',
        severity: 'high',
        score: 7.4,
        links: new Map([[1, false]]),
        ...over
    };
}

describe('reconcile', () => {
    it('ouvre ce qui est neuf et résout ce qui ne touche plus rien', () => {
        const ops = reconcile([existing(5, 'old')], [draft('new', [1])], {});
        assert.deepEqual(
            ops.map((o) => o.type),
            ['insert', 'resolve']
        );
    });

    it('laisse en paix un constat inchangé', () => {
        const [op] = reconcile([existing(5, 'k')], [draft('k', [1])], {});
        assert.equal(op.type, 'update');
        assert.equal(op.type === 'update' && op.significant, false);
    });

    it('rouvre un constat résolu qui revient', () => {
        const [op] = reconcile([existing(5, 'k', { state: 'resolved', links: new Map() })], [draft('k', [1])], {});
        assert.ok(op.type === 'update' && op.reopened && op.state === 'open');
    });

    it('garde ignoré ce que la décision a vu, rouvre pour un élément touché depuis', () => {
        const ignored = existing(5, 'k', { state: 'ignored', links: new Map([[1, true]]) });
        const [same] = reconcile([ignored], [draft('k', [1])], {});
        assert.ok(same.type === 'update' && same.state === 'ignored' && !same.reopened);
        assert.deepEqual(same.type === 'update' && same.covered, [1]);
        const [wider] = reconcile([ignored], [draft('k', [1, 2])], {});
        assert.ok(wider.type === 'update' && wider.state === 'open' && wider.reopened);
    });

    it('ne résout rien de ce qu’un catalogue muet a établi', () => {
        const ops = reconcile([existing(5, 'osv-k'), existing(6, 'nvd-k', { origin: 'nvd' })], [], {
            osv: 'OSV ne répond pas.'
        });
        assert.deepEqual(ops, [{ type: 'resolve', id: 6 }]);
    });
});
