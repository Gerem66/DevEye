import { isExternalFeatureId, nativeLiveTopicSchema, type LiveTopic } from '@deveye/types';

import { logger } from '@/logger';
import { moduleTopics } from './_sdk/register';
import { featureHandlers } from './registry';

/**
 * De quel sujet relève chaque commande, pour que le dispatcheur sache qui
 * avertir après une écriture.
 *
 * **Table explicite, jamais le préfixe brut.** Plusieurs préfixes seraient
 * faux : `agent.*` (le transport) et `devices.*` (la feature) désignent tous
 * deux les appareils, et
 * `home`, `workspace`, `user`, `secrecy`, `twofa`, `admin` ne correspondent à
 * aucune feature d'espace. Un préfixe absent
 * de cette table **fait échouer le démarrage** plutôt que de diffuser un sujet
 * inventé — c'est un contrat, pas une heuristique.
 */
const COMMAND_PREFIX_TOPIC: Record<string, LiveTopic | null> = {
    admin: 'workspace',
    // Le transport des agents : des relais vers l'agent d'un appareil, sans
    // état côté serveur, sauf trois `mutates` (autostart, élévation,
    // rétrogradation) qui changent ce que la liste d'appareils affiche.
    agent: 'devices',
    // Même forme que `git` et `database` : préfixe unique, verbes en camelCase
    // derrière le point. Le filet `MUTATION_VERB` n'en voit donc **aucune** —
    // les `mutates` de cette feature se relisent à la main.
    //
    // ⚠️ Le gros du trafic de ce sujet ne passe pas par une commande du tout :
    // l'ingestion publique écrit sans socket et diffuse elle-même, coalescée à
    // une fois par minute et par espace (le service du module,
    // `features/audience/src/server/service.ts`, par `deps.live.changed`).
    audience: 'audience',
    // Même forme que `git`, `database` et `deploy` : préfixe unique, verbes en
    // camelCase derrière le point. Le filet `MUTATION_VERB` n'en voit donc
    // presque aucune — les `mutates` de cette feature se relisent à la main.
    backup: 'backup',
    cloudSync: 'cloudsync',
    // Même forme que `git` : préfixe unique, verbes en camelCase derrière le
    // point. Le filet `MUTATION_VERB` n'en voit donc presque aucune — les
    // `mutates` de cette feature se relisent à la main.
    database: 'database',
    // Même forme que `git`, et pour cause : c'est le même renversement, appliqué
    // au dernier module resté une propriété d'un projet (migration 080). Verbes
    // en camelCase derrière un préfixe unique, donc `mutates` à relire à la main.
    deploy: 'deploy',
    // Module à id natif depuis son rapatriement (`features/devices`) : le
    // préfixe reste dans la table parce que l'id n'est pas externe. Ses verbes
    // simples (`confirm`, `revoke`, `rename`, `setConfig`...) tombent dans le
    // filet `MUTATION_VERB` ; les autres (`requestDelete`, `forceDelete`,
    // `linkCodeCreate`...) se relisent à la main, le test du module s'en charge.
    devices: 'devices',
    // Même forme que `git`, `database` et `audience` : préfixe unique, verbes en
    // camelCase derrière le point. Le filet `MUTATION_VERB` n'en voit donc
    // **aucune** ; les `mutates` de cette feature se relisent à la main.
    finance: 'finance',
    // Même forme que `deploy` : préfixe unique, verbes en camelCase derrière le
    // point. Le filet `MUTATION_VERB` plus bas n'en verra donc **aucune** — les
    // `mutates` de cette feature se relisent à la main.
    git: 'git',
    home: 'home',
    live: null,
    logs: null,
    mail: 'mail',
    // Préfixe unique depuis le rapatriement en module : les dossiers, qui
    // avaient le leur (`folder.*`), sont passés en verbes camelCase derrière
    // le point (`notes.folderAdd`). Le filet `MUTATION_VERB` voit les verbes
    // simples des notes (`add`, `edit`, `delete`...) mais aucun des dossiers :
    // leurs `mutates` se relisent à la main.
    notes: 'notes',
    // Même forme que `git` et `database` : préfixe unique, verbes en camelCase
    // derrière le point. Le filet `MUTATION_VERB` n'en voit donc **aucune** —
    // les `mutates` de cette feature se relisent à la main.
    notify: 'notify',
    // Une projection change ce qui est visible dans **deux** espaces, et une
    // restriction change ce que voit un rôle. Faute d'un sujet qui dise « les
    // deux à la fois », il retombe sur celui de l'espace — c'est le plus large,
    // et ces mutations sont rares.
    share: 'workspace',
    // Même forme que `git` et `database` : préfixe unique, verbes en camelCase
    // derrière le point. Le filet `MUTATION_VERB` n'en voit donc presque aucune
    // — les `mutates` de cette feature se relisent à la main.
    osint: 'osint',
    password: 'password',
    // Préfixe unique du module Projets (son id : l'ancien `project.` ne tenait
    // qu'à l'usage natif), verbes en camelCase derrière le point, donc
    // `mutates` à relire à la main (le test du module s'en charge). Les
    // commandes de discussion nomment `['projectsChat']`, le sujet secondaire
    // que son manifest déclare : un message ne doit pas faire re-solliciter
    // le tableau et la frise entiers.
    projects: 'projects',
    secrecy: 'account',
    // Sentinelle a son propre sujet, distinct de `devices` : ses constats
    // changent à une tout autre cadence que la liste d'appareils, et les
    // confondre ferait re-solliciter toute la flotte à chaque évaluation.
    sentinel: 'sentinel',
    twofa: 'account',
    uptime: 'uptime',
    user: 'account',
    weather: 'weather',
    workspace: 'workspace'
};

