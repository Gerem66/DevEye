import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
    beginExport,
    endExport,
    EXPORT_TICKET_MS,
    issueExportTicket,
    redeemExportTicket,
    resetExportTicketsForTest,
    type ExportTicket
} from './tickets';

const base = { userId: 7, sessionId: 's1', leaveOut: [], dekToken: 'd1' };

afterEach(resetExportTicketsForTest);

describe('le lien d’un export', () => {
    it('ne sert qu’une fois', () => {
        const dropped: string[] = [];
        const { token } = issueExportTicket(base, (t) => dropped.push(t.dekToken), 1000);
        assert.equal(redeemExportTicket(token, () => undefined, 1001)?.userId, 7);
        assert.equal(
            redeemExportTicket(token, () => undefined, 1002),
            null
        );
        assert.deepEqual(dropped, []);
    });

    it('meurt après cinq minutes, et rend sa clé', () => {
        const dropped: ExportTicket[] = [];
        const { token, expiresAt } = issueExportTicket(base, (t) => dropped.push(t), 1000);
        assert.equal(expiresAt, 1000 + EXPORT_TICKET_MS);
        assert.equal(
            redeemExportTicket(token, (t) => dropped.push(t), expiresAt),
            null
        );
        assert.deepEqual(
            dropped.map((t) => t.dekToken),
            ['d1']
        );
    });

    it('remplace le lien précédent du même compte, pas celui d’un autre', () => {
        const dropped: string[] = [];
        const first = issueExportTicket(base, (t) => dropped.push(t.dekToken), 1000);
        const other = issueExportTicket({ ...base, userId: 8, dekToken: 'd8' }, (t) => dropped.push(t.dekToken), 1000);
        issueExportTicket({ ...base, dekToken: 'd2' }, (t) => dropped.push(t.dekToken), 1001);
        assert.deepEqual(dropped, ['d1']);
        assert.equal(
            redeemExportTicket(first.token, () => undefined, 1002),
            null
        );
        assert.equal(redeemExportTicket(other.token, () => undefined, 1002)?.userId, 8);
    });

    it('un export à la fois par compte, trois en tout', () => {
        assert.equal(beginExport(1), true);
        assert.equal(beginExport(1), false);
        assert.equal(beginExport(2), true);
        assert.equal(beginExport(3), true);
        assert.equal(beginExport(4), false);
        endExport(1);
        assert.equal(beginExport(4), true);
    });
});
