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
    /**
     * Les canaux d'alerte de l'espace.
     *
     * Une seule clé pour toutes les fonctionnalités : un canal appartient à
     * l'espace, donc le corriger change ce que voit l'écran de réglages de
     * chacune d'elles. Le routage suit dans `notify.routeGet`, relu par la
     * coquille ouverte.
     */
    | 'notify.channelList'
    | 'notify.routeGet'
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
    | 'sentinel.count'
    | 'sentinel.overview'
    | 'sentinel.findings'
    | 'sentinel.baseline'
    | 'weather.list'
    /** L'historique des recherches OSINT — lu par l'écran et par la carte d'accueil. */
    | 'osint.history'
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
    | 'deploy.count'
    | 'deploy.list'
    /** La fiche d'une cible : son historique et les projets qui la déploient. */
    | 'deploy.detail'
    /**
     * Les finances. Six clés, parce qu'une écriture des finances remue plusieurs
     * vues à la fois (une dépense change le journal, un solde, un budget, la
     * frise du tableau de bord et la carte de l'accueil) et que chacune de ces
     * vues n'a aucune raison de relire les cinq autres. `Features/Finance/api.ts`
     * les invalide ensemble, une fois, à la source de la mutation.
     */
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
    /** La fiche d'un travail : ses réglages et son historique d'exécutions. */
    | 'backup.detail'
    /** Le journal transverse : les dernières exécutions, tous travaux confondus. */
    | 'backup.runs'
    | 'audience.count'
    | 'audience.list'
    /** La fiche d'un site : ses réglages, sa clé, les projets qui le suivent. */
    | 'audience.detail'
    /**
     * Les chiffres eux-mêmes, séparés de la fiche exprès.
     *
     * Ils ne changent pas au même rythme : la fiche bouge quand un humain règle
     * quelque chose, les chiffres à chaque minute d'ingestion. Les confondre
     * aurait fait relire les réglages — et rouvrir la liste des projets liés —
     * à chaque battement de l'audience.
     */
    | 'audience.stats';

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
    notify: ['notify.channelList', 'notify.routeGet'],
    notes: ['note.count', 'note.list'],
    password: ['password.count', 'password.list'],
    cloudsync: ['cloudSync.listShares'],
    // La relève de fond ne bouge pas que les cartes de comptes : elle fait entrer
    // des messages, corrige des drapeaux et retire des lignes disparues. Sans les
    // deux dernières clés, seule la date « il y a X min » se rafraîchissait, et
    // une boîte laissée ouverte mentait jusqu'au prochain clic.
    mail: ['mail.accountCount', 'mail.accountList', 'mail.folderList', 'mail.messageList'],
    uptime: ['uptime.count', 'uptime.list'],
    /*
     * `cloudSync.listShares` en second : la liste des partages embarque les
     * appareils ATTACHÉS, dont le statut d'attache et le dossier local. Ces
     * champs-là appartiennent au partage, mais ils n'existent que pour des
     * appareils qui, eux, peuvent disparaître, revenir ou être renommés.
     *
     * Sans cette clé, attacher un appareil depuis un autre onglet — ou en voir
     * un redevenir attachable après une mise à jour d'agent — n'apparaissait
     * qu'au rechargement complet de la page.
     *
     * Le nom et la présence, eux, ne passent PAS par là : ils sont recomposés
     * au rendu depuis le store `devices` (`useShareDevices`), donc sans le
     * moindre aller-retour.
     */
    devices: ['device.list', 'cloudSync.listShares'],
    /*
     * Sujet distinct de `devices`, et non un alias : les constats bougent à
     * chaque tour du moteur, la liste d'appareils presque jamais. Les confondre
     * ferait re-solliciter toute la flotte à chaque évaluation.
     *
     * `sentinel.count` en tête : c'est la seule clé que la carte de l'accueil et
     * la pastille de Monitoring écoutent, et celle qui doit bouger le plus vite.
     */
    sentinel: ['sentinel.count', 'sentinel.overview', 'sentinel.findings', 'sentinel.baseline'],
    weather: ['weather.list'],
    // Une seule clé : les résultats de sonde ne sont pas une ressource partagée
    // (ils se relisent à la demande, depuis le cache du serveur). Seul
    // l'historique est un état d'espace, donc seul lui se diffuse.
    osint: ['osint.history'],
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
    /*
     * Un déploiement qui change d'état touche la liste (dernier état, date) et
     * la fiche ouverte. `deploy.count` suit pour la tuile de l'accueil.
     *
     * Le sujet bat surtout au rythme du suivi de fond, qui réinterroge Dokploy
     * sur les déploiements en vol : c'est ce qui fait avancer « En cours » vers
     * « Réussi » sous les yeux, sans sondage côté navigateur.
     */
    deploy: ['deploy.count', 'deploy.list', 'deploy.detail'],
    // Un relevé qui aboutit touche la liste (état, taille, alertes franchies) et
    // la fiche ouverte. `database.count` suit pour la tuile de l'accueil.
    database: ['database.count', 'database.list', 'database.detail'],
    /*
     * Les cinq clés ensemble, parce qu'une seule exécution les remue toutes :
     * elle change l'état du travail (liste), son historique (fiche), le journal
     * transverse, et le compte d'échecs de la tuile d'accueil. Le contrôle d'une
     * destination y touche aussi, en écrivant son verdict sur la ligne.
     *
     * Le sujet bat surtout au rythme de l'ordonnanceur, qui écrit sans qu'aucun
     * navigateur n'ait rien demandé : c'est ce qui fait passer un travail de
     * « en cours » à « réussi » sous les yeux, à 3 h du matin comme à midi.
     */
    backup: ['backup.count', 'backup.destinationList', 'backup.jobList', 'backup.detail', 'backup.runs'],
    /*
     * Les six clés ensemble, et c'est le sujet.
     *
     * Une écriture des finances remue plusieurs vues à la fois : une dépense
     * change le journal, le solde de son compte, un budget, la frise du tableau
     * de bord et la carte de l'accueil. N'en invalider qu'une partie ferait
     * diverger deux écrans de la même donnée à la même seconde, chez la même
     * personne. Sur un livre de comptes, cela se lit comme une erreur de calcul
     * et non comme un retard d'affichage.
     *
     * Le sujet bat aussi quand le rattrapage des échéances écrit tout seul
     * (`postDueRecurring`, en tête de chaque lecture) : c'est ce qui fait
     * apparaître un loyer prélevé sans que personne n'ait rien saisi.
     */
    finance: [
        'finance.summary',
        'finance.accountList',
        'finance.transactionList',
        'finance.budgetList',
        'finance.recurringList',
        'finance.overview'
    ],
    /*
     * **Les quatre clés ensemble, et c'est le sujet.**
     *
     * Ce battement vient presque toujours de l'ingestion publique, qui le
     * coalesce à une fois par minute et par espace. Il doit donc rafraîchir d'un
     * seul coup tout ce qui montre de l'audience, où que ce soit : la tuile de
     * l'accueil, la liste des sites, la fiche ouverte et l'onglet Audience d'un
     * projet. N'en invalider qu'une partie ferait diverger deux écrans de la
     * même donnée à la même seconde, chez la même personne.
     *
     * `audience.stats` est distincte de `audience.detail` pour la raison
     * inverse : une mutation humaine (réglage, rotation de clé) n'a aucune
     * raison de faire relire six requêtes d'agrégat.
     */
    audience: ['audience.count', 'audience.list', 'audience.detail', 'audience.stats'],
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