function prefixOf(command: string): string {
    const i = command.indexOf('.');
    return i === -1 ? command : command.slice(0, i);
}

/**
 * Résolu **une fois au démarrage** : le dispatcheur ne fait qu'une lecture de
 * Map par commande, jamais un calcul.
 */
const TOPICS_BY_COMMAND = new Map<string, readonly LiveTopic[]>();

/**
 * Un sujet qu'une commande peut battre : natif, ou déclaré par un module
 * installé (son id, ses sujets secondaires). Les sujets des modules sont lus
 * dans leur registre à l'appel : `buildTopicIndex` tourne après leur
 * enregistrement, et un import au chargement ferait un cycle
 * (`_topics → registry → _sdk/register`).
 */
function knownTopic(topic: string, modules: ReadonlySet<string>): boolean {
    return nativeLiveTopicSchema.safeParse(topic).success || modules.has(topic) || isExternalFeatureId(topic);
}

/**
 * Commandes dont le nom porte un verbe mutant sans en être une. Maintenue à la
 * main, et c'est voulu : elle est courte, et elle rend le contrôle ci-dessous
 * utile — s'il reste à zéro avertissement, toute nouvelle commande mutante non
 * déclarée saute aux yeux au démarrage.
 */
const NON_MUTATING = new Set([
    'secrecy.unlock',
    'secrecy.hold',
    'secrecy.touch',
    'secrecy.lock',
    'agent.subscribe',
    // Relaie un ordre à l'agent, n'écrit rien côté serveur — même nature que
    // `agent.collect`.
    'sentinel.scanNow',
    'agent.unsubscribe',
    'agent.collect',
    'cloudSync.subscribe',
    'cloudSync.unsubscribe',
    'cloudSync.syncNow',
    // Lecture pure : elle rend l'avancement des synchronisations en cours, lu
    // dans une table en mémoire du service. Elle ne tombe ici que parce que son
    // verbe suit immédiatement le point — contrairement au reste du module git,
    // que le filet ne voit pas du tout (camelCase sous un préfixe unique).
    'git.syncStatuses',
    'mail.oauthStart',
    'mail.accountTestConnection',
    'mail.attachmentScan',
    'mail.attachmentDownload',
    'workspace.activate',
    'agent.update',
    'agent.upgradePackages',
    'agent.listPackages',
    'agent.power',
    'agent.lifecycle',
    'agent.termOpen',
    'agent.termInput',
    'agent.termResize',
    'agent.termClose',
    'agent.filesMutate',
    'agent.filesUpload',
    'agent.filesDownload',
    'agent.filesSearch',
    'agent.filesAnalyze',
    'agent.logQuery',
    'admin.inviteCreate',
    'admin.inviteRevoke'
]);

