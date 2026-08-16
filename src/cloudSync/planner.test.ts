import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SyncDeviceFileRow, SyncEntryKind, SyncFileRow, SyncIndexEntry } from 'deveye-types';
import { SYNC_DIR_HASH, SYNC_MTIME_SKEW_MS } from 'deveye-types';
import { planSession } from './planner';

/**
 * Le planner est la seule pièce PURE de CloudSync, et celle dont dépend
 * l'invariant « aucune donnée perdue, aucune donnée dupliquée ». C'est donc là
 * que la couverture a le plus de valeur : chaque cas ci-dessous correspond à un
 * scénario qui, mal traité, ferait diverger ou perdre des fichiers.
 */

const H = {
    a: 'a'.repeat(64),
    b: 'b'.repeat(64),
    c: 'c'.repeat(64)
};

function device(relPath: string, hash: string, extra: Partial<SyncIndexEntry> = {}): SyncIndexEntry {
    return { relPath, kind: 'file', hash, size: 10, mtime: 1_000, mode: null, ...extra };
}

function base(relPath: string, hash: string, extra: Partial<SyncDeviceFileRow> = {}): SyncDeviceFileRow {
    return {
        id: 1,
        share_id: 1,
        device_id: 'd',
        rel_path: relPath,
        rel_path_hash: relPath,
        kind: 'file' as SyncEntryKind,
        hash,
        size: 10,
        mtime: 1_000,
        mode: null,
        synced_at: 0,
        ...extra
    };
}

function server(relPath: string, hash: string, extra: Partial<SyncFileRow> = {}): SyncFileRow {
    return {
        id: 1,
        share_id: 1,
        rel_path: relPath,
        rel_path_hash: relPath,
        kind: 'file' as SyncEntryKind,
        hash,
        size: 10,
        mtime: 1_000,
        mode: null,
        source_device_id: null,
        state: 'present',
        created: 0,
        updated: 0,
        ...extra
    };
}

const paths = (files: { relPath: string }[]): string[] => files.map((f) => f.relPath).sort();

describe('planSession — anti-perte', () => {
    it('ne déduit JAMAIS de suppression sans baseline (premier sync = merge pur)', () => {
        // L'appareil a x, le serveur a y, aucune baseline : rien ne doit
        // disparaître d'aucun côté. C'est le scénario « un appareil arrive
        // après » — il ne doit surtout pas écraser le cloud avec son état.
        const plan = planSession([device('x.txt', H.a)], [], [server('y.txt', H.b)]);
        assert.deepEqual(paths(plan.uploads), ['x.txt']);
        assert.deepEqual(paths(plan.downloads), ['y.txt']);
        assert.equal(plan.deleteOnServer.length, 0);
        assert.equal(plan.deleteOnDevice.length, 0);
    });

    it('traite en conflit un fichier divergent sans baseline, sans rien détruire', () => {
        const plan = planSession([device('x.txt', H.a)], [], [server('x.txt', H.b)]);
        assert.equal(plan.conflicts.length, 1);
        assert.equal(plan.deleteOnServer.length, 0);
        assert.equal(plan.deleteOnDevice.length, 0);
    });

    it('ressuscite un fichier modifié localement après une suppression serveur', () => {
        // Le serveur a marqué le chemin supprimé, mais l'appareil l'a retouché
        // depuis : le contenu remonte au lieu d'être détruit.
        const plan = planSession(
            [device('x.txt', H.c)],
            [base('x.txt', H.a)],
            [server('x.txt', H.a, { state: 'deleted' })]
        );
        assert.deepEqual(paths(plan.uploads), ['x.txt']);
        assert.equal(plan.deleteOnDevice.length, 0);
    });

    it('propage une suppression serveur quand l’appareil n’a pas touché au fichier', () => {
        const plan = planSession(
            [device('x.txt', H.a)],
            [base('x.txt', H.a)],
            [server('x.txt', H.a, { state: 'deleted' })]
        );
        assert.deepEqual(paths(plan.deleteOnDevice), ['x.txt']);
        assert.equal(plan.uploads.length, 0);
    });

    it('arbitre un conflit par mtime avec la tolérance, serveur gagnant à égalité', () => {
        const older = planSession(
            [device('x.txt', H.a, { mtime: 1_000 })],
            [base('x.txt', H.c)],
            [server('x.txt', H.b, { mtime: 1_000 })]
        );
        assert.equal(older.conflicts[0].winner, 'server');

        const newer = planSession(
            [device('x.txt', H.a, { mtime: 1_000 + SYNC_MTIME_SKEW_MS + 1 })],
            [base('x.txt', H.c)],
            [server('x.txt', H.b, { mtime: 1_000 })]
        );
        assert.equal(newer.conflicts[0].winner, 'device');
    });
});

