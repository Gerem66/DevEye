import type { FeatureId, ItemCopyPlan, ItemCopyTarget } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import { ensureUnlocked, ensureUnlockedOn } from '@/stores/secrecy';
import { getActiveInstanceId, getActiveWorkspaceId } from '@/stores/workspace';

/**
 * Copier un élément vers un autre espace. Un seul chemin, que la cible soit ici
 * ou sur une instance distante : la source rend l'élément par tranches, ce
 * navigateur les remet une à une à la destination, qui le scelle sous sa clé.
 * Les deux serveurs ne se parlent pas, et une tranche ne vit ici que le temps
 * de passer de l'un à l'autre.
 */

export interface CopyDestination {
    /** `null` : cette instance. */
    instanceId: number | null;
    workspaceId: number;
    /** Comment nommer l'instance dans l'invite de son coffre. */
    instanceLabel: string;
}

export type CopyStep = 'read' | 'transfer' | 'write';

/** Lire et sceller tout un arbre peut prendre des secondes : le délai par défaut d'une commande n'y suffit pas. */
const LONG_MS = 120_000;
/** La part de la barre que tient le transfert ; le reste va à la lecture et à l'écriture. */
const READ_SHARE = 0.08;
const WRITE_SHARE = 0.1;

function connections(to: CopyDestination) {
    const sourceWorkspaceId = getActiveWorkspaceId();
    const source = ws.connectionFor(getActiveInstanceId());
    const target = ws.connectionFor(to.instanceId);
    if (!source || sourceWorkspaceId === null) throw new WsError('closed', 'Espace d’origine indisponible');
    if (!target) throw new WsError('closed', 'Cette instance est déconnectée.');
    return { source, sourceWorkspaceId, target };
}

/** Rejoue une fois après l'invite du coffre, quand la première tentative a répondu `locked`. */
async function unlocking<T>(run: () => Promise<T>, unlock: () => Promise<void>): Promise<T> {
    try {
        return await run();
    } catch (e) {
        if (!(e instanceof WsError) || e.code !== 'locked') throw e;
        await unlock();
        return run();
    }
}

/** Ce que la copie suppose des deux côtés, sans rien transférer : de quoi confirmer, ou refuser. */
export async function previewCopy(
    feature: FeatureId,
    itemId: string,
    to: CopyDestination
): Promise<{ plan: ItemCopyPlan; target: ItemCopyTarget }> {
    const { source, sourceWorkspaceId, target } = connections(to);
    const plan = await source.send('share.copyPlan', { feature, itemId }, { workspaceId: sourceWorkspaceId });
    const arrival = await target.send(
        'share.copyTarget',
        { feature, tier: plan.tier },
        { workspaceId: to.workspaceId }
    );
    return { plan, target: arrival };
}

export async function copyItem(
    feature: FeatureId,
    itemId: string,
    to: CopyDestination,
    onProgress: (step: CopyStep, value: number) => void
): Promise<string> {
    const { source, sourceWorkspaceId, target } = connections(to);
    const from = { workspaceId: sourceWorkspaceId };
    const into = { workspaceId: to.workspaceId };

    onProgress('read', 0);
    // Un élément gardé se lit coffre ouvert : le `locked` d'ici rouvre celui d'ici.
    const manifest = await unlocking(
        () => source.send('share.copyExport', { feature, itemId }, { ...from, timeoutMs: LONG_MS }),
        ensureUnlocked
    );
    const { importId } = await target.send(
        'share.copyBegin',
        { feature, bytes: manifest.bytes, chunks: manifest.chunks, sha256: manifest.sha256 },
        into
    );

    const transfer = 1 - READ_SHARE - WRITE_SHARE;
    for (let index = 0; index < manifest.chunks; index += 1) {
        onProgress('transfer', READ_SHARE + (transfer * index) / manifest.chunks);
        const { data } = await source.send('share.copyChunk', { exportId: manifest.exportId, index }, from);
        await target.send('share.copyPut', { importId, index, data }, into);
    }

    onProgress('write', 1 - WRITE_SHARE);
    // Le palier gardé de l'arrivée veut SON coffre ouvert : le second mot de
    // passe, celui du compte de là-bas. Le paquet attend côté serveur.
    const { itemId: copied } = await unlocking(
        () => target.send('share.copyCommit', { importId, feature }, { ...into, timeoutMs: LONG_MS }),
        () => ensureUnlockedOn(to.instanceId, to.instanceLabel)
    );
    onProgress('write', 1);
    return copied;
}
