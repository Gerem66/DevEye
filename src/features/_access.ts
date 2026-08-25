import type {
    FeatureAccess,
    ItemAccess,
    WorkspaceCapability,
    WorkspaceFeatureGrant,
    FeatureId,
    WorkspacePermissions,
    WorkspaceRoleRow,
    WorkspaceRow
} from '@deveye/types';

import type Encryption from '@/Services/Encryption';
import { createSecureStore, type SecureStore } from '@/Services/SecureStore';
import type { SecretKeyService } from '@/Services/SecretKeyService';
import type { Database } from '@/db';
import { WORKSPACE_CAPABILITIES, WORKSPACE_FEATURE_IDS } from '@deveye/types';
import { FeatureError } from './_define';
import { moduleManifests } from './_sdk/register';

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
 * L'époque courante, pour estampiller un instantané de droits hors de ce module.
 *
 * Le hub de présence en retient un par connexion et par espace, pour pouvoir
 * filtrer ses diffusions **sans rien attendre** : une divergence d'époque y vaut
 * « aucun droit », jamais « les droits d'avant ».
 */
export function accessEpochNow(): number {
    return accessEpoch;
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
    /** Capacités de gouvernance accordées par son rôle. */
    capabilities: ReadonlySet<WorkspaceCapability>;
    /** Droits par feature accordés par son rôle, absents = aucun accès. */
    features: ReadonlyMap<FeatureId, FeatureAccess>;
    /**
     * Fonctionnalités dont le rôle gère les **canaux d'alerte** (le champ
     * `channels` de ses grants, migration 093). Distinct de `features` : régler
     * où Uptime écrit relève de `write`, gérer l'adresse de l'astreinte
     * relève d'ici.
     */
    channels: ReadonlySet<FeatureId>;
    /**
     * Les permissions déclarées par les features elles-mêmes (`extras` des
     * grants, manifests des modules). Brutes ici : la résolution des défauts et
     * du propriétaire se fait à la lecture, contre les specs du manifest.
     */
    extras: ReadonlyMap<FeatureId, Record<string, boolean | string>>;
    /**
     * Les restrictions posées sur des éléments précis, pour le rôle de
     * l'appelant. Chargées **paresseusement, par feature** : la plupart des
     * commandes n'en ont pas besoin, et un espace qui n'en pose aucune n'a
     * aucune ligne à lire.
     *
     * Vide pour le propriétaire, qui passe outre — comme partout ailleurs.
     */
    itemRestrictions: (feature: FeatureId) => Promise<ReadonlyMap<number, ItemAccess>>;
    /** Coffre chiffré de cet espace, lié à cette session. */
    secure: SecureStore;
    secretKeys: SecretKeyService;
}

/**
 * Droits effectifs d'un membre, dans cet ordre :
 *
 *  1. **propriétaire** — tout. Non révocable : personne ne doit pouvoir
 *     s'enfermer dehors de chez soi, et l'espace personnel tombe toujours ici.
 *  2. **membre avec rôle** — exactement ce que son rôle accorde.
 *  3. **membre sans rôle** — rien. Fail-closed : un oubli d'attribution retire
 *     l'accès, il ne le donne jamais.
 *
 * Volontairement **sans** intersection avec `workspaces.features` : cette liste
 * dit quels widgets figurent sur l'accueil, pas qui a le droit d'ouvrir quoi.
 * L'intersecter reviendrait à supprimer l'accès à des données en décochant un
 * widget — et sur les espaces existants, dont la liste contient des identifiants
 * hérités, elle verrouillerait le propriétaire hors de ses propres données. Le
 * rôle est la seule frontière.
 */
export function grantsFor(
    isOwner: boolean,
    role: WorkspaceRoleRow | null
): {
    capabilities: Set<WorkspaceCapability>;
    features: Map<FeatureId, FeatureAccess>;
    channels: Set<FeatureId>;
    extras: Map<FeatureId, Record<string, boolean | string>>;
} {
    if (isOwner) {
        // Les extras du propriétaire ne se matérialisent pas ici : leur
        // résolution (`true` / `ownerValue`) se fait à la lecture, contre le
        // manifest, parce qu'elle dépend de specs que ce module ne connaît pas.
        //
        // « Tout » = les natives ET les modules installés : la constante ne
        // porte que l'enum natif, et un module à id externe (`x-…`) en est
        // absent. Sans cette union, le propriétaire lui-même recevait
        // `forbidden` sur chaque commande d'un module fraîchement installé —
        // dans son propre espace personnel. Les ids natifs rapatriés (weather,
        // osint, cloudsync) sont déjà dans l'enum, l'union est un no-op pour eux.
        const all: FeatureId[] = [...WORKSPACE_FEATURE_IDS, ...moduleManifests().map((m) => m.id)];
        return {
            capabilities: new Set(WORKSPACE_CAPABILITIES),
            features: new Map(all.map((f) => [f, 'write'])),
            channels: new Set(all),
            extras: new Map()
        };
    }
    if (!role) return { capabilities: new Set(), features: new Map(), channels: new Set(), extras: new Map() };

    const features = new Map<FeatureId, FeatureAccess>();
    const channels = new Set<FeatureId>();
    const extras = new Map<FeatureId, Record<string, boolean | string>>();
    for (const g of parseJsonArray<WorkspaceFeatureGrant>(role.features)) {
        features.set(g.feature, g.access);
        if (g.channels) channels.add(g.feature);
        if (g.extras && Object.keys(g.extras).length > 0) extras.set(g.feature, g.extras);
    }
    return {
        capabilities: new Set(parseJsonArray<WorkspaceCapability>(role.capabilities)),
        features,
        channels,
        extras
    };
}

