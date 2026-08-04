import type { WorkspaceRow } from 'deveye-types';

import type Encryption from '@/Services/Encryption';
import { createSecureStore, type SecureStore } from '@/Services/SecureStore';
import type { SecretKeyService } from '@/Services/SecretKeyService';
import type { Database } from '@/db';
import { FeatureError } from './_define';

/**
 * Résolution d'autorisation des commandes de feature.
 *
 * C'est le seul endroit qui répond à « que le droit l'appelant a-t-il ? ». Le
 * dispatcheur WS résout un {@link ResolvedScope} par commande et le passe au
 * handler via son contexte : aucun handler n'interroge jamais le rôle ni
 * l'appartenance lui-même.
 */

/**
 * Incrémenté dès que quelque chose qui accorde ou révoque un accès change (rôle
 * global, adhésion à un espace). Chaque entrée en cache retient l'époque sous
 * laquelle elle a été bâtie ; une divergence force sa reconstruction à la
 * commande suivante — la révocation prend donc effet immédiatement, sans
 * requête par commande ni minuteur.
 */
let accessEpoch = 0;

/** Invalide toutes les résolutions en cache, sur toutes les connexions vivantes. */
export function invalidateAccess(): void {
    accessEpoch += 1;
}

/**
 * Whether an account holds the global `admin` role — the single definition of
 * that question. The WS world reaches it through {@link createAccessResolver};
 * the fleet HTTP routes, which have no dispatcher to resolve access for them,
 * call it directly.
 */
export async function isAdminUser(db: Database, userId: number): Promise<boolean> {
    const user = await db.users.findById(userId);
    return user?.role === 'admin';
}

/** L'espace visé par une commande, tel que le voit un handler. */
export interface WorkspaceContext {
    id: number;
    kind: 'personal' | 'shared';
    ownerUserId: number;
    name: string;
    /** Features activées sur l'espace (`workspaces.features`). */
    features: readonly string[];
}

/** Tout ce dont le dispatcheur a besoin pour autoriser puis servir une commande. */
export interface ResolvedScope {
    workspace: WorkspaceContext;
    /** Rôle global du compte : flotte d'appareils et pages système. */
    isAdmin: boolean;
    /** L'appelant possède cet espace. */
    isOwner: boolean;
    /** Coffre chiffré de cet espace, lié à cette session. */
    secure: SecureStore;
    secretKeys: SecretKeyService;
}

export interface AccessResolver {
    /**
     * Résout l'espace visé. `undefined` → l'espace personnel de l'appelant.
     * Lève `forbidden` si l'appelant n'en est pas membre, `not_found` s'il
     * n'existe pas.
     */
    forWorkspace(workspaceId: number | undefined): Promise<ResolvedScope>;
    /**
     * L'espace personnel de l'appelant, quelle que soit l'enveloppe. Sert les
     * commandes de compte (`secrecy`, `twofa`, avatar…) : elles doivent toujours
     * viser le coffre de l'utilisateur, jamais celui d'un espace partagé.
     */
    forAccount(): Promise<ResolvedScope>;
}

function toContext(row: WorkspaceRow): WorkspaceContext {
    return {
        id: row.id,
        kind: row.kind,
        ownerUserId: row.owner_user_id,
        name: row.name,
        features: parseFeatures(row.features)
    };
}

function parseFeatures(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === 'string') {
        try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.map(String) : [];
        } catch {
            return [];
        }
    }
    return [];
}

/**
 * Bâtit le résolveur d'accès d'une connexion.
 *
 * Chaque espace résolu est mémoïsé pour la durée de la connexion et réutilisé
 * jusqu'à ce que {@link invalidateAccess} incrémente l'époque. Résoudre à chaque
 * commande mettrait deux requêtes devant tous les chemins chauds (relevé de
 * métriques, listage de notes) pour répondre à des questions qui ne changent
 * quasiment jamais.
 */
export function createAccessResolver(
    db: Database,
    crypt: Encryption,
    userId: number,
    sessionId: string
): AccessResolver {
    const cache = new Map<number | 'personal', { epoch: number; scope: Promise<ResolvedScope> }>();

    const build = async (workspaceId: number | undefined): Promise<ResolvedScope> => {
        const user = await db.users.findById(userId);
        if (!user) throw new FeatureError('auth_invalid', 'Compte introuvable');

        const targetId = workspaceId ?? user.personal_workspace_id;
        const row = await db.workspaces.findById(targetId);
        if (!row) throw new FeatureError('not_found', 'Espace introuvable');

        // L'appartenance est la frontière, sans exception : même un admin global
        // n'entre pas dans l'espace d'autrui. Le bypass admin porte sur la flotte
        // et les pages système, jamais sur les données d'un autre compte.
        if (!(await db.workspaceMembers.isMember(userId, row.id))) {
            throw new FeatureError('forbidden', 'Vous n’êtes pas membre de cet espace');
        }

        const { store, keys } = createSecureStore(
            db,
            crypt,
            { ownerUserId: row.owner_user_id, callerUserId: userId },
            sessionId
        );

        return {
            workspace: toContext(row),
            isAdmin: user.role === 'admin',
            isOwner: row.owner_user_id === userId,
            secure: store,
            secretKeys: keys
        };
    };

    const resolve = (key: number | 'personal', workspaceId: number | undefined): Promise<ResolvedScope> => {
        const hit = cache.get(key);
        if (hit && hit.epoch === accessEpoch) return hit.scope;

        const epoch = accessEpoch;
        const scope = build(workspaceId).catch((e: unknown) => {
            // Ne jamais mettre un échec en cache : la commande suivante réessaie
            // au lieu d'hériter d'un refus qui n'a plus lieu d'être.
            if (cache.get(key)?.epoch === epoch) cache.delete(key);
            throw e;
        });
        cache.set(key, { epoch, scope });
        return scope;
    };

    return {
        forWorkspace: (workspaceId) => resolve(workspaceId ?? 'personal', workspaceId),
        forAccount: () => resolve('personal', undefined)
    };
}
