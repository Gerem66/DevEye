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
 * Passe l'archive au vrai `tar` du système : une vérification maison relirait
 * son propre format. Saute si le binaire manque.
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
            // > 100 octets sur le dernier segment : indécoupable, donc `@LongLink`.
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
    it('une taille d’au moins 8 Gio passe en base 256 au lieu de perdre ses premiers chiffres', () => {
        const nine = 9 * 1024 ** 3;
        const head = tarHeader({ path: 'gros.bin', size: nine, mtime: 1_700_000_000_000, mode: null, isDir: false });
        assert.equal(head[124], 0x80);
        let decoded = 0;
        for (let i = 125; i < 136; i += 1) decoded = decoded * 256 + head[i];
        assert.equal(decoded, nine);

        // La somme de contrôle couvre ces octets comme les autres.
        const stored = parseInt(head.subarray(148, 154).toString('ascii'), 8);
        let sum = 0;
        for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : head[i];
        assert.equal(stored, sum);

        const small = tarHeader({ path: 'petit.bin', size: 0o77777777777, mtime: 0, mode: null, isDir: false });
        assert.equal(small.subarray(124, 136).toString('ascii'), '77777777777\0');
    });
});
