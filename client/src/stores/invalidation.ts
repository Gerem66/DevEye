import { LIVE_CHANGED_EVENT, liveChangedPushSchema, type LiveTopic } from 'deveye-types';
import { useCallback, useSyncExternalStore } from 'react';

import { ws } from '@/api/ws';

/**
 * Bus d'invalidation : « cette donnée a changé, re-sollicitez ».
 *
 * Deux sources, un seul mécanisme :
 *  - **locale** — une feature qui vient d'écrire appelle `invalidate(key)` pour
 *    rafraîchir ses propres vues sans attendre l'aller-retour du serveur ;
 *  - **distante** — le serveur diffuse `live.changed` après toute commande
 *    déclarant `mutates`, et après une écriture d'une tâche de fond. C'est ce
 *    qui fait qu'une note écrite par quelqu'un d'autre apparaît sans recharger.
 *
 * Les clés sont listées explicitement (comme les registres de features) pour que
 * l'ensemble des ressources invalidables reste visible et sans faute de frappe.
 * Par convention, une clé est la commande WS dont elle met en cache le résultat.
 */
export type ResourceKey =
    | 'note.count'
    | 'note.list'
    | 'password.count'
    | 'password.list'
    | 'cloudSync.listShares'
    | 'mail.accountCount'
    | 'mail.accountList'
    /** L'arborescence du compte ouvert — c'est elle qui porte les compteurs de non-lus. */
    | 'mail.folderList'
    /** La tête de liste du dossier ouvert. Fusionnée, jamais rechargée en entier : voir `Features/Mail/index.tsx`. */
    | 'mail.messageList'
    | 'uptime.count'
    | 'uptime.list'
    | 'device.list'
    | 'weather.list'
    | 'workspace.roleList'
    /**
     * L'état de l'espace actif tel que `workspace.activate` le rend : droits de
     * l'appelant, apparence, disposition de l'accueil. Trois choses, une clé,
     * parce qu'une seule commande les rend toutes les trois — les séparer ne
     * ferait que multiplier les allers-retours pour un même rafraîchissement.
     */
    | 'workspace.activate'
    /**
     * Ce qui ne vit que dans le bundle de session : nom et logo de l'espace,
     * liste de ses membres. Rien ne les relit à la commande, d'où une clé à part
     * — elle déclenche un `/me`, plus lourd, réservé à ce qui le vaut.
     */
    | 'workspace.session'
    | 'project.count'
    | 'project.list'
    | 'project.board'
    | 'project.myTasks'
    | 'project.messages'
    | 'git.count'
    | 'git.list'
    | 'git.repo'
    | 'database.count'
    | 'database.list'
    | 'database.detail';

/**
 * Ce qu'un sujet du serveur invalide chez nous.
 *
 * La correspondance est explicite parce que les deux vocabulaires ne coïncident
 * pas : le serveur raisonne par feature (`notes`), le client par commande
 * (`note.count`, `note.list`). Un sujet sans entrée ici n'invalide rien — ce qui
 * est le bon défaut, mais explique pourquoi une nouvelle vue en cache doit
 * penser à s'y inscrire.
 */
