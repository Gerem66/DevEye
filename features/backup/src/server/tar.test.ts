import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';

import { tarEnd, tarHeader, tarPadding } from './tar';

/**
 * L'archive `tar` d'un partage CloudSync n'a qu'une raison d'exister : pouvoir
 * s'extraire **sans DevEye**, sur une machine quelconque, avec l'outil du
 * système. Une vérification maison ne prouverait donc rien — elle relirait mon
 * format avec mon lecteur.
 *
 * Ces cas passent l'archive au vrai `tar` et comparent les fichiers extraits.
 * Ils sautent proprement là où le binaire n'existe pas plutôt que d'échouer sur
 * une absence d'outil.
 */

const exec = promisify(execFile);

async function hasTar(): Promise<boolean> {
    try {
        await exec('tar', ['--version']);
        return true;
    } catch {
        return false;
    }
}

interface Sample {
    path: string;
    content: Buffer;
}

function buildArchive(samples: Sample[]): Buffer {
    const parts: Buffer[] = [];
    for (const sample of samples) {
        parts.push(
            tarHeader({
                path: sample.path,
                size: sample.content.length,
                mtime: 1_700_000_000_000,
                mode: 0o644,
                isDir: false
            }),
            sample.content,
            tarPadding(sample.content.length)
        );
    }
    parts.push(tarEnd());
    return Buffer.concat(parts);
}

describe('écriture tar', () => {
    it('produit une archive que le tar du système extrait à l’identique', async (t) => {
        if (!(await hasTar())) return t.skip('tar absent de ce système');

        const samples: Sample[] = [
            { path: 'partage/court.txt', content: Buffer.from('bonjour') },
            // Taille non alignée sur 512 : c'est le bourrage qui est vérifié ici.
            { path: 'partage/dossier/binaire.bin', content: crypto.randomBytes(1234) },
            // Exactement un bloc : le cas où le bourrage doit être VIDE, et où
            // en ajouter un décalerait toutes les entrées suivantes.
            { path: 'partage/aligne.bin', content: crypto.randomBytes(512) },
            { path: 'partage/vide.txt', content: Buffer.alloc(0) },
            // Accents : le nom voyage en UTF-8, pas en latin-1.
            { path: 'partage/été/déjà vu.txt', content: Buffer.from('accentué') },
            // > 100 octets mais découpable en prefix/name : la voie USTAR.
            {
                path: `partage/${'sous-dossier/'.repeat(6)}fichier.txt`,
                content: Buffer.from('ustar')
            },
            // > 100 octets sur le DERNIER segment : indécoupable, donc la voie
            // `@LongLink`. C'est le cas que 100 octets de `name` ne couvrent pas
            // et que la plupart des écrivains maison ratent.
            {
                path: `partage/${'x'.repeat(140)}.txt`,
                content: Buffer.from('longlink')
            }
        ];

        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deveye-tar-'));
        try {
            const archive = path.join(dir, 'archive.tar');
            await fs.writeFile(archive, buildArchive(samples));
            const out = path.join(dir, 'out');
            await fs.mkdir(out);
            await exec('tar', ['-xf', archive, '-C', out]);

            for (const sample of samples) {
                const extracted = await fs.readFile(path.join(out, sample.path));
                assert.deepEqual(extracted, sample.content, sample.path);
            }
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    it('écrit un dossier sans contenu ni bourrage', async (t) => {
        if (!(await hasTar())) return t.skip('tar absent de ce système');

        const header = tarHeader({ path: 'partage/vide', size: 0, mtime: 1_700_000_000_000, mode: 0o755, isDir: true });
        assert.equal(header.length, 512, 'un dossier tient en un seul bloc');

        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deveye-tar-'));
        try {
            const archive = path.join(dir, 'archive.tar');
            await fs.writeFile(archive, Buffer.concat([header, tarEnd()]));
            const out = path.join(dir, 'out');
            await fs.mkdir(out);
            await exec('tar', ['-xf', archive, '-C', out]);
            assert.ok((await fs.stat(path.join(out, 'partage/vide'))).isDirectory());
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });
});
