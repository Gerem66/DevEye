import type { LiveTopic } from 'deveye-types';

import { logger } from '@/logger';
import { featureHandlers } from './registry';

/**
 * De quel sujet relève chaque commande, pour que le dispatcheur sache qui
 * avertir après une écriture.
 *
 * **Table explicite, jamais le préfixe brut.** Cinq préfixes au moins seraient
 * faux : `folder.*` désigne les dossiers de *notes*, `metrics.*` et `device.*`
 * désignent tous deux les appareils, et `home`, `workspace`, `user`, `secrecy`,
 * `twofa`, `admin` ne correspondent à aucune feature d'espace. Un préfixe absent
 * de cette table **fait échouer le démarrage** plutôt que de diffuser un sujet
 * inventé — c'est un contrat, pas une heuristique.
 */
const COMMAND_PREFIX_TOPIC: Record<string, LiveTopic | null> = {
    admin: 'workspace',
    // Même forme que `git` et `database` : préfixe unique, verbes en camelCase
    // derrière le point. Le filet `MUTATION_VERB` n'en voit donc **aucune** —
    // les `mutates` de cette feature se relisent à la main.
    //
    // ⚠️ Le gros du trafic de ce sujet ne passe pas par une commande du tout :
    // l'ingestion publique écrit sans socket et diffuse elle-même, coalescée à
    // une fois par minute et par espace (voir `Services/AudienceIngest.ts`).
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
    device: 'devices',
    // Même forme que `git`, `database` et `audience` : préfixe unique, verbes en
    // camelCase derrière le point. Le filet `MUTATION_VERB` n'en voit donc
    // **aucune** ; les `mutates` de cette feature se relisent à la main.
    finance: 'finance',
    folder: 'notes',
    // Même forme que `project` : préfixe unique, verbes en camelCase derrière le
    // point. Le filet `MUTATION_VERB` plus bas n'en verra donc **aucune** — les
    // `mutates` de cette feature se relisent à la main.
    git: 'git',
    home: 'home',
    live: null,
    logs: null,
    mail: 'mail',
    metrics: 'devices',
    note: 'notes',
    // Même forme que `git` et `database` : préfixe unique, verbes en camelCase
    // derrière le point. Le filet `MUTATION_VERB` n'en voit donc presque aucune
    // — les `mutates` de cette feature se relisent à la main.
    osint: 'osint',
    password: 'password',
    // Un seul préfixe pour tout le module, donc un seul sujet par défaut. Les
    // commandes de discussion déclarent explicitement `['projectsChat']` : un
    // message ne doit pas faire re-solliciter le tableau et la frise entiers.
    project: 'projects',
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
 * Commandes dont le nom porte un verbe mutant sans en être une. Maintenue à la
 * main, et c'est voulu : elle est courte, et elle rend le contrôle ci-dessous
 * utile — s'il reste à zéro avertissement, toute nouvelle commande mutante non
 * déclarée saute aux yeux au démarrage.
 */
const NON_MUTATING = new Set([
    'password.unlock',
    'secrecy.unlock',
    'secrecy.hold',
    'secrecy.touch',
    'secrecy.lock',
    'metrics.subscribe',
    // Relaie un ordre à l'agent, n'écrit rien côté serveur — même nature que
    // `metrics.refresh`.
    'sentinel.scanNow',
    'metrics.unsubscribe',
    'metrics.refresh',
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
    'uptime.testNotification',
    // Contrôle d'accessibilité et déclenchement : le premier écrit bien le
    // verdict sur la ligne (il déclare donc `mutates`), le second ouvre une
    // exécution. Aucun des deux n'a de verbe mutant dans son nom — ils sont ici
    // pour que la liste reste le reflet exact de ce que le filet ne voit pas.
    'backup.testNotification',
    'workspace.activate',
    'device.updateAgent',
    'device.upgradePackages',
    'device.listPackages',
    'device.power',
    'device.agentLifecycle',
    'device.termOpen',
    'device.termInput',
    'device.termResize',
    'device.termClose',
    'device.filesMutate',
    'device.filesUpload',
    'device.filesDownload',
    'device.filesSearch',
    'device.filesAnalyze',
    'device.logQuery',
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

    for (const def of featureHandlers) {
        const prefix = prefixOf(def.command);
        if (!(prefix in COMMAND_PREFIX_TOPIC)) {
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
            const topic = COMMAND_PREFIX_TOPIC[prefix];
            if (topic === null) {
                throw new Error(
                    `« ${def.command} » déclare mutates: true, mais son préfixe « ${prefix} » ne porte aucun sujet. ` +
                        'Déclarez une liste explicite.'
                );
            }
            TOPICS_BY_COMMAND.set(def.command, [topic]);
        } else {
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
