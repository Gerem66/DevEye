import type { CloudSyncEngine } from '@/cloudSync/engine';
import type { Database } from '@/db';
import type Encryption from '@/Services/Encryption';
import type { SecureStore } from '@/Services/SecureStore';
import type { SecretKeyService } from '@/Services/SecretKeyService';
import type { MonitorTransport } from '@/agent/hub';
import type { LiveTransport } from '@/live/hub';
import type { UptimeMonitor } from '@/Services/UptimeMonitor';
import type { ErrorCode, LiveTopic, LogLevelName } from 'deveye-types';
import type { Logger } from 'pino';
import type { FeatureAccess, WorkspaceCapability, WorkspaceFeatureId } from 'deveye-types';
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
    /** Defaults to the command's prefix (e.g. `note` for `note.add`). */
    category?: string;
    metadata?: Record<string, unknown> | null;
}

export interface FeatureContext {
    db: Database;
    /**
     * Raw server-key cipher. Reserved for auth-bound secrets that must be
     * readable without a live user password (e.g. the 2FA secret). Feature data
     * at rest must go through `secure` instead, never `crypt` directly.
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
    canFeature: (feature: WorkspaceFeatureId, level?: FeatureAccess) => boolean;
    /** Lève `forbidden` si la feature n'est pas accessible à ce niveau. */
    assertFeature: (feature: WorkspaceFeatureId, level?: FeatureAccess) => void;
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
    /** CloudSync orchestrator (sessions, versions, blob store). Absent in tests. */
    cloudSync?: CloudSyncEngine;
    /** Uptime scheduler — backs the "check now" and "test notification" commands. */
    uptime?: UptimeMonitor;
}

/**
 * Thrown by a feature handler to send a typed error back to the client.
 * The dispatcher converts it into a `protocolError` payload; anything else is
 * mapped to `internal`.
 */
export class FeatureError extends Error {
    constructor(
        public readonly code: ErrorCode,
        message: string,
        public readonly details?: unknown
    ) {
        super(message);
        this.name = 'FeatureError';
    }
}

/**
 * Authorization a command requires, declared beside its schemas and enforced by
 * the WS dispatcher **before** the handler runs — exactly like the zod input
 * validation already is.
 *
 * Declaring it here rather than as the first line of each handler makes the whole
 * authorization surface greppable from the feature registry, and makes "I forgot
 * the guard" a visible omission instead of an invisible one.
 *
 * Commands whose check depends on the *row* being touched (owner-or-admin, e.g.
 * `device.setConfig`) keep their guard in the handler and read `ctx.isAdmin`.
 */
export interface FeatureAccessSpec {
    /**
     * Feature à laquelle la commande touche, et niveau requis (`read` par
     * défaut). Le membre dont le rôle ne l'accorde pas reçoit `forbidden` — et
     * l'interface ne lui montre même pas l'entrée.
     */
    feature?: WorkspaceFeatureId;
    level?: FeatureAccess;
    /** Capacités de gouvernance exigées, toutes nécessaires. */
    capabilities?: WorkspaceCapability[];
    /** Global account admin: the device fleet and the system pages. */
    admin?: true;
    /**
     * Commande de **compte** et non d'espace (secrecy, 2FA, avatar, mot de
     * passe). Le dispatcheur force alors `ctx.workspace` sur l'espace personnel
     * de l'appelant, quoi que dise l'enveloppe : `ctx.secure` reste son propre
     * coffre, et une enveloppe pointant un espace partagé ne peut pas détourner
     * une commande comme `secrecy.enable`.
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
     * Cette commande **écrit** : après un succès, le dispatcheur en avertit
     * l'espace, et toute vue qui lit ce sujet se remet à jour d'elle-même.
     *
     * Déclaré ici pour la même raison qu'`access` : posé à côté des schémas, un
     * oubli devient une omission visible plutôt qu'invisible. Et comme les
     * sondages périodiques ont disparu du client, un oubli se voit — la donnée
     * reste figée jusqu'au rechargement. Le contrôle de démarrage
     * (`_topics.ts`) est là pour l'attraper avant.
     *
     * `true` déduit le sujet du préfixe de la commande via `COMMAND_PREFIX_TOPIC`
     * (`note.add` → `notes`, `folder.add` → `notes` aussi, ce sont les dossiers
     * de notes). Une liste explicite sert aux commandes à double effet.
     *
     * Absent = lecture, ou action sans écriture (`metrics.subscribe`,
     * `secrecy.unlock`, un appel RPC vers un agent).
     */
    mutates?: true | readonly LiveTopic[];
    handler: (ctx: FeatureContext, input: z.infer<I>) => Promise<z.infer<O>>;
}

export function defineFeature<Cmd extends string, I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    def: FeatureDefinition<Cmd, I, O>
): FeatureDefinition<Cmd, I, O> {
    return def;
}