const TOPIC_KEYS: Record<LiveTopic, ResourceKey[]> = {
    notes: ['note.count', 'note.list'],
    password: ['password.count', 'password.list'],
    cloudsync: ['cloudSync.listShares'],
    // La relève de fond ne bouge pas que les cartes de comptes : elle fait entrer
    // des messages, corrige des drapeaux et retire des lignes disparues. Sans les
    // deux dernières clés, seule la date « il y a X min » se rafraîchissait, et
    // une boîte laissée ouverte mentait jusqu'au prochain clic.
    mail: ['mail.accountCount', 'mail.accountList', 'mail.folderList', 'mail.messageList'],
    uptime: ['uptime.count', 'uptime.list'],
    devices: ['device.list'],
    weather: ['weather.list'],
    // Deux sujets pour une seule feature : la structure d'un côté, les fils de
    // discussion de l'autre. Un message ne doit pas faire re-solliciter le
    // portefeuille entier — d'où la coupure côté serveur (`domain/live.ts`).
    projects: ['project.count', 'project.list', 'project.board', 'project.myTasks'],
    // Le portefeuille affiche le compte de non-lus : un message venu d'ailleurs
    // doit donc le rafraîchir lui aussi.
    projectsChat: ['project.messages', 'project.list'],
    // Un dépôt qui bouge touche la liste (dates de synchro, compteurs) et la vue
    // ouverte. `git.count` suit pour la tuile de l'accueil.
    git: ['git.count', 'git.list', 'git.repo'],
    // Un relevé qui aboutit touche la liste (état, taille, alertes franchies) et
    // la fiche ouverte. `database.count` suit pour la tuile de l'accueil.
    database: ['database.count', 'database.list', 'database.detail'],
    /*
     * Un rôle modifié, un membre ajouté ou retiré, l'espace renommé : la liste
     * des rôles bouge, mais **les droits de chacun aussi** — y compris ceux de
     * qui ne regardait pas la page Espace. C'est ce second effet qui fait qu'une
     * feature se grise (ou se dégrise) chez ses membres sans qu'ils rechargent,
     * et qu'une vue dont on vient de perdre l'accès se referme d'elle-même.
     *
     * `workspace.session` et non `workspace.activate` : le `/me` qu'elle
     * déclenche rapatrie le nom, le logo et les membres — que `workspace.activate`
     * ne rend pas — *et* les droits, l'apparence et la disposition au passage.
     * Demander les deux ferait deux allers-retours pour un seul changement.
     *
     * Le sujet `workspace` n'exige aucun droit de feature (`TOPIC_FEATURE`), donc
     * la trame atteint bien celui à qui on vient de tout retirer.
     */
    workspace: ['workspace.roleList', 'workspace.session'],
    /*
     * L'accueil de l'espace : quelqu'un a réorganisé les tuiles ou changé
     * l'apparence, et c'est commun à tous ses membres. La voie légère —
     * `workspace.activate` seule, sans recharger la session.
     */
    home: ['workspace.activate'],
    /*
     * Réglages de compte. Diffusés dans l'espace **personnel** de leur auteur,
     * donc reçus par ses seuls autres onglets : rien de partagé à re-solliciter.
     */
    account: []
};

/**
 * Anti-rebond de la réception.
 *
 * **Doit rester strictement supérieur au plancher du serveur** (200 ms, voir
 * `src/live/hub.ts`) : une écriture dont la trame a été étouffée là-bas doit
 * quand même être vue par la re-sollicitation que la trame précédente a déjà
 * programmée. Descendre en dessous ouvrirait une fenêtre d'écritures perdues.
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

/**
 * Version impérative de {@link useResourceVersion}, pour les stores singletons
 * qui ne vivent pas dans un composant. C'est ce qui a remplacé leurs sondages
 * périodiques : ils se rafraîchissent quand la donnée bouge, et jamais sinon.
 */
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

/**
 * Branché à la première lecture, jamais au chargement du module : sans
 * abonné, il n'y a rien à invalider.
 */
export function ensureWired(): void {
    if (wired) return;
    wired = true;

    ws.onMessage((msg) => {
        if (msg.command !== LIVE_CHANGED_EVENT || !msg.payload.ok) return;
        const push = liveChangedPushSchema.safeParse(msg.payload.data);
        if (!push.success) return;

        for (const topic of push.data.topics) {
            for (const key of TOPIC_KEYS[topic]) pending.add(key);
        }
        if (pending.size === 0) return;

        // Regroupé : une rafale d'écritures — un glisser-déposer qui réordonne
        // dix éléments — ne doit produire qu'une seule re-sollicitation.
        if (flushTimer) return;
        flushTimer = setTimeout(() => {
            flushTimer = null;
            const keys = [...pending];
            pending = new Set();
            invalidate(...keys);
        }, REMOTE_DEBOUNCE_MS);
    });
}
