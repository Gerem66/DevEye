import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { signAccessToken, signWsTicket } from './jwt';
import { redeemWsTicket } from './wsTicket';

describe('wsTicket', () => {
    it('ne sert qu’une fois', async () => {
        const ticket = await signWsTicket(7, 'sid-1');
        assert.deepEqual(await redeemWsTicket(ticket), { sub: '7', sid: 'sid-1' });
        assert.equal(await redeemWsTicket(ticket), null);
    });

    it('refuse un jeton d’accès présenté comme ticket', async () => {
        assert.equal(await redeemWsTicket(await signAccessToken(7, 'sid-1')), null);
    });
});