/** Verbes qui trahissent une écriture, pour le contrôle de démarrage. */
const MUTATION_VERB =
    /\.(add|set|create|update|edit|delete|remove|rename|reorder|archive|restore|assign|enable|disable|revoke|confirm|reactivate|move|send|clear|pause|resume|attach|detach|leave|elevate|drop|upgrade|sync|reset|backfill|regen|recover|setup)/i;

/**
 * Bâtit la table et signale les oublis. Appelé une fois au démarrage.
 *
 * L'oubli est un **avertissement**, jamais une erreur : bloquer le démarrage sur
 * une donnée qui ne se rafraîchit pas toute seule serait disproportionné. Un
 * préfixe inconnu, lui, **lève** — c'est un trou dans le contrat, pas un oubli.
 */
export function buildTopicIndex(): void {
    const suspects: string[] = [];
    const modules = new Set(moduleTopics());

    for (const def of featureHandlers) {
        const prefix = prefixOf(def.command);
        // Un module externe n'a pas d'entrée dans la table : son préfixe EST
        // son id, et son sujet aussi (contrat du manifest, validé à
        // l'enregistrement). La règle est structurelle, pas déclarative.
        const external = isExternalFeatureId(prefix);
        if (!external && !(prefix in COMMAND_PREFIX_TOPIC)) {
            throw new Error(
                `Préfixe de commande inconnu de COMMAND_PREFIX_TOPIC : « ${prefix} » (${def.command}). ` +
                    'Ajoutez-le à src/features/_topics.ts.'
            );
        }

        if (!def.mutates) {
            if (MUTATION_VERB.test(def.command) && !NON_MUTATING.has(def.command)) {
                suspects.push(def.command);
            }
            continue;
        }

        if (def.mutates === true) {
            const topic = external ? (prefix as LiveTopic) : COMMAND_PREFIX_TOPIC[prefix];
            if (topic === null) {
                throw new Error(
                    `« ${def.command} » déclare mutates: true, mais son préfixe « ${prefix} » ne porte aucun sujet. ` +
                        'Déclarez une liste explicite.'
                );
            }
            TOPICS_BY_COMMAND.set(def.command, [topic]);
        } else {
            for (const topic of def.mutates) {
                if (!knownTopic(topic, modules)) {
                    throw new Error(
                        `« ${def.command} » déclare mutates: ['${topic}'], sujet inconnu : ni natif, ni déclaré par un module ` +
                            '(son id, ou manifest.topics).'
                    );
                }
            }
            TOPICS_BY_COMMAND.set(def.command, def.mutates);
        }
    }

    if (suspects.length > 0) {
        logger.warn(
            { commands: suspects },
            `${suspects.length} commande(s) au nom mutant ne déclarent pas \`mutates\` : ` +
                'leurs données ne se rafraîchiront pas chez les autres membres. ' +
                'Ajoutez `mutates: true`, ou inscrivez-les dans NON_MUTATING (src/features/_topics.ts).'
        );
    }
}

/** Les sujets d'une commande, ou `undefined` si elle n'écrit pas. */
export function topicsOf(command: string): readonly LiveTopic[] | undefined {
    return TOPICS_BY_COMMAND.get(command);
}
