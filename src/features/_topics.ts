import { isExternalFeatureId, nativeLiveTopicSchema, type LiveTopic } from '@deveye/types';

import { logger } from '@/logger';
import { moduleTopics } from './_sdk/register';
import { featureHandlers } from './registry';

/**
 * De quel sujet relève chaque commande, pour que le dispatcheur sache qui
 * avertir après une écriture. Table explicite, jamais le préfixe brut :
 * `agent.*` et `devices.*` désignent tous deux les appareils, et plusieurs
 * préfixes ne correspondent à aucune feature d'espace. Un préfixe absent fait
 * échouer le démarrage plutôt que de diffuser un sujet inventé.
 *
 * Les modules à préfixe unique et verbes camelCase derrière le point
 * (`audience`, `backup`, `database`, `deploy`, `finance`, `git`, `notify`,
 * `osint`, `projects`, les dossiers de `notes`) échappent au filet
 * `MUTATION_VERB` : leurs `mutates` se relisent à la main.
 */
const COMMAND_PREFIX_TOPIC: Record<string, LiveTopic | null> = {
    // La diffusion en salle n'atteint que les autres onglets de l'auteur : les
    // autres administrateurs sont visés par compte (`notifyAdmins`).
    admin: 'admin',
    // Le transport des agents : des relais sans état côté serveur, sauf trois
    // `mutates` (autostart, élévation, rétrogradation) qui changent la liste.
    agent: 'devices',
    // Le gros du trafic de ce sujet ne passe pas par une commande : l'ingestion
    // publique écrit sans socket et diffuse elle-même, coalescée à la minute.
    audience: 'audience',
    backup: 'backup',
    cloudSync: 'cloudsync',
    // Le fil des vulnérabilités a son propre sujet secondaire (`cveFeed`), battu
    // par l'ingestion : le sujet nommé ici ne sert qu'aux écritures d'un membre.
    cve: 'cve',
    database: 'database',
    deploy: 'deploy',
    devices: 'devices',
    // Les domaines d'une fonctionnalité, relus depuis ses réglages.
    domain: 'domain',
    // Les signalements ne se lisent que dans l'administration, relus à
    // l'ouverture de la vue : rien ne les observe en direct, comme les logs.
    feedback: null,
    finance: 'finance',
    git: 'git',
    home: 'home',
    live: null,
    logs: null,
    mail: 'mail',
    notes: 'notes',
    notify: 'notify',
    // Une projection change ce qui est visible dans deux espaces, une
    // restriction ce que voit un rôle : faute d'un sujet qui dise les deux, le
    // sujet de l'espace, le plus large.
    share: 'workspace',
    osint: 'osint',
    password: 'password',
    // Les commandes de discussion nomment `['projectsChat']`, sujet secondaire
    // du manifest : un message ne doit pas faire re-solliciter le tableau entier.
    projects: 'projects',
    secrecy: 'account',
    // Sujet distinct de `devices` : les constats changent à une tout autre
    // cadence que la liste d'appareils.
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

/** Résolu une fois au démarrage : le dispatcheur ne fait qu'une lecture de Map. */
const TOPICS_BY_COMMAND = new Map<string, readonly LiveTopic[]>();

/**
 * Un sujet qu'une commande peut battre : natif, ou déclaré par un module
 * installé (son id, ses sujets secondaires). Lus à l'appel : un import au
 * chargement ferait un cycle (`_topics → registry → _sdk/register`).
 */
function knownTopic(topic: string, modules: ReadonlySet<string>): boolean {
    return nativeLiveTopicSchema.safeParse(topic).success || modules.has(topic) || isExternalFeatureId(topic);
}

/**
 * Commandes dont le nom porte un verbe mutant sans en être une, et celles dont
 * l'écriture n'a aucun observateur en direct (leur préfixe ne porte pas de
 * sujet). Maintenue à la main : à zéro avertissement, toute nouvelle commande
 * mutante non déclarée saute aux yeux au démarrage.
 */
const NON_MUTATING = new Set([
    'secrecy.unlock',
    'secrecy.hold',
    'secrecy.touch',
    'secrecy.lock',
    'agent.subscribe',
    // Relaie un ordre à l'agent, n'écrit rien côté serveur.
    'sentinel.scanNow',
    'agent.unsubscribe',
    'agent.collect',
    'cloudSync.subscribe',
    'cloudSync.unsubscribe',
    'cloudSync.syncNow',
    // Lecture pure (avancement des synchronisations en cours).
    'git.syncStatuses',
    'mail.oauthStart',
    'mail.accountTestConnection',
    'mail.attachmentScan',
    'mail.attachmentDownload',
    'workspace.activate',
    // Calcule ce qu'un déplacement ferait, sans rien écrire.
    'share.movePreview',
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
    // Écrivent, mais la vue d'administration relit à l'ouverture.
    'feedback.setStatus',
    'feedback.delete'
]);

/** Verbes qui trahissent une écriture, pour le contrôle de démarrage. */
const MUTATION_VERB =
    /\.(add|set|create|update|edit|delete|remove|rename|reorder|archive|restore|assign|enable|disable|revoke|confirm|reactivate|move|send|clear|pause|resume|attach|detach|leave|elevate|drop|upgrade|sync|reset|backfill|regen|recover|setup)/i;

/**
 * Bâtit la table et signale les oublis. Un `mutates` oublié n'est qu'un
 * avertissement ; un préfixe inconnu lève : c'est un trou dans le contrat.
 */
export function buildTopicIndex(): void {
    const suspects: string[] = [];
    const modules = new Set(moduleTopics());

    for (const def of featureHandlers) {
        const prefix = prefixOf(def.command);
        // Un module externe n'a pas d'entrée dans la table : son préfixe est
        // son id, et son sujet aussi (contrat du manifest).
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
