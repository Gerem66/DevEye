/**
 * « Retenir sur cet appareil » : le jeton de rafraîchissement d'une instance
 * distante, gardé dans le navigateur et nulle part ailleurs. Jamais le mot de
 * passe. IndexedDB plutôt que localStorage : rien d'autre dans l'app n'y lit, et
 * la purge de déconnexion le vide d'un geste.
 *
 * Tout échoue en silence : sans stockage (navigation privée), on redemande
 * simplement le mot de passe à la prochaine ouverture.
 */
const DB_NAME = 'deveye-remote';
const STORE = 'sessions';

function open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error('IndexedDB indisponible'));
    });
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
    try {
        const db = await open();
        try {
            return await new Promise<T>((resolve, reject) => {
                const req = op(db.transaction(STORE, mode).objectStore(STORE));
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error ?? new Error('IndexedDB'));
            });
        } finally {
            db.close();
        }
    } catch {
        return null;
    }
}

/** Par compte d'ici ET par instance : deux comptes du même poste ne partagent rien. */
const keyOf = (localUserId: number, instanceId: number): string => `${localUserId}:${instanceId}`;

export async function readRemoteToken(localUserId: number, instanceId: number): Promise<string | null> {
    const value = await run<unknown>('readonly', (s) => s.get(keyOf(localUserId, instanceId)));
    return typeof value === 'string' ? value : null;
}

export async function writeRemoteToken(localUserId: number, instanceId: number, refreshToken: string): Promise<void> {
    await run('readwrite', (s) => s.put(refreshToken, keyOf(localUserId, instanceId)));
}

export async function deleteRemoteToken(localUserId: number, instanceId: number): Promise<void> {
    await run('readwrite', (s) => s.delete(keyOf(localUserId, instanceId)));
}

export async function clearRemoteVault(): Promise<void> {
    await run('readwrite', (s) => s.clear());
}