function parseJsonArray<T>(raw: unknown): T[] {
    if (Array.isArray(raw)) return raw as T[];
    if (typeof raw === 'string') {
        try {
            const parsed: unknown = JSON.parse(raw);
            return Array.isArray(parsed) ? (parsed as T[]) : [];
        } catch {
            return [];
        }
    }
    return [];
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

        // La socket ne s'authentifie qu'à la poignée de main : sans ce contrôle,
        // une suspension ne toucherait qu'un compte déconnecté, et celui qui est
        // déjà en ligne garderait tout son accès jusqu'à ce qu'il recharge. Le
        // `invalidateAccess()` posé par `admin.setUserStatus` fait retomber ce
        // scope, donc la suspension mord dès la commande suivante.
        if (user.status === 'suspended') throw new FeatureError('forbidden', 'Ce compte est suspendu');

        const targetId = workspaceId ?? user.personal_workspace_id;
        const row = await db.workspaces.findById(targetId);
        if (!row) throw new FeatureError('not_found', 'Espace introuvable');

        // L'appartenance est la frontière, sans exception : même un admin global
        // n'entre pas dans l'espace d'autrui. Le bypass admin porte sur la flotte
        // et les pages système, jamais sur les données d'un autre compte.
        if (!(await db.workspaceMembers.isMember(userId, row.id))) {
            throw new FeatureError('forbidden', 'Vous n’êtes pas membre de cet espace');
        }

        const isOwner = row.owner_user_id === userId;
        // Le propriétaire n'a pas de rôle : il passe outre, et lui en donner un
        // laisserait croire qu'on peut le lui retirer.
        const role = isOwner ? null : await db.workspaceRoles.findForMember(userId, row.id);
        const { capabilities, features, channels, extras } = grantsFor(isOwner, role);

        // Les clés de l'espace : la sienne s'il est partagé, celles de son
        // propriétaire (l'appelant, seul membre) s'il est personnel.
        const { store, keys } = createSecureStore(db, crypt, row, sessionId);

        /**
         * Les restrictions d'éléments du rôle de l'appelant, par feature.
         *
         * Mémoïsées dans le scope, lui-même mémoïsé sous `accessEpoch` : une
         * restriction modifiée doit donc bumper l'époque
         * (`share.grantSet` appelle `invalidateAccess()`), sinon elle ne
         * mordrait qu'à la reconnexion suivante.
         *
         * Le propriétaire n'en a jamais : il n'a pas de rôle, et les
         * restrictions se posent sur des rôles.
         */
        const restrictionCache = new Map<string, Promise<ReadonlyMap<number, ItemAccess>>>();
        const itemRestrictions = (feature: FeatureId): Promise<ReadonlyMap<number, ItemAccess>> => {
            if (isOwner || !role) return Promise.resolve(new Map());
            const hit = restrictionCache.get(feature);
            if (hit) return hit;
            const loaded = db.itemSharing
                .grantsForRole(row.id, feature, role.id)
                .then((rows) => new Map(rows.map((g) => [g.item_id, g.access])) as ReadonlyMap<number, ItemAccess>);
            restrictionCache.set(feature, loaded);
            return loaded;
        };

        return {
            workspace: toContext(row),
            isAdmin: user.role === 'admin',
            isOwner,
            capabilities,
            features,
            channels,
            extras,
            itemRestrictions,
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

/**
 * Droits effectifs sous la forme attendue par le client. Partagé entre le
 * chargement de session et `workspace.activate`, pour que les deux annoncent
 * exactement la même chose.
 */
export async function permissionsFor(
    db: Database,
    userId: number,
    workspace: WorkspaceRow
): Promise<WorkspacePermissions> {
    const isOwner = workspace.owner_user_id === userId;
    const role = isOwner ? null : await db.workspaceRoles.findForMember(userId, workspace.id);
    const { capabilities, features, channels, extras } = grantsFor(isOwner, role);
    return {
        isOwner,
        capabilities: [...capabilities],
        features: [...features].map(([feature, access]) => ({
            feature,
            access,
            channels: channels.has(feature),
            extras: extras.get(feature) ?? {}
        }))
    };
}
