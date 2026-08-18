import crypto from 'crypto';
import { SYNC_FINGERPRINT_SEP, type SyncDeviceFileRow, type SyncIndexEntry } from 'deveye-types';

/**
 * Empreinte d'un index de partage : `{nombre}.{octets}.{sha256hex}`.
 *
 * Elle répond à UNE question : « ce que l'agent détient est-il exactement ce que
 * je crois qu'il détient ? ». Le serveur ne SUPPOSE donc jamais qu'un appareil
 * est à jour, il le VÉRIFIE — et une vérification négative coûte un scan
 * complet, jamais une divergence.
 *
 * ⚠️ Le `mtime` est VOLONTAIREMENT absent de la ligne, et ce n'est pas un oubli.
 * La baseline n'est réécrite que lorsque le HASH change (`refreshBaseline` dans
 * `planner.ts`) : un simple `touch`, qui déplace le mtime sans toucher au
 * contenu, laisserait donc `sync_device_files.mtime` désaccordé pour toujours, et
 * l'empreinte ne correspondrait plus jamais — le chemin rapide ne s'engagerait
 * plus, en silence, ce qui est exactement le mode de panne à éviter.
 *
 * Ce n'est pas non plus une perte de rigueur. L'empreinte certifie que l'appareil
 * détient le même JEU DE CONTENUS que la baseline, et le mtime ne fait pas partie
 * du contenu. Quand les empreintes concordent, aucun hash ne diffère : le
 * planificateur ne peut alors produire ni montée, ni conflit, ni rafraîchissement
 * de baseline, c'est-à-dire aucun des trois endroits où le mtime aurait pesé
 * (`sameContent`, la départage `SYNC_MTIME_SKEW_MS`, et `toPlanFile`).
 *
 * Le pli est un XOR des hachages par ligne, donc INDÉPENDANT DE L'ORDRE. Un tri
 * obligerait TypeScript (`Array#sort`, ordre unité UTF-16) et Rust (`String:
 * Ord`, ordre octet UTF-8) à s'accorder sur les caractères hors BMP, ce qu'ils
 * ne font pas : un seul emoji dans un nom de fichier aurait alors désactivé le
 * chemin rapide pour toujours, sans que rien ne le signale. L'annulation par
 * doublon, qui est le risque habituel d'un XOR, est impossible ici : les clés
 * sont uniques des deux côtés (`HashMap` côté agent, `uniq_sync_device_file` en
 * base). `count` et `sumSize` sont pliés en plus, comme discriminants.
 *
 * ⚠️ L'empreinte ne doit JAMAIS intégrer un digest de la config (exclusions,
 * chemin local). Les deux copies changeraient au même instant alors que les JEUX
 * D'ENTRÉES, eux, diffèrent encore — le cache de l'agent ayant été produit sous
 * les anciennes exclusions. Ce serait une fausse égalité, c'est-à-dire une
 * non-convergence silencieuse. L'invalidation appartient au compteur du watcher
 * de l'agent (`CleanMark`), pas au hachage.
 *
 * ⚠️ Ne jamais déplacer ce calcul en SQL avec `GROUP_CONCAT` :
 * `group_concat_max_len` vaut 1024 octets par défaut et TRONQUE en silence, ce
 * qui produirait une empreinte stable et fausse — parfaite sur un partage de
 * test à cinq fichiers, catastrophique sur un vrai. `BIT_XOR` de hachages par
 * ligne serait la seule forme acceptable.
 *
 * Le format est mot pour mot celui de `agent/src/sync/fingerprint.rs`, et le
 * vecteur de test est partagé par les deux (voir `fingerprint.test.ts`).
 */

/** Ce qu'une entrée apporte à l'empreinte, dans l'ordre des champs du protocole. */
export interface FingerprintEntry {
    relPath: string;
    kind: string;
    hash: string;
    size: number;
    mode: number | null;
}

export function indexFingerprint(entries: Iterable<FingerprintEntry>): string {
    const fold = Buffer.alloc(32);
    let count = 0;
    let sumSize = 0;
    for (const e of entries) {
        // `mode` absent devient -1, et jamais 0 : sous Windows le mode est
        // inconnu, et le confondre avec « aucune permission » ferait diverger
        // l'empreinte d'un agent Windows de celle d'un fichier réellement en 000.
        const mode = e.mode ?? -1;
        const line = [e.relPath, e.kind, e.hash, e.size, mode].join(SYNC_FINGERPRINT_SEP);
        const digest = crypto.createHash('sha256').update(line, 'utf8').digest();
        for (let i = 0; i < 32; i++) fold[i] ^= digest[i];
        count += 1;
        sumSize += e.size;
    }
    return `${count}.${sumSize}.${fold.toString('hex')}`;
}

/** L'empreinte de la baseline d'un appareil, telle que le serveur la connaît. */
export function baselineFingerprint(rows: Iterable<SyncDeviceFileRow>): string {
    return indexFingerprint(
        (function* () {
            for (const r of rows) {
                yield { relPath: r.rel_path, kind: r.kind, hash: r.hash, size: r.size, mode: r.mode };
            }
        })()
    );
}

/** L'empreinte d'un index reçu de l'agent, pour recouper ce qu'il a annoncé. */
export function entriesFingerprint(entries: Iterable<SyncIndexEntry>): string {
    return indexFingerprint(
        (function* () {
            for (const e of entries) {
                yield { relPath: e.relPath, kind: e.kind, hash: e.hash, size: e.size, mode: e.mode };
            }
        })()
    );
}
