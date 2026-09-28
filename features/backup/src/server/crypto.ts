import type { SdkServerKeys } from '@deveye/types/sdk/server';

/**
 * La clé des archives, scellées au format `DEVB` v2 du SDK (`sealStream`,
 * `openSealedStream`) : un seul outil de restauration.
 *
 * La clé n'est PAS la BMK de CloudSync, rangée dans `sync_meta` donc à
 * l'intérieur de la sauvegarde de la base. Elle est dérivée, jamais stockée :
 * BAK = HKDF-SHA256(serverKey, salt 'deveye-backup', info 'v1'). Restaurer ne
 * demande que CRYPT_KEY_A/CRYPT_KEY_B et `scripts/restore-backup.mjs` ; les
 * perdre transforme toutes les archives scellées en bruit.
 */

const BACKUP_KEY_SALT = 'deveye-backup';
const BACKUP_KEY_INFO = 'v1';

/** Dérivée par le SDK (`keys.derive`) ; `scripts/restore-backup.mjs` la refait à l'identique. */
export function backupKey(keys: SdkServerKeys): Buffer {
    return Buffer.from(keys.derive(BACKUP_KEY_SALT, BACKUP_KEY_INFO, 32));
}
