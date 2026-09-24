import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { WebSocketServer } from 'ws';

// Le serveur d'essai écoute sur la boucle locale, que le garde des appels
// sortants refuse par défaut.
import { setAllowPrivateForTest } from '@/Services/netFetch';
import { fetchDeploymentLog, readRepoUrl, webGitUrl } from './dokploy';

/**
 * Le rapatriement d'un journal de déploiement. `/listen-deployment` ne referme
 * jamais la connexion (un `tail -f`, pas un téléchargement) : d'où un serveur
 * réel, un faux client mentirait précisément sur ce point.
 *
 * Puis le décodage du dépôt d'une cible, qui n'a besoin ni de base ni de
 * réseau : ce sont les cas où un lien pourrait être faux ou porter un secret.
 */

let server: Server;
let wss: WebSocketServer;
let port = 0;

/** Ce que la prochaine connexion recevra, et comment. */
let behaviour: { chunks: string[]; gapMs: number; close: boolean } = { chunks: [], gapMs: 0, close: false };

before(async () => {
    setAllowPrivateForTest(true);
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
    setAllowPrivateForTest(false);
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

describe('fetchDeploymentLog : conclure sans fermeture', () => {
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
        // le plus rapide des deux.
        behaviour = { chunks: ['fini'], gapMs: 0, close: true };
        const { log, elapsed } = await fetchLog(20_000);
        assert.equal(log, 'fini');
        assert.ok(elapsed < 900, `rendu en ${elapsed} ms alors que le serveur a fermé`);
    });

    it('rend ce qui est arrivé quand le plafond tombe sur un flux bavard', async () => {
        // Un déploiement EN COURS émet sans discontinuer : le silence n'arrive
        // jamais, et c'est le plafond qui tranche.
        behaviour = { chunks: Array.from({ length: 40 }, (_, i) => `l${i} `), gapMs: 120, close: false };
        const { log, elapsed } = await fetchLog(1_200);
        assert.ok(log.startsWith('l0 '), 'le début du flux doit être rendu');
        assert.ok(elapsed < 3_000, `rendu en ${elapsed} ms, le plafond n'a pas tranché`);
    });
});

describe('webGitUrl : une URL de clone ramenée au web', () => {
    it('lit les trois formes qui mènent au même dépôt', () => {
        assert.equal(webGitUrl('git@github.com:Gerem66/DevEye.git'), 'https://github.com/Gerem66/DevEye');
        assert.equal(webGitUrl('ssh://git@github.com:22/Gerem66/DevEye.git'), 'https://github.com/Gerem66/DevEye');
        assert.equal(webGitUrl('https://github.com/Gerem66/DevEye.git'), 'https://github.com/Gerem66/DevEye');
    });

    it('retire les identifiants portés par l’URL', () => {
        // Une URL de clone en contient parfois un ; il partirait dans un salon.
        assert.equal(
            webGitUrl('https://gerem:ghp_secret@git.exemple.fr/infra/deveye.git'),
            'https://git.exemple.fr/infra/deveye'
        );
    });

    it('garde le port d’un accès web, jamais celui d’un accès SSH', () => {
        assert.equal(webGitUrl('http://git.local:3000/infra/deveye.git'), 'http://git.local:3000/infra/deveye');
        assert.equal(webGitUrl('git@git.local:infra/deveye.git'), 'https://git.local/infra/deveye');
    });

    it('rend null pour ce qui n’a pas de page web', () => {
        assert.equal(webGitUrl(null), null);
        assert.equal(webGitUrl('  '), null);
        assert.equal(webGitUrl('/srv/git/deveye.git'), null);
        assert.equal(webGitUrl('git://git.local/deveye.git'), null);
        assert.equal(webGitUrl('https://github.com'), null);
    });
});

describe('readRepoUrl : le dépôt d’une cible', () => {
    it('assemble le dépôt GitHub à partir du propriétaire et du nom', () => {
        assert.equal(
            readRepoUrl({ sourceType: 'github', owner: 'OxyFoo', repository: 'Pierre', branch: 'main' }),
            'https://github.com/OxyFoo/Pierre'
        );
    });

    it('lit l’URL de clone d’une source git maison', () => {
        assert.equal(
            readRepoUrl({
                sourceType: 'git',
                owner: 'ancien',
                repository: 'ancien',
                customGitUrl: 'git@git.local:infra/deveye.git'
            }),
            'https://git.local/infra/deveye'
        );
    });

    it('ignore les colonnes d’une source abandonnée', () => {
        // Dokploy garde le réglage GitHub d'avant le passage à une image Docker.
        assert.equal(readRepoUrl({ sourceType: 'docker', owner: 'OxyFoo', repository: 'Pierre' }), null);
    });

    it('ne devine ni GitLab ni Gitea', () => {
        // Leur hôte vit sur l'enregistrement du fournisseur, non relevé.
        assert.equal(readRepoUrl({ sourceType: 'gitlab', gitlabOwner: 'infra', gitlabRepository: 'deveye' }), null);
    });

    it('rend null quand rien n’est déclaré', () => {
        // Ce que rend le catalogue : l'identifiant, le nom, l'état, rien d'autre.
        assert.equal(readRepoUrl({ applicationId: 'a1', name: 'server' }), null);
        assert.equal(readRepoUrl({ sourceType: 'github', owner: 'OxyFoo' }), null);
    });
});
