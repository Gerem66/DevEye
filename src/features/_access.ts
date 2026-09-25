import type {
    FeatureAccess,
    ItemAccess,
    ItemExtraOverrides,
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
import { moduleManifest, moduleManifests } from './_sdk/register';
import { memberPausedIn } from '@/Services/planPauses';
import { parseJsonArray } from '@/Utils/json';
import { extraOverridesOf } from '@/db/repos/itemSharing';
import { resolveExtras } from '@deveye/types/sdk';
import type { SdkAccessDenial, SdkAccessVerdict } from '@deveye/types/sdk/server';

/**
 * Résolution d'autorisation des commandes de feature : le seul endroit qui
 * répond à « quel droit l'appelant a-t-il ? ». Le dispatcheur WS résout un
 * {@link ResolvedScope} par commande ; aucun handler n'interroge le rôle ni
 * l'appartenance lui-même.
 */

/**
 * Incrémenté dès que quelque chose qui accorde ou révoque un accès change.
 * Chaque entrée en cache retient l'époque de sa construction ; une divergence
 * force sa reconstruction à la commande suivante.
 */
let accessEpoch = 0;

/** Invalide toutes les résolutions en cache, sur toutes les connexions vivantes. */
export function invalidateAccess(): void {
    accessEpoch += 1;
}

/**
 * L'époque courante, pour estampiller un instantané de droits hors de ce module
 * (les hubs filtrent leurs diffusions sans rien attendre : une divergence vaut
 * « aucun droit »).
 */
export function accessEpochNow(): number {
    return accessEpoch;
}

/**
 * Whether an account holds the global `admin` role: the single definition. The
 * fleet HTTP routes, which have no dispatcher, call it directly.
 */
export async function isAdminUser(db: Database, userId: number): Promise<boolean> {
    const user = await db.users.findById(userId);
    return user?.role === 'admin';
}

/**
 * Un compte tient-il ce droit sur cette fonctionnalité, dans cet espace ? Les
 * routes HTTP de la flotte, qui n'ont pas de dispatcheur, s'en servent : le
 * propriétaire a tout, un membre ce que son rôle accorde, un non-membre rien.
 */
export async function holdsFeatureIn(
    db: Database,
    userId: number,
    workspaceId: number,
    feature: FeatureId,
    level: FeatureAccess
): Promise<boolean> {
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) return false;
    const isOwner = workspace.owner_user_id === userId;
    if (!isOwner && !(await db.workspaceMembers.isMember(userId, workspaceId))) return false;
    if (!isOwner && memberPausedIn(workspaceId, userId)) return false;
    const role = isOwner ? null : await db.workspaceRoles.findForMember(userId, workspaceId);
    const granted = grantsFor(isOwner, role).features.get(feature);
    return granted === 'write' || (level === 'read' && granted === 'read');
}

/** Ce qu'un membre tient sur une fonctionnalité, et sur un élément s'il est nommé. */
interface MemberGrant {
    access: ItemAccess;
    /** La surcharge posée sur l'élément pour son rôle, s'il y en a une. */
    override: ItemAccess | null;
    canExtra: (key: string) => boolean;
}

/**
 * Les droits d'un compte sur une fonctionnalité, résolus sans session, avec
 * les règles d'une commande : compte actif, appartenance, rôle, et la
 * surcharge de l'élément qui remplace ce que la fonctionnalité donne.
 */
