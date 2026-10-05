import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { SecureStore } from '@/Services/SecureStore';
import type { SecretKeyService } from '@/Services/SecretKeyService';
import type { MonitorTransport } from '@/agent/hub';
import type { LiveTransport } from '@/live/hub';
import type { LiveTopic, LogLevelName } from '@deveye/types';
import type { Logger } from 'pino';
import type { CommandProgress } from '@deveye/types/sdk/server';
import type { FeatureAccess, FeatureId, ItemAccess, ItemExtraOverrides, WorkspaceCapability } from '@deveye/types';
import type { WorkspaceContext } from './_access';
import type { z } from 'zod';

/**
 * An audit event emitted from inside a feature handler. The actor (`uid`, `ip`),
 * channel (`source: web`) and a default `category` (the command's prefix) are
 * filled in by the dispatcher — the handler only describes the event. Provide
 * `category` explicitly to attribute the log to a different subsystem.
 */
export interface FeatureAuditEntry {
    level?: LogLevelName;
    /** Stable dotted event key, e.g. `note.create`. */
    action: string;
    description: string;
    /** Defaults to the command's prefix (e.g. `notes` for `notes.add`). */
    category?: string;
    metadata?: Record<string, unknown> | null;
}

export interface FeatureContext {
    db: Database;
    /**
     * The server-key seal (`seal`/`open`). Reserved for auth-bound secrets that
     * must be readable without a live user password (e.g. the 2FA secret).
     * Feature data at rest must go through `secure` instead, never `crypt`.
     */
    crypt: Encryption;
    /**
     * Unified storage-encryption gateway. The ONLY way features persist or read
     * encrypted data — it transparently applies per-user (and, when enabled,
     * password-based) encryption. Features never touch keys or wrapping.
     */
    secure: SecureStore;
    /** Envelope-key authority backing `secure`; used by the secrecy handlers. */
    secretKeys: SecretKeyService;
    userId: number;
    sessionId: string;
    /**
     * L'espace visé par la commande, résolu depuis l'enveloppe WS (ou l'espace
     * personnel de l'appelant à défaut). L'appartenance est déjà vérifiée : un
     * handler peut s'y fier sans garde supplémentaire.
     */
    workspace: WorkspaceContext;
    /** Raccourci vers `workspace.id` — la valeur sur laquelle filtrent les repos. */
    workspaceId: number;
    /** L'appelant possède cet espace (tous les droits, non révocables). */
    isOwner: boolean;
    /** Une capacité de gouvernance de l'espace est-elle accordée ? Synchrone : le
     *  jeu de droits est résolu avant l'appel du handler. */
    can: (capability: WorkspaceCapability) => boolean;
    /** Lève `forbidden` si la capacité manque. */
    assertCan: (capability: WorkspaceCapability) => void;
    /** Une feature est-elle accessible, au moins au niveau demandé (défaut `read`) ? */
    canFeature: (feature: FeatureId, level?: FeatureAccess) => boolean;
    /** Lève `forbidden` si la feature n'est pas accessible à ce niveau. */
    assertFeature: (feature: FeatureId, level?: FeatureAccess) => void;
    /**
     * L'appelant gère-t-il les **canaux d'alerte** de cette feature ? Exige la
     * lecture de la feature en plus du champ `channels` de son grant : on ne
     * gère pas les destinations d'une fonctionnalité qu'on ne voit pas.
     */
    canChannels: (feature: FeatureId) => boolean;
    /** Lève `forbidden` si l'appelant ne gère pas les canaux de cette feature. */
    assertChannels: (feature: FeatureId) => void;
    /**
     * L'appelant règle-t-il les permissions par élément de cette feature ? Le
     * champ `itemPermissions` de son grant, ou la capacité `workspace.roles` qui
     * l'englobe. Exige la lecture de la feature, comme les canaux.
     */
    canManageItemGrants: (feature: FeatureId) => boolean;
    /**
     * Les éléments d'une feature que le rôle de l'appelant voit autrement :
     * `'none'` masqué, `'read'` en lecture seule. Restrictif seulement : la
     * carte ne peut qu'abaisser ce que `canFeature` accorde. Les listages s'en
     * servent pour filtrer ; les commandes visant un élément passent par `assertItem`.
     */
    itemRestrictions: (feature: FeatureId) => Promise<ReadonlyMap<string, ItemAccess>>;
    /**
     * Les permissions propres que cet élément-ci accorde ou retire au rôle de
     * l'appelant. `assertItem` s'en sert déjà pour les permissions que LA
     * COMMANDE déclare ; une garde écrite à la main n'a besoin d'y descendre que
     * si elle vise une autre clé que la sienne.
     */
    itemExtraOverrides: (feature: FeatureId) => Promise<ReadonlyMap<string, ItemExtraOverrides>>;
    /**
     * Lève `forbidden` si cet élément retire au rôle une des permissions que la
     * commande en cours déclare (`access.extras`). Compris dans `assertItem` ;
     * à appeler seul par une garde qui vérifie le niveau autrement, comme
     * l'accès aux agents, où piloter une machine ne suppose pas l'écriture sur
     * la flotte.
     */
    assertItemExtras: (feature: FeatureId, itemId: string) => Promise<void>;
    /**
     * Lève `forbidden` si cet élément précis n'est pas accessible au niveau
     * demandé, restriction de rôle comprise. Vérifie d'abord la feature : une
     * restriction d'élément n'ouvre jamais ce qu'un droit de feature ferme.
     *
     * Vérifie aussi les permissions propres que la commande en cours déclare
     * (`access.extras`) contre cet élément : le dispatcheur les a appliquées à
     * l'échelle de la fonctionnalité, sans connaître la cible. C'est ici, où
     * l'élément est enfin nommé, que le refus posé sur lui mord.
     */
    assertItem: (feature: FeatureId, itemId: string, level?: FeatureAccess) => Promise<void>;
    /**
     * Les permissions déclarées d'une feature (`extras` du grant), brutes.
     * Vide pour le propriétaire : c'est le lecteur (l'adaptateur SDK) qui
     * résout défauts et propriétaire contre les specs du manifest.
     */
    extrasFor: (feature: FeatureId) => Record<string, boolean | string>;
    /**
     * Caller holds the global `admin` role. Resolved by the dispatcher before the
     * handler runs, so guards read it synchronously and never query the role.
     * Gates the device fleet and the system pages — never other users' data.
     */
    isAdmin: boolean;
    /** Throw `forbidden` unless the caller is a global admin. */
    assertAdmin: () => void;
    /** Client IP of the connection (proxy-aware), recorded on audit events. */
    ip: string;
    logger: Logger;
    requestId: string;
    /** Avancement poussé au seul appelant ; absent hors socket (tests). */
    progress?: (update: CommandProgress) => void;
    /**
     * Emit an audit log for this action. Fire-and-forget — never awaits the DB
     * write and never throws into the handler. The actor, channel and a default
     * category are pre-bound from the request context.
     */
    audit: (entry: FeatureAuditEntry) => void;
    /** Present only on the live WS connection; enables metric subscriptions. */
    monitor?: MonitorTransport;
    /**
     * Présence en direct, liée à cette connexion. Absent hors socket (tests).
     * Ne sert qu'à *déclarer* : la diffusion des changements est faite par le
     * dispatcheur depuis `mutates`, jamais par un handler.
     */
    live?: LiveTransport;
}

