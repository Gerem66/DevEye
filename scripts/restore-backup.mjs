#!/usr/bin/env node
/**
 * Ouvre une archive de sauvegarde chiffrée par DevEye — **sans DevEye**.
 *
 * C'est la contrepartie indispensable du chiffrement des archives. Une
 * sauvegarde qu'on ne peut rouvrir qu'avec l'application qu'on est en train de
 * restaurer n'est pas une sauvegarde, c'est un pari. Ce fichier n'a donc :
 *
 *  - aucune dépendance (Node seul, `node:crypto`) ;
 *  - aucun accès à la base, au réseau, ni au reste du dépôt ;
 *  - aucune notion de DevEye au-delà du format d'octets.
 *
 * On peut le copier sur une clé USB avec les archives. C'est même recommandé.
 *
 *   node restore-backup.mjs <archive.enc> [sortie]
 *
 * La clé est dérivée de CRYPT_KEY_A / CRYPT_KEY_B, lues dans l'environnement ou
 * dans un `.env` passé par `--env`. Ce sont les mêmes valeurs que celles du
 * serveur qui a produit l'archive : les avoir changées depuis rend les archives
 * d'avant illisibles, ce qui est le seul piège de ce système et mérite d'être
 * répété ici.
 *
 * Format lu : `DEVB` v2 — magic (4) | version (1) | nonce de base (12), puis des
 * blocs `ciphertext | tag` de 1 Mio de clair, chacun scellé en AES-256-GCM avec
 * un nonce dérivé de son rang et une AAD portant ce rang et un marqueur de fin.
 * Le marqueur ferme la troncature, le rang ferme le réordonnancement.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('DEVB');
const VERSION_CHUNKED = 0x02;
const HEADER_LEN = MAGIC.length + 1 + 12;
const TAG_LEN = 16;
const CHUNK_BYTES = 1024 * 1024;
const CHUNK_SEALED = CHUNK_BYTES + TAG_LEN;

function die(message) {
    process.stderr.write(`${message}\n`);
    process.exit(1);
}

/**
 * Une panne survenue **pendant le flux**.
 *
 * Distincte de `die` : tout ce qui se produit une fois l'écriture commencée doit
 * remonter par une exception, pour que le `.part` soit effacé avant de rendre la
 * main. Un `process.exit` à cet endroit laissait derrière lui un demi-fichier —
 * précisément ce qu'un outil de restauration ne doit jamais faire.
 */
class ArchiveError extends Error {}

/** Les deux clés, depuis l'environnement ou un fichier `.env`. */
function readKeys(envPath) {
    let a = process.env.CRYPT_KEY_A;
    let b = process.env.CRYPT_KEY_B;
    if (envPath) {
        const text = fs.readFileSync(envPath, 'utf8');
        for (const line of text.split('\n')) {
            const match = /^\s*(CRYPT_KEY_A|CRYPT_KEY_B)\s*=\s*(.*?)\s*$/.exec(line);
            if (!match) continue;
            const value = match[2].replace(/^["']|["']$/g, '');
            if (match[1] === 'CRYPT_KEY_A') a = value;
            else b = value;
        }
    }
    if (!a || !b) {
        die(
            'CRYPT_KEY_A et CRYPT_KEY_B sont requis.\n' +
                'Passez-les par l’environnement, ou indiquez un fichier avec --env <chemin>.'
        );
    }
    return { a, b };
}

/**
 * La clé de scellement des archives.
 *
 * Deux dérivations enchaînées, et elles doivent rester le miroir exact du
 * serveur (`Services/Encryption.serverKey` puis `backup/crypto.backupKey`) :
 *
 *   serverKey = SHA-256("<A>:<B>")
 *   backupKey = HKDF-SHA256(serverKey, salt='deveye-backup', info='v1', 32)
 */
function backupKey(a, b) {
    const serverKey = crypto.createHash('sha256').update(`${a}:${b}`).digest();
    return Buffer.from(crypto.hkdfSync('sha256', serverKey, Buffer.from('deveye-backup'), Buffer.from('v1'), 32));
}

function chunkNonce(base, index) {
    const nonce = Buffer.from(base);
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(index));
    for (let i = 0; i < 8; i += 1) nonce[4 + i] ^= counter[i];
    return nonce;
}

function chunkAad(index, final) {
    const aad = Buffer.alloc(9);
    aad.writeBigUInt64BE(BigInt(index));
    aad[8] = final ? 1 : 0;
    return aad;
}

function openChunk(key, base, index, sealed, final) {
    if (sealed.length < TAG_LEN) throw new ArchiveError(`Bloc ${index} tronqué : l’archive est incomplète.`);
    const body = sealed.subarray(0, sealed.length - TAG_LEN);
    const tag = sealed.subarray(sealed.length - TAG_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, chunkNonce(base, index));
    decipher.setAAD(chunkAad(index, final));
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
        throw new ArchiveError(
            `Le bloc ${index} ne s’authentifie pas.\n` +
                'Causes possibles : mauvaises CRYPT_KEY_A/CRYPT_KEY_B, archive corrompue, ou archive tronquée.'
        );
    }
}

