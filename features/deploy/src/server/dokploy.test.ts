import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { WebSocketServer } from 'ws';

import { fetchDeploymentLog } from './dokploy';

/**
 * Le rapatriement d'un journal de déploiement.
 *
 * Ce test existe pour un défaut précis, coûteux et invisible : `/listen-deployment`
 * **ne referme jamais** la connexion. C'est un `tail -f`, pas un téléchargement.
 * Le code d'origine attendait la fermeture, plafonnée à trente secondes — le
 * journal était donc complet en deux dixièmes de seconde et la popup restait à
 * « Chargement… » une demi-minute, sans que rien n'échoue ni ne s'affiche dans
 * un journal d'erreurs.
 *
 * Rien ne l'aurait signalé : le résultat était juste, seul le délai était absurde.
 * D'où un serveur réel — un faux client mentirait précisément sur le point qui
 * compte, à savoir que personne ne ferme.
 */

let server: Server;
let wss: WebSocketServer;
let port = 0;

/** Ce que la prochaine connexion recevra, et comment. */
let behaviour: { chunks: string[]; gapMs: number; close: boolean } = { chunks: [], gapMs: 0, close: false };

before(async () => {
    server = createServer();
    wss = new WebSocketServer({ server });
    wss.on('connection', async (socket) => {
        for (const chunk of behaviour.chunks) {
            socket.send(chunk);
            if (behaviour.gapMs > 0) await new Promise((r) => setTimeout(r, behaviour.gapMs));
        }
        if (behaviour.close) socket.close();
        // Sinon : on ne ferme pas. C'est le comportement réel de Dokploy.
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
});

after(async () => {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

function fetchLog(timeoutMs: number): Promise<{ log: string; elapsed: number }> {
    const started = Date.now();
    return fetchDeploymentLog(`http://127.0.0.1:${port}`, 'clé', '/un/chemin', { timeoutMs }).then((log) => ({
        log,
        elapsed: Date.now() - started
    }));
}

describe('fetchDeploymentLog — conclure sans fermeture', () => {
    it('rend le journal sans attendre le plafond quand le serveur ne ferme pas', async () => {
        // LE cas réel. Sans la conclusion au repos, ceci prendrait 20 s.
        behaviour = { chunks: ['ligne 1\n', 'ligne 2\n'], gapMs: 0, close: false };
        const { log, elapsed } = await fetchLog(20_000);
        assert.equal(log, 'ligne 1\nligne 2\n');
        assert.ok(elapsed < 5_000, `rendu en ${elapsed} ms, le repos n'a pas conclu`);
    });

    it('réarme le repos à chaque trame, sans tronquer', async () => {
        // Un journal qui arrive en plusieurs morceaux espacés ne doit pas être
        // coupé au premier silence : c'est le dernier qui compte.
        behaviour = { chunks: ['a', 'b', 'c'], gapMs: 400, close: false };
        const { log } = await fetchLog(20_000);
        assert.equal(log, 'abc');
    });

    it('respecte encore une fermeture, quand elle vient', async () => {
        // Une autre version de Dokploy pourrait fermer : ce chemin doit rester
        // le plus rapide des deux, pas être remplacé par l'attente du repos.
        behaviour = { chunks: ['fini'], gapMs: 0, close: true };
        const { log, elapsed } = await fetchLog(20_000);
        assert.equal(log, 'fini');
        assert.ok(elapsed < 900, `rendu en ${elapsed} ms alors que le serveur a fermé`);
    });

    it('rend ce qui est arrivé quand le plafond tombe sur un flux bavard', async () => {
        // Un déploiement EN COURS émet sans discontinuer : le silence n'arrive
        // jamais, et c'est le plafond qui tranche. Le suivi vivant en dépend —
        // il prend la température du journal sans y passer plus de trois secondes.
        behaviour = { chunks: Array.from({ length: 40 }, (_, i) => `l${i} `), gapMs: 120, close: false };
        const { log, elapsed } = await fetchLog(1_200);
        assert.ok(log.startsWith('l0 '), 'le début du flux doit être rendu');
        assert.ok(elapsed < 3_000, `rendu en ${elapsed} ms, le plafond n'a pas tranché`);
    });
});