/**
 * Thrown by a feature handler to send a typed error back to the client.
 * The dispatcher converts it into a `protocolError` payload; anything else is
 * mapped to `internal`. One definition shared with the modules
 * (`@deveye/types/sdk/server`), so the dispatcher's `instanceof` matches both.
 */
export { FeatureError } from '@deveye/types/sdk/server';

/**
 * Authorization a command requires, declared beside its schemas and enforced by
 * the WS dispatcher before the handler runs: the whole authorization surface is
 * greppable, and a forgotten guard is a visible omission. Commands whose check
 * depends on the row being touched keep their guard in the handler.
 */
export interface FeatureAccessSpec {
    /**
     * Feature à laquelle la commande touche, et niveau requis (`read` par
     * défaut). Le membre dont le rôle ne l'accorde pas reçoit `forbidden` — et
     * l'interface ne lui montre même pas l'entrée.
     */
    feature?: FeatureId;
    level?: FeatureAccess;
    /**
     * Permissions propres à `feature` (ses `extraPermissions`), toutes exigées
     * en plus du niveau. Ce que le SDK offre déjà à un module pour ses propres
     * commandes : les commandes de transport de l'app, qui vivent ici, en ont
     * besoin aussi pour se ranger derrière les droits de la feature qu'elles
     * servent (`agent.*` derrière ceux d'Appareils).
     */
    extras?: readonly string[];
    /** Capacités de gouvernance exigées, toutes nécessaires. */
    capabilities?: WorkspaceCapability[];
    /** Global account admin: the device fleet and the system pages. */
    admin?: true;
    /**
     * Commande de compte et non d'espace (secrecy, 2FA, avatar) : le
     * dispatcheur force `ctx.workspace` sur l'espace personnel de l'appelant,
     * quoi que dise l'enveloppe, pour que `ctx.secure` reste son propre coffre.
     */
    scope?: 'account';
}

export interface FeatureDefinition<Cmd extends string, I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
    command: Cmd;
    input: I;
    output: O;
    /** Enforced by the dispatcher before `handler` is called. */
    access?: FeatureAccessSpec;
    /**
     * Cette commande écrit : après un succès, le dispatcheur en avertit
     * l'espace, et toute vue qui lit ce sujet se remet à jour. Un oubli fige la
     * donnée jusqu'au rechargement ; le contrôle de démarrage (`_topics.ts`)
     * l'attrape. `true` déduit le sujet du préfixe via `COMMAND_PREFIX_TOPIC` ;
     * une liste explicite sert aux commandes à double effet. Absent = lecture,
     * ou action sans écriture.
     */
    mutates?: true | readonly LiveTopic[];
    handler: (ctx: FeatureContext, input: z.infer<I>) => Promise<z.infer<O>>;
}

export function defineFeature<Cmd extends string, I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    def: FeatureDefinition<Cmd, I, O>
): FeatureDefinition<Cmd, I, O> {
    return def;
}
