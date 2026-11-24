import { createHmac, hkdfSync, randomBytes } from 'node:crypto';

import type { ServerRefKeyRepo } from '@/db/repos/serverRefKey';
import type Encryption from './Encryption';

/**
 * Les condensés à clé : de quoi retrouver une ligne par une valeur chiffrée
 * (un nom unique, un auteur à regrouper) sans la déchiffrer. Un condensé nu se
 * recalcule en devinant la valeur ; celui-ci demande une clé que seul le
 * serveur détient.
 *
 * Cette clé vient d'une racine tirée au sort au premier démarrage et scellée
 * par la clé serveur dans `server_ref_key` : une rotation de `CRYPT_KEY_A/B`
 * ré-emballe la racine sans changer un seul condensé. Dérivée de la clé
 * serveur, elle en aurait changé chacun.
 */
export interface RefKeys {
    /**
     * Le condensé de `value` : 32 caractères hexadécimaux. `namespace` sépare
     * le socle de chaque module, `purpose` un usage d'un autre, et `scope` dit
     * dans quoi la valeur est unique (un espace, un élément) : la même valeur
     * sous deux portées donne deux condensés sans rapport.
     */
    ref(namespace: string, purpose: string, scope: string | number, value: string): string;
}

export const REF_ROOT_CONTEXT = 'server_ref_key:sealed';

const HKDF_SALT = 'deveye-ref';

export function refKeysFrom(root: Buffer): RefKeys {
    const keys = new Map<string, Buffer>();
    const keyOf = (namespace: string, purpose: string): Buffer => {
        // Longueur en tête : `a` + `b:c` et `a:b` + `c` ne partagent pas de clé.
        const info = `${namespace.length}:${namespace}:${purpose}`;
        let key = keys.get(info);
        if (!key) {
            key = Buffer.from(hkdfSync('sha256', root, HKDF_SALT, info, 32));
            keys.set(info, key);
        }
        return key;
    };
    return {
        ref(namespace, purpose, scope, value) {
            const within = Buffer.from(String(scope), 'utf8');
            const length = Buffer.alloc(4);
            length.writeUInt32BE(within.length);
            return createHmac('sha256', keyOf(namespace, purpose))
                .update(length)
                .update(within)
                .update(value, 'utf8')
                .digest('hex')
                .slice(0, 32);
        }
    };
}

/** Lit la racine, ou la tire au sort au premier démarrage. Lève si elle ne s'ouvre pas. */
export async function loadRefKeys(repo: ServerRefKeyRepo, crypt: Encryption): Promise<RefKeys> {
    let sealed = await repo.sealed();
    if (sealed === null) {
        await repo.insertSealed(crypt.sealFor('ref-root', randomBytes(32), REF_ROOT_CONTEXT));
        sealed = await repo.sealed();
    }
    const root = sealed === null ? null : crypt.openFor('ref-root', sealed, REF_ROOT_CONTEXT);
    if (root === null || root.length !== 32) {
        throw new Error('La racine des condensés ne s’ouvre pas (CRYPT_KEY_A/B changées sans rotation ?)');
    }
    return refKeysFrom(root);
}

let current: RefKeys | null = null;

export function setRefKeys(keys: RefKeys | null): void {
    current = keys;
}

/** Les condensés de l'instance, chargés au démarrage, avant le premier appel. */
export function refKeys(): RefKeys {
    if (current === null) throw new Error('Les condensés à clé ne sont pas chargés');
    return current;
}
