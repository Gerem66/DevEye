import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pointsHere, webCheck, type WebSeam } from './web';

const ORIGIN = 'api.deveye.test';
const HERE = '203.0.113.7';

function seam(over: { addresses?: Record<string, string[]>; handshake?: string | null } = {}): WebSeam {
    const addresses: Record<string, string[]> = { [ORIGIN]: [HERE], 'rdv.exemple.fr': [HERE], ...over.addresses };
    return {
        addresses: (name) => Promise.resolve(addresses[name] ?? []),
        handshake: () => Promise.resolve(over.handshake === undefined ? null : over.handshake)
    };
}

const opts = (over: Partial<{ auto: boolean; verified: boolean }> = {}) => ({
    originHost: ORIGIN,
    auto: true,
    verified: false,
    ...over
});

describe('pointsHere', () => {
    it('suffit d’une adresse commune avec l’origine', async () => {
        const mixed = seam({ addresses: { 'rdv.exemple.fr': ['198.51.100.1', HERE] } });
        assert.equal(await pointsHere('rdv.exemple.fr', ORIGIN, mixed), true);
    });

    it('refuse un nom sans adresse ou qui mène ailleurs', async () => {
        assert.equal(await pointsHere('rien.exemple.fr', ORIGIN, seam()), false);
        const elsewhere = seam({ addresses: { 'rdv.exemple.fr': ['198.51.100.1'] } });
        assert.equal(await pointsHere('rdv.exemple.fr', ORIGIN, elsewhere), false);
    });

    it('prend une origine en adresse IP telle quelle, et ne tranche rien sur une origine illisible', async () => {
        assert.equal(await pointsHere('rdv.exemple.fr', HERE, seam()), true);
        assert.equal(await pointsHere('rdv.exemple.fr', 'localhost', seam({ addresses: { localhost: [] } })), true);
    });
});

describe('webCheck', () => {
    it('laisse passer à la sonde du module un nom qui pointe et répond en HTTPS', async () => {
        assert.equal(await webCheck('rdv.exemple.fr', opts(), seam()), null);
    });

    it('dit que le nom ne pointe pas, sans tenter la poignée de main', async () => {
        let tried = false;
        const lost: WebSeam = {
            ...seam({ addresses: { 'rdv.exemple.fr': [] } }),
            handshake: () => {
                tried = true;
                return Promise.resolve(null);
            }
        };
        const check = await webCheck('rdv.exemple.fr', opts(), lost);
        assert.ok(check && !check.ok && !('pending' in check));
        assert.match(check.error, /ne pointe pas encore/);
        assert.equal(tried, false);
    });

    it('un certificat absent est une attente en automatique, un échec ailleurs', async () => {
        const selfSigned = seam({ handshake: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
        const waiting = await webCheck('rdv.exemple.fr', opts(), selfSigned);
        assert.ok(waiting && !waiting.ok && 'pending' in waiting);

        const manual = await webCheck('rdv.exemple.fr', opts({ auto: false }), selfSigned);
        assert.ok(manual && !manual.ok && !('pending' in manual));
        assert.match(manual.error, /administrateur/);

        const lapsed = await webCheck('rdv.exemple.fr', opts({ verified: true }), selfSigned);
        assert.ok(lapsed && !lapsed.ok && !('pending' in lapsed));
    });

    it('une connexion refusée n’est pas un certificat', async () => {
        const check = await webCheck('rdv.exemple.fr', opts(), seam({ handshake: 'ECONNREFUSED' }));
        assert.ok(check && !check.ok && !('pending' in check));
        assert.match(check.error, /répond pas en HTTPS/);
    });
});