async function memberGrant(
    db: Database,
    userId: number,
    workspaceId: number,
    feature: FeatureId,
    itemId?: string
): Promise<MemberGrant | SdkAccessDenial> {
    const user = await db.users.findById(userId);
    if (!user) return 'not_member';
    if (user.status === 'suspended') return 'suspended';
    const workspace = await db.workspaces.findById(workspaceId);
    if (!workspace) return 'not_member';
    const isOwner = workspace.owner_user_id === userId;
    if (!isOwner && !(await db.workspaceMembers.isMember(userId, workspaceId))) return 'not_member';
    // En pause, un membre est dehors, pour le travail qu'il a laissé tourner aussi.
    if (!isOwner && memberPausedIn(workspaceId, userId)) return 'not_member';
    const role = isOwner ? null : await db.workspaceRoles.findForMember(userId, workspaceId);
    const { features, extras } = grantsFor(isOwner, role);
    const base = features.get(feature);
    // Le plancher : sans lecture sur la fonctionnalité, aucune surcharge ne rouvre rien.
    if (!base) return 'level';
    const row =
        role && itemId !== undefined
            ? (await db.itemSharing.grantsForRole(workspaceId, feature, role.id)).find((g) => g.item_id === itemId)
            : undefined;
    const granted = resolveExtras(moduleManifest(feature)?.extraPermissions, isOwner, extras.get(feature) ?? {});
    const overrides = row ? extraOverridesOf(row) : {};
    return {
        access: row?.access ?? base,
        override: row?.access ?? null,
        canExtra: (key) => overrides[key] ?? granted.canExtra(key)
    };
}

const deny = (reason: SdkAccessDenial): SdkAccessVerdict => ({ ok: false, reason });

/**
 * Ce qu'un membre peut faire MAINTENANT sur une fonctionnalité, sans session :
 * pour un travail qui s'exécute en son nom longtemps après qu'il l'a réglé, et
 * doit s'arrêter quand il perd le droit.
 */
export async function memberVerdict(
    db: Database,
    userId: number,
    workspaceId: number,
    feature: FeatureId,
    need: { level?: FeatureAccess; extras?: readonly string[]; itemId?: string }
): Promise<SdkAccessVerdict> {
    const grant = await memberGrant(db, userId, workspaceId, feature, need.itemId);
    if (typeof grant === 'string') return deny(grant);
    if (grant.access === 'none') return deny('hidden');
    if (need.level === 'write' && grant.access !== 'write') return deny(grant.override ? 'read_only' : 'level');
    for (const key of need.extras ?? []) {
        if (!grant.canExtra(key)) return deny('not_granted');
    }
    return { ok: true };
}

/**
 * Les permissions d'Appareils d'un membre sur une machine, sans session. La
 * règle de `authorizeReachableDevice` : une machine passée en lecture seule
 * pour son rôle ne prend pas d'ordre, quelles que soient ses permissions.
 */
export async function deviceVerdict(
    db: Database,
    userId: number,
    workspaceId: number,
    deviceId: string,
    extras: readonly string[]
): Promise<SdkAccessVerdict> {
    const device = await db.devices.findVisible(deviceId, workspaceId);
    if (!device) return deny('no_device');
    const grant = await memberGrant(db, userId, workspaceId, 'devices', device.id);
    if (typeof grant === 'string') return deny(grant);
    if (grant.access === 'none') return deny('hidden');
    if (grant.override === 'read') return deny('read_only');
    for (const key of extras) {
        if (!grant.canExtra(key)) return deny('not_granted');
    }
    return { ok: true };
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
     * Fonctionnalités dont le rôle gère les canaux d'alerte (champ `channels`
     * des grants). Distinct de `features` : router relève de `write`, gérer
     * l'adresse de l'astreinte relève d'ici.
     */
    channels: ReadonlySet<FeatureId>;
    /**
     * Fonctionnalités dont le rôle règle les permissions par élément (champ
     * `itemPermissions` des grants). Distinct de la capacité `workspace.roles` :
     * surcharger un appareil n'est pas gouverner les rôles de l'espace.
     */
    itemPermissions: ReadonlySet<FeatureId>;
    /**
     * Les permissions déclarées par les features elles-mêmes (`extras` des
     * grants), brutes : défauts et propriétaire se résolvent à la lecture,
     * contre les specs du manifest.
     */
    extras: ReadonlyMap<FeatureId, Record<string, boolean | string>>;
    /**
     * Les surcharges posées sur des éléments précis, pour le rôle de l'appelant.
     * Chargées paresseusement, par feature. Vide pour le propriétaire, qui passe
     * outre. La valeur remplace ce que la fonctionnalité donne, dans les deux
     * sens ; le plancher de visibilité reste le grant de la feature.
     */
    itemRestrictions: (feature: FeatureId) => Promise<ReadonlyMap<string, ItemAccess>>;
    /**
     * Les permissions propres qu'un élément précis accorde ou retire au rôle de
     * l'appelant. Second volet des mêmes lignes qu'`itemRestrictions`, lu au même
     * moment : un rôle peut tenir le terminal sur la fonctionnalité et se le voir
     * retirer sur une machine, ou l'inverse.
     */
    itemExtraOverrides: (feature: FeatureId) => Promise<ReadonlyMap<string, ItemExtraOverrides>>;
    /** Coffre chiffré de cet espace, lié à cette session. */
    secure: SecureStore;
    secretKeys: SecretKeyService;
}

