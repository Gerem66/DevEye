import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { Database } from '../db';
import { acquireLease, INSTANCE_ID, LEASE_TTL_S, releaseLease, renewLease } from './lease';

/**
 * Le bail a déjà rendu la fonctionnalité inutilisable en production : un
 * conteneur tué net (SIGKILL, OOM, dépassement du délai de grâce Docker) laisse
 * son bail en base, et le processus suivant refusait de démarrer le moteur.
 * Ces cas figent la règle : un redémarrage AU MÊME ENDROIT reprend toujours la
 * main, immédiatement.
 */

/** Un `syncMeta` en mémoire : c'est la seule dépendance du bail. */
function fakeDb(initial: string | null = null) {
    let stored = initial;
    return {
        value: () => stored,
        db: {
            syncMeta: {
                get: async (): Promise<string | null> => stored,
                set: async (_k: string, v: string): Promise<void> => {
                    stored = v;
                }
            }
        } as unknown as Database
    };
}

/** Un bail laissé par un AUTRE emplacement, renouvelé il y a `ageS` secondes. */
const foreignLease = (ageS: number): string =>
    JSON.stringify({
        instanceId: 'un-autre-emplacement-entierement-different',
        renewedAt: Math.floor(Date.now() / 1000) - ageS
    });

/** Un bail laissé par CE même emplacement (redémarrage sans arrêt propre). */
const ownLease = (ageS: number): string =>
    JSON.stringify({ instanceId: INSTANCE_ID, renewedAt: Math.floor(Date.now() / 1000) - ageS });

describe('bail CloudSync', () => {
    let store: ReturnType<typeof fakeDb>;
    beforeEach(() => {
        store = fakeDb();
    });

    it('se prend sans difficulté quand rien ne le tient', async () => {
        assert.equal(await acquireLease(store.db), true);
    });

    it('reprend IMMÉDIATEMENT son propre bail après un arrêt brutal', async () => {
        // LE cas qui a cassé la production : SIGKILL, donc aucun arrêt propre,
        // donc le bail est resté frais en base. Redémarrer au même endroit ne
        // doit pas attendre son expiration.
        const brutal = fakeDb(ownLease(1));
        assert.equal(await acquireLease(brutal.db), true);
    });

    it('refuse un bail frais tenu par un autre emplacement', async () => {
        const other = fakeDb(foreignLease(1));
        assert.equal(await acquireLease(other.db), false);
    });

    it('reprend un bail étranger devenu périmé', async () => {
        // L'instance a changé d'endroit (nouvel hôte, nouveau conteneur) : c'est
        // le TTL qui rattrape, et il doit vraiment rattraper.
        const abandoned = fakeDb(foreignLease(LEASE_TTL_S + 1));
        assert.equal(await acquireLease(abandoned.db), true);
    });

    it('tolère une valeur illisible plutôt que de rester bloqué', async () => {
        for (const junk of ['', 'pas du json', '{}', '{"instanceId":42}']) {
            const broken = fakeDb(junk);
            assert.equal(await acquireLease(broken.db), true, `devrait reprendre sur ${JSON.stringify(junk)}`);
        }
    });

    it('libère le bail à l’arrêt propre, et seulement le sien', async () => {
        await acquireLease(store.db);
        await releaseLease(store.db);
        assert.equal(store.value(), '');

        const other = fakeDb(foreignLease(1));
        await releaseLease(other.db);
        assert.notEqual(other.value(), '', 'ne doit jamais libérer le bail d’un autre');
    });

    it('perd le renouvellement quand un autre a pris la main', async () => {
        await acquireLease(store.db);
        assert.equal(await renewLease(store.db), true);

        const stolen = fakeDb(foreignLease(0));
        assert.equal(await renewLease(stolen.db), false);
    });
});