async function* openSealed(key, source) {
    let buffer = Buffer.alloc(0);
    let nonce = null;
    let index = 0;

    for await (const part of source) {
        buffer = buffer.length === 0 ? part : Buffer.concat([buffer, part]);

        if (nonce === null) {
            if (buffer.length < HEADER_LEN) continue;
            const header = buffer.subarray(0, HEADER_LEN);
            buffer = buffer.subarray(HEADER_LEN);
            if (!header.subarray(0, 4).equals(MAGIC)) {
                throw new ArchiveError(
                    'Ce fichier n’est pas une archive DevEye chiffrée (en-tête absent). Est-il déjà en clair ?'
                );
            }
            if (header[4] !== VERSION_CHUNKED) throw new ArchiveError(`Version de format inconnue (${header[4]}).`);
            nonce = header.subarray(5, 17);
        }

        // On garde toujours de quoi former un dernier bloc : tant qu'il reste
        // exactement une taille de bloc scellé, on ne peut pas savoir s'il est
        // intermédiaire ou final — et l'AAD diffère.
        while (buffer.length > CHUNK_SEALED) {
            yield openChunk(key, nonce, index, buffer.subarray(0, CHUNK_SEALED), false);
            buffer = buffer.subarray(CHUNK_SEALED);
            index += 1;
        }
    }

    if (nonce === null) throw new ArchiveError('Archive vide ou en-tête tronqué.');
    yield openChunk(key, nonce, index, buffer, true);
}

async function main() {
    const args = process.argv.slice(2);
    let envPath = null;
    const positional = [];
    for (let i = 0; i < args.length; i += 1) {
        if (args[i] === '--env') {
            envPath = args[i + 1];
            i += 1;
        } else if (args[i] === '-h' || args[i] === '--help') {
            process.stdout.write(
                'Usage : node restore-backup.mjs [--env <.env>] <archive.enc> [sortie]\n\n' +
                    'Déchiffre une archive de sauvegarde DevEye. Sans « sortie », le nom\n' +
                    'est celui de l’archive sans son suffixe .enc.\n\n' +
                    'Ensuite, selon le type d’archive :\n' +
                    '  *.sql.gz   →  gunzip -c archive.sql.gz | mysql -u… -p… base\n' +
                    '              →  gunzip -c archive.sql.gz | psql -U… base\n' +
                    '  *.tar.gz   →  tar -xzf archive.tar.gz\n'
            );
            return;
        } else {
            positional.push(args[i]);
        }
    }

    const input = positional[0];
    if (!input) die('Usage : node restore-backup.mjs [--env <.env>] <archive.enc> [sortie]');
    if (!fs.existsSync(input)) die(`Introuvable : ${input}`);

    const output = positional[1] ?? (input.endsWith('.enc') ? input.slice(0, -4) : `${input}.clair`);
    if (fs.existsSync(output)) die(`La sortie existe déjà : ${output}`);

    const { a, b } = readKeys(envPath);
    const key = backupKey(a, b);

    // Le condensé du **clair** est ce que DevEye a enregistré à la sauvegarde
    // (colonne `checksum` de l'exécution) : le recalculer ici permet de vérifier
    // la restauration sans faire confiance à la destination qui a rendu le
    // fichier.
    const digest = crypto.createHash('sha256');
    const tmp = `${output}.part`;
    try {
        await pipeline(
            (async function* () {
                for await (const chunk of openSealed(key, fs.createReadStream(input))) {
                    digest.update(chunk);
                    yield chunk;
                }
            })(),
            fs.createWriteStream(tmp)
        );
        fs.renameSync(tmp, output);
    } catch (e) {
        fs.rmSync(tmp, { force: true });
        die(`Échec : ${e.message}`);
    }

    process.stdout.write(
        `${path.basename(output)} écrit (${fs.statSync(output).size} octets)\n` +
            `sha256 du clair : ${digest.digest('hex')}\n` +
            'À comparer au condensé affiché par DevEye sur cette exécution.\n'
    );
}

await main();
