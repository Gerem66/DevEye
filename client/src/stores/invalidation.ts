import { LIVE_CHANGED_EVENT, liveChangedPushSchema, type LiveTopic } from '@deveye/types';
import { useCallback, useSyncExternalStore } from 'react';

import { ws } from '@/api/ws';

/**
 * Bus d'invalidation : « cette donnée a changé, re-sollicitez ». Deux sources, un
 * seul mécanisme : localement, une feature qui vient d'écrire appelle
 * `invalidate(key)` sans attendre l'aller-retour ; à distance, le serveur diffuse
 * `live.changed` après toute commande déclarant `mutates` et après une écriture
 * d'une tâche de fond.
 *
 * Les clés sont listées explicitement pour que l'ensemble des ressources
 * invalidables reste visible et sans faute de frappe. Par convention, une clé est
 * la commande WS dont elle met en cache le résultat.
 */
export type ResourceKey =
    /** Les canaux d'alerte, une seule clé pour toutes les fonctionnalités. */
    | 'notify.channelList'
    | 'notify.routeGet'
    /** Les domaines d'une fonctionnalité, une seule clé pour toutes. */
    | 'domain.list'
    | 'notes.count'
    | 'notes.list'
    | 'password.count'
    | 'password.list'
    | 'cloudSync.listShares'
    | 'mail.accountCount'
    | 'mail.accountList'
    | 'mail.getSettings'
    | 'mail.folderList'
    /** La tête de liste du dossier ouvert : fusionnée, jamais rechargée en entier. */
    | 'mail.messageList'
    | 'uptime.count'
    | 'uptime.list'
    | 'devices.list'
    | 'sentinel.count'
    | 'sentinel.overview'
    | 'sentinel.findings'
    | 'sentinel.baseline'
    | 'weather.list'
    | 'weather.keyList'
    | 'osint.history'
    | 'cve.news'
    | 'cve.favorites'
    | 'cve.keyList'
    | 'mailserver.count'
    | 'mailserver.list'
    | 'mailserver.get'
    | 'mailserver.appPasswordList'
    | 'mailserver.activity'
    | 'mailserver.queueList'
    | 'mailserver.serverStatus'
    | 'workspace.roleList'
    /** L'état de l'espace actif tel que `workspace.activate` le rend : droits, apparence, disposition. */
    | 'workspace.activate'
    /** Ce qui ne vit que dans le bundle de session (nom, logo, membres) : déclenche un `/me`, plus lourd. */
    | 'workspace.session'
    /** La page Utilisateurs : les comptes du site. */
    | 'admin.userList'
    | 'projects.count'
    | 'projects.list'
    | 'projects.board'
    | 'projects.myTasks'
    | 'projects.messages'
    | 'git.count'
    | 'git.list'
    | 'git.repo'
    | 'deploy.count'
    | 'deploy.list'
    | 'deploy.detail'
    | 'finance.summary'
    | 'finance.accountList'
    | 'finance.transactionList'
    | 'finance.budgetList'
    | 'finance.recurringList'
    | 'finance.overview'
    | 'database.count'
    | 'database.list'
    | 'database.detail'
    | 'backup.count'
    | 'backup.destinationList'
    | 'backup.jobList'
    | 'backup.detail'
    | 'backup.runs'
    | 'audience.count'
    | 'audience.list'
    | 'audience.detail'
    /** Les chiffres, séparés de la fiche : ils bougent à chaque minute d'ingestion. */
    | 'audience.stats'
    /** Les retours reçus : un formulaire, son tableau et ses résultats. */
    | 'audience.forms'
    /** Les clés d'un module externe (`<id>.<nom>`), déclarées par son manifest. */
    | ExternalResourceKey;

export type ExternalResourceKey = `x-${string}.${string}`;

/**
 * Ce qu'un sujet du serveur invalide chez nous, pour les sujets du socle. Le
 * serveur raisonne par feature, le client par commande : un sujet sans entrée
 * n'invalide rien, une nouvelle vue en cache doit s'y inscrire. Les sujets des
 * modules passent par la glue générée (`registerFeatureResources`,
 * `registerCrossTopicKeys`).
 */
const TOPIC_KEYS: Partial<Record<LiveTopic, ResourceKey[]>> = {
    notify: ['notify.channelList', 'notify.routeGet'],
    domain: ['domain.list'],
    /*
     * Un rôle modifié ou un membre retiré change les droits de chacun, y compris
     * ceux de qui ne regardait pas la page Espace : d'où `workspace.session`, dont
     * le `/me` rapatrie droits, apparence et disposition en plus des membres. Le
     * sujet `workspace` n'exige aucun droit de feature, donc la trame atteint
     * celui à qui on vient de tout retirer.
     */
    workspace: ['workspace.roleList', 'workspace.session'],
    /* L'accueil ou l'apparence de l'espace : `workspace.activate` seule, sans recharger la session. */
    home: ['workspace.activate'],
    /* Réglages de compte, diffusés dans l'espace personnel de leur auteur : rien de partagé à re-solliciter. */
    account: [],
    /* Un compte a changé : reçu par compte, jamais en salle. */
    admin: ['admin.userList']
};