/**
 * Droits effectifs d'un membre : le propriétaire a tout (non révocable), un
 * membre avec rôle exactement ce que son rôle accorde, un membre sans rôle rien
 * (fail-closed).
 *
 * Volontairement sans intersection avec `workspaces.features` : cette liste dit
 * quels widgets figurent sur l'accueil, pas qui a le droit d'ouvrir quoi. Le
 * rôle est la seule frontière.
 */
export function grantsFor(
    isOwner: boolean,
    role: WorkspaceRoleRow | null
): {
    capabilities: Set<WorkspaceCapability>;
    features: Map<FeatureId, FeatureAccess>;
    channels: Set<FeatureId>;
    itemPermissions: Set<FeatureId>;
    extras: Map<FeatureId, Record<string, boolean | string>>;
} {
    if (isOwner) {
        // Les extras du propriétaire se résolvent à la lecture, contre le
        // manifest. « Tout » = les natives et les modules installés : la
        // constante ne porte que l'enum natif, un module à id externe en est
        // absent.
        const all: FeatureId[] = [...WORKSPACE_FEATURE_IDS, ...moduleManifests().map((m) => m.id)];
        return {
            capabilities: new Set(WORKSPACE_CAPABILITIES),
            features: new Map(all.map((f) => [f, 'write'])),
            channels: new Set(all),
            itemPermissions: new Set(all),
            extras: new Map()
        };
    }
    if (!role) {
        return {
            capabilities: new Set(),
            features: new Map(),
            channels: new Set(),
            itemPermissions: new Set(),
            extras: new Map()
        };
    }

    const features = new Map<FeatureId, FeatureAccess>();
    const channels = new Set<FeatureId>();
    const itemPermissions = new Set<FeatureId>();
    const extras = new Map<FeatureId, Record<string, boolean | string>>();
    for (const g of parseJsonArray<WorkspaceFeatureGrant>(role.features)) {
        features.set(g.feature, g.access);
        if (g.channels) channels.add(g.feature);
        if (g.itemPermissions) itemPermissions.add(g.feature);
        if (g.extras && Object.keys(g.extras).length > 0) extras.set(g.feature, g.extras);
    }
    return {
        capabilities: new Set(parseJsonArray<WorkspaceCapability>(role.capabilities)),
        features,
        channels,
        itemPermissions,
        extras
    };
}

