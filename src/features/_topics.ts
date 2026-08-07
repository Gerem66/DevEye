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
    cloudSync: 'cloudsync',
    device: 'devices',
    folder: 'notes',
    home: 'home',
    live: null,
    logs: null,
    mail: 'mail',
    metrics: 'devices',
    note: 'notes',
    password: 'password',
    // Un seul préfixe pour tout le module, donc un seul sujet par défaut. Les
    // commandes de discussion déclarent explicitement `['projectsChat']` : un
    // message ne doit pas faire re-solliciter le tableau et la frise entiers.
    project: 'projects',
    secrecy: 'account',
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
    'metrics.unsubscribe',
    'metrics.refresh',
    'cloudSync.subscribe',
    'cloudSync.unsubscribe',
    'cloudSync.syncNow',
    'cloudSync.validatePath',
    'mail.oauthStart',
    'mail.accountTestConnection',
    'mail.attachmentScan',
    'mail.attachmentDownload',
    'uptime.testNotification',
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