/**
 * Anti-rebond de la réception. Doit rester strictement supérieur au plancher du
 * serveur (200 ms, voir `src/live/hub.ts`) : une écriture dont la trame a été
 * étouffée là-bas doit quand même être vue par la re-sollicitation déjà
 * programmée, sans quoi elle serait perdue.
 */
const REMOTE_DEBOUNCE_MS = 250;

const versions = new Map<ResourceKey, number>();
const listeners = new Map<ResourceKey, Set<() => void>>();

/** Bump one or more resources, re-fetching every view that reads them. */
export function invalidate(...keys: ResourceKey[]): void {
    for (const key of keys) {
        versions.set(key, (versions.get(key) ?? 0) + 1);
        listeners.get(key)?.forEach((fn) => fn());
    }
}

/** Version impérative de {@link useResourceVersion}, pour les stores singletons hors composant. */
export function onResourceChange(key: ResourceKey, fn: () => void): () => void {
    ensureWired();
    let set = listeners.get(key);
    if (!set) listeners.set(key, (set = new Set()));
    set.add(fn);
    return () => {
        set.delete(fn);
        if (set.size === 0) listeners.delete(key);
    };
}

/**
 * A value that changes whenever `invalidate(key)` is called. Thread it through
 * a fetch effect's dependencies to re-run the fetch on invalidation.
 */
export function useResourceVersion(key: ResourceKey): number {
    const subscribe = useCallback(
        (notify: () => void) => {
            ensureWired();
            let set = listeners.get(key);
            if (!set) listeners.set(key, (set = new Set()));
            set.add(notify);
            return () => {
                set.delete(notify);
                if (set.size === 0) listeners.delete(key);
            };
        },
        [key]
    );
    return useSyncExternalStore(subscribe, () => versions.get(key) ?? 0);
}

// ------------------------------------------------------------------ distant

let wired = false;
let pending = new Set<ResourceKey>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** Ce que le sujet d'un module externe invalide, enregistré par la glue générée. */
const EXTERNAL_TOPIC_KEYS = new Map<string, ResourceKey[]>();

/**
 * Les invalidations croisées déclarées par les modules (`alsoInvalidatedBy`) : le
 * sujet d'une autre feature ravive des clés du module, les partages CloudSync
 * portant par exemple le nom de leurs appareils.
 */
const CROSS_TOPIC_KEYS = new Map<string, ResourceKey[]>();

/** Déclare des invalidations croisées. Réservé à l'enregistrement des modules. */
export function registerCrossTopicKeys(topic: string, keys: readonly ResourceKey[]): void {
    CROSS_TOPIC_KEYS.set(topic, [...(CROSS_TOPIC_KEYS.get(topic) ?? []), ...keys]);
}

/**
 * Déclare les ressources d'un module : son sujet live (= son id) ou l'un de ses
 * sujets secondaires (`manifest.topics`) invalide les clés listées. L'équivalent
 * d'une entrée dans `TOPIC_KEYS`, réservé à la glue générée.
 */
export function registerFeatureResources(topic: string, invalidatedByTopic: readonly ResourceKey[]): void {
    EXTERNAL_TOPIC_KEYS.set(topic, [...invalidatedByTopic]);
}

function keysOfTopic(topic: string): ResourceKey[] {
    return [
        ...(TOPIC_KEYS[topic as LiveTopic] ?? []),
        ...(EXTERNAL_TOPIC_KEYS.get(topic) ?? []),
        ...(CROSS_TOPIC_KEYS.get(topic) ?? [])
    ];
}

/**
 * Tout ce qu'un sujet ravive, chez l'auteur de l'écriture : le hub ne lui
 * renvoie pas sa propre trame, et un `invalidate` de la seule clé native
 * manquerait les clés que des modules y ont accrochées (`alsoInvalidatedBy`).
 */
export function invalidateTopic(topic: LiveTopic): void {
    invalidate(...keysOfTopic(topic));
}

/** Branché à la première lecture : sans abonné, il n'y a rien à invalider. */
export function ensureWired(): void {
    if (wired) return;
    wired = true;

    ws.onMessage((msg) => {
        if (msg.command !== LIVE_CHANGED_EVENT || !msg.payload.ok) return;
        const push = liveChangedPushSchema.safeParse(msg.payload.data);
        if (!push.success) return;

        for (const topic of push.data.topics) {
            for (const key of keysOfTopic(topic)) pending.add(key);
        }
        if (pending.size === 0) return;

        // Une rafale d'écritures, tel un réordonnancement, ne doit produire qu'une
        // seule re-sollicitation.
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
            flushTimer = null;
            const keys = [...pending];
            pending = new Set();
            invalidate(...keys);
        }, REMOTE_DEBOUNCE_MS);
    });
}
