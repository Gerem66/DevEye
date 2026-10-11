import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { refreshVerdict, ROTATION_GRACE_SECONDS } from './session';

/** Les jetons d'une session, en mémoire, avec la règle du vrai dépôt. */
function tokens() {
    const rows = new Map<string, { sid: string; revokedAt: number | null }>();
    const now = () => Math.floor(Date.now() / 1000);
    return {
        rows,
        issue: (jti: string, sid = 's') => rows.set(jti, { sid, revokedAt: null }),
        revoke: (jti: string) => {
            const row = rows.get(jti);
            if (row && row.revokedAt === null) row.revokedAt = now();
        },
        revokeSession: (sid: string) => {
            for (const row of rows.values()) if (row.sid === sid && row.revokedAt === null) row.revokedAt = now();
        },
        isValid: async (jti: string) => rows.get(jti)?.revokedAt === null,
        wasRecentlyRotated: async (jti: string, _token: string, grace: number) => {
            const at = rows.get(jti)?.revokedAt;
            return at !== undefined && at !== null && now() - at <= grace;
        },
        hasLiveSession: async (sid: string) => [...rows.values()].some((r) => r.sid === sid && r.revokedAt === null)
    };
}

const verdict = (repo: ReturnType<typeof tokens>, jti: string) => refreshVerdict(repo, { jti, sid: 's' }, 't');

describe('refreshVerdict', () => {
    it('fait tourner le jeton actif, et tolère son prédécesseur tant que la session vit', async () => {
        const repo = tokens();
        repo.issue('r1');
        assert.equal(await verdict(repo, 'r1'), 'rotate');
        repo.issue('r2');
        repo.revoke('r1');
        assert.equal(await verdict(repo, 'r1'), 'grace');
        assert.ok(ROTATION_GRACE_SECONDS > 0);
    });

    it('ne rend jamais une session révoquée entière, même dans la fenêtre', async () => {
        const repo = tokens();
        repo.issue('r1');
        // Un changement de mot de passe révoque tout : le client de l'attaquant
        // rafraîchit aussitôt, dans la fenêtre.
        repo.revokeSession('s');
        assert.equal(await verdict(repo, 'r1'), 'reuse');
    });

    it('après une réutilisation détectée, le jeton du voleur ne passe plus', async () => {
        const repo = tokens();
        repo.issue('r1');
        repo.issue('r2');
        repo.revoke('r1');
        // La victime présente r1 hors fenêtre : la session est révoquée.
        repo.revokeSession('s');
        assert.equal(await verdict(repo, 'r2'), 'reuse');
    });
});