describe('planSession — dossiers vides', () => {
    const dirEntry = (relPath: string): SyncIndexEntry => device(relPath, SYNC_DIR_HASH, { kind: 'dir', size: 0 });
    const dirRow = (relPath: string): SyncFileRow => server(relPath, SYNC_DIR_HASH, { kind: 'dir', size: 0 });

    it('propage un dossier vide créé sur un appareil', () => {
        const plan = planSession([dirEntry('vide')], [], []);
        assert.deepEqual(paths(plan.uploads), ['vide']);
        assert.equal(plan.uploads[0].kind, 'dir');
    });

    it('ne supprime PAS un dossier indexé qui vient de recevoir un fichier', () => {
        // LE piège. Le scan ne remonte plus `docs` comme dossier vide (il a un
        // fichier dedans), et la règle « présent serveur + absent appareil +
        // baseline concordante » conclurait à tort à une suppression — qui se
        // propagerait ensuite au dossier PEUPLÉ des autres appareils.
        const plan = planSession(
            [device('docs/note.txt', H.a)],
            [base('docs', SYNC_DIR_HASH, { kind: 'dir', size: 0 })],
            [dirRow('docs')]
        );
        assert.equal(plan.deleteOnServer.length, 0);
        assert.equal(plan.deleteOnDevice.length, 0);
        assert.deepEqual(paths(plan.uploads), ['docs/note.txt']);
    });

    it('refuse de fusionner un dossier et un fichier de même chemin', () => {
        const plan = planSession([device('x', H.a)], [], [dirRow('x')]);
        assert.equal(plan.skipped.length, 1);
        assert.equal(plan.uploads.length + plan.downloads.length + plan.conflicts.length, 0);
    });
});

describe('planSession — permissions', () => {
    it('propage un chmod sans aucun transfert', () => {
        const plan = planSession(
            [device('run.sh', H.a, { mode: 0o755 })],
            [base('run.sh', H.a, { mode: 0o644 })],
            [server('run.sh', H.a, { mode: 0o644 })]
        );
        assert.equal(plan.uploads.length + plan.downloads.length, 0);
        assert.deepEqual(
            plan.modeChanges.map((c) => [c.target, c.mode]),
            [['server', 0o755]]
        );
    });

    it('ne pousse RIEN vers un appareil sans notion de permissions', () => {
        // Un agent Windows annonce toujours `mode: null`. Lui envoyer le mode
        // serveur rejouerait le même ordre à chaque session, pour toujours, un
        // aller-retour par fichier. Le mode reste conservé côté serveur, ce qui
        // suffit à le rendre aux machines Unix.
        const plan = planSession(
            [device('run.sh', H.a, { mode: null })],
            [base('run.sh', H.a, { mode: null })],
            [server('run.sh', H.a, { mode: 0o755 })]
        );
        assert.deepEqual(plan.modeChanges, []);
        assert.equal(plan.filesTotal, 0, 'une session Windows sur un partage à jour ne fait RIEN');
    });
});

describe('planSession — collisions', () => {
    it('écarte deux chemins qui ne diffèrent que par la casse', () => {
        const plan = planSession([device('Foo.txt', H.a), device('foo.txt', H.b)], [], []);
        assert.equal(plan.skipped.length, 2);
        assert.equal(plan.uploads.length, 0);
    });

    it('ne voit pas de collision sur un chemin simplement déjà synchronisé', () => {
        const plan = planSession([device('Foo.txt', H.a)], [base('Foo.txt', H.a)], [server('Foo.txt', H.a)]);
        assert.equal(plan.skipped.length, 0);
    });
});

describe('planSession — déplacements', () => {
    it('voit un renommage comme une suppression + un ajout du MÊME contenu', () => {
        // C'est ce qui permet à la session de reconnaître un déplacement : même
        // hash des deux côtés, donc ni octet transféré ni version archivée.
        const plan = planSession([device('nouveau.txt', H.a)], [base('ancien.txt', H.a)], [server('ancien.txt', H.a)]);
        assert.deepEqual(paths(plan.uploads), ['nouveau.txt']);
        assert.deepEqual(paths(plan.deleteOnServer), ['ancien.txt']);
        assert.equal(plan.uploads[0].hash, plan.deleteOnServer[0].hash);
    });
});

describe('planSession — une session à vide ne doit rien annoncer', () => {
    it('ne produit AUCUN travail quand tout est déjà en phase', () => {
        // C'est ce que voit le watcher à chaque réveil sur un dossier stable.
        // `filesTotal` doit valoir 0, sans quoi le badge du partage clignote à
        // chaque cycle alors que rien n'a bougé.
        const plan = planSession(
            [device('a.txt', H.a, { mode: 0o644 }), device('b.txt', H.b, { mode: 0o644 })],
            [base('a.txt', H.a, { mode: 0o644 }), base('b.txt', H.b, { mode: 0o644 })],
            [server('a.txt', H.a, { mode: 0o644 }), server('b.txt', H.b, { mode: 0o644 })]
        );
        assert.equal(plan.filesTotal, 0);
        assert.equal(plan.bytesTotal, 0);
        assert.deepEqual(plan.modeChanges, []);
        assert.deepEqual(plan.refreshBaseline, []);
    });
});