export interface AccessResolver {
    /**
     * Résout l'espace visé. `undefined` → l'espace personnel de l'appelant.
     * Lève `forbidden` si l'appelant n'en est pas membre, `not_found` s'il
     * n'existe pas.
     */
    forWorkspace(workspaceId: number | undefined): Promise<ResolvedScope>;
    /**
     * L'espace personnel de l'appelant, quelle que soit l'enveloppe : les
     * commandes de compte doivent toujours viser le coffre de l'utilisateur.
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
    return parseJsonArray<unknown>(raw).map(String);
}

/**
 * Bâtit le résolveur d'accès d'une connexion. Chaque espace résolu est mémoïsé
 * pour la durée de la connexion, jusqu'à ce que {@link invalidateAccess}
 * incrémente l'époque.
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
        // un compte suspendu déjà en ligne garderait son accès jusqu'au
        // rechargement (`admin.setUserStatus` invalide l'époque).
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
        if (!isOwner && memberPausedIn(row.id, userId)) {
            throw new FeatureError(
                'forbidden',
                'Votre accès à cet espace est en pause : l’offre de son propriétaire ne le couvre plus.'
            );
        }
        // Le propriétaire n'a pas de rôle : il passe outre, et lui en donner un
        // laisserait croire qu'on peut le lui retirer.
        const role = isOwner ? null : await db.workspaceRoles.findForMember(userId, row.id);
        const { capabilities, features, channels, itemPermissions, extras } = grantsFor(isOwner, role);

        // Les clés de l'espace : la sienne s'il est partagé, celles de son
        // propriétaire (l'appelant, seul membre) s'il est personnel.
        const { store, keys } = createSecureStore(db, crypt, row, sessionId);

        // Mémoïsées dans le scope, lui-même mémoïsé sous `accessEpoch` : une
        // restriction modifiée doit donc bumper l'époque (`share.grantSet`
        // appelle `invalidateAccess()`).
        interface ItemGrants {
            access: ReadonlyMap<string, ItemAccess>;
            extras: ReadonlyMap<string, ItemExtraOverrides>;
        }
        const restrictionCache = new Map<string, Promise<ItemGrants>>();
        // Une seule lecture par feature pour les deux volets : ils vivent sur la
        // même ligne, les séparer doublerait la requête sans rien gagner.
        const itemGrants = (feature: FeatureId): Promise<ItemGrants> => {
            if (isOwner || !role) return Promise.resolve({ access: new Map(), extras: new Map() });
            const hit = restrictionCache.get(feature);
            if (hit) return hit;
            const loaded = db.itemSharing.grantsForRole(row.id, feature, role.id).then((rows) => {
                const access = new Map<string, ItemAccess>();
                const extras = new Map<string, ItemExtraOverrides>();
                for (const g of rows) {
                    // `access` est nullable : une ligne peut n'exister que pour
                    // des permissions surchargées, sans surcharge de niveau.
                    if (g.access !== null) access.set(g.item_id, g.access);
                    const overrides = extraOverridesOf(g);
                    if (Object.keys(overrides).length > 0) extras.set(g.item_id, overrides);
                }
                return { access, extras };
            });
            restrictionCache.set(feature, loaded);
            return loaded;
        };
        const itemRestrictions = (feature: FeatureId): Promise<ReadonlyMap<string, ItemAccess>> =>
            itemGrants(feature).then((g) => g.access);
        const itemExtraOverrides = (feature: FeatureId): Promise<ReadonlyMap<string, ItemExtraOverrides>> =>
            itemGrants(feature).then((g) => g.extras);

        return {
            workspace: toContext(row),
            isAdmin: user.role === 'admin',
            isOwner,
            capabilities,
            features,
            channels,
            itemPermissions,
            extras,
            itemRestrictions,
            itemExtraOverrides,
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
    const { capabilities, features, channels, itemPermissions, extras } = grantsFor(isOwner, role);
    // Le propriétaire passe outre les surcharges, comme il passe outre tout le
    // reste : lui en envoyer laisserait croire qu'une ligne peut le brider.
    const overrides = role ? await db.itemSharing.allGrantsForRole(workspace.id, role.id) : [];
    return {
        isOwner,
        capabilities: [...capabilities],
        features: [...features].map(([feature, access]) => ({
            feature,
            access,
            channels: channels.has(feature),
            itemPermissions: itemPermissions.has(feature),
            extras: extras.get(feature) ?? {}
        })),
        itemOverrides: overrides.map((g) => ({
            feature: g.feature as FeatureId,
            itemId: g.item_id,
            access: g.access,
            extras: extraOverridesOf(g)
        }))
    };
}
