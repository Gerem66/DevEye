import { formSnippetFor, submitSnippetFor } from './format';

/**
 * Les exemples d'intégration montrés dans la fenêtre d'installation, bâtis
 * depuis la vraie clé du site et la vraie adresse d'ingestion : un exemple
 * qu'il faut adapter avant de s'en servir est un exemple qu'on adapte mal.
 *
 * Du texte brut et non du JSX : ce sont des blocs qu'on sélectionne d'un geste,
 * et les balises y auraient glissé des espaces invisibles.
 */

export interface UsageExample {
    id: string;
    label: string;
    /** Ce que cet exemple fait, et surtout ce qu'il ne peut pas faire. */
    note: string;
    code: string;
}

/**
 * Les six intégrations : trois vivent dans le navigateur et passent par la
 * balise, les trois autres sont côté serveur et postent directement sur
 * l'ingestion. C'est la distinction qui compte.
 */
export function usageExamples(publicKey: string, origin: string, persistent = false): UsageExample[] {
    /**
     * Un serveur n'a ni l'IP ni le navigateur de la personne : sans identifiant,
     * son événement est rattaché à un visiteur distinct, ce qui casse un
     * entonnoir commencé dans le navigateur. En mode persistant, transmettre
     * l'identifiant du navigateur recolle les deux.
     */
    const serverVisitorNote = persistent
        ? ' Ce site étant en mode persistant, transmettez le visitorId du navigateur pour que l’événement soit rattaché à la bonne personne.'
        : ' Sans identifiant de visiteur, l’événement compte pour un visiteur distinct, celui du serveur : ne le mêlez pas à un entonnoir qui commence dans le navigateur.';

    return [
        {
            id: 'js',
            label: 'JavaScript',
            note:
                'Dans le navigateur, une fois la balise posée. Aucune dépendance à installer.' +
                (persistent
                    ? ' La balise de l’étape 1 porte déjà data-visitor="persistent" : sans cet attribut, aucun identifiant n’est posé et les visiteurs connus restent à zéro.'
                    : ''),
            code: `// Un enrobage minuscule, et la seule règle qui compte : on relit
// \`window.deveye\` à **chaque appel**, jamais au chargement.
//
// La balise porte \`defer\` : elle s'exécute après les scripts en ligne de la
// page. Capturer la référence trop tôt ne casse rien de visible : la page
// marche, les clics répondent, et aucune mesure ne part. C'est la panne la
// plus coûteuse à diagnostiquer.
const track = {
    view: (path) => window.deveye?.view(path),
    event: (name) => window.deveye?.event(name),
    identify: (id) => window.deveye?.identify(id)
};

// Une étape franchie. Le nom est libre et n'a pas à exister à l'avance :
// l'entonnoir se compose ensuite, dans DevEye.
track.event('Votre projet');

// Nommer l'utilisateur connecté. Facultatif, et jamais deviné.
track.identify(user.id);

// Une vue posée à la main, si vous coupez le suivi automatique
// (\`data-manual="true"\` sur la balise).
track.view('/tarifs');`
        },
        {
            id: 'jsdoc',
            label: 'JSDoc',
            note: 'Le même code, typé sans quitter le JavaScript : l’éditeur complète et vérifie.',
            code: `/**
 * L'interface exposée par la balise, décrite pour l'éditeur.
 * \`?\` sur la propriété : elle n'existe qu'une fois le script chargé.
 *
 * @typedef {object} Deveye
 * @property {(path?: string) => void} view      Une page vue, chemin explicite.
 * @property {(name: string) => void} event      Une étape franchie.
 * @property {(id: string | null) => void} identify  L'utilisateur connecté.
 */

/**
 * @typedef {Window & { deveye?: Deveye }} DeveyeWindow
 */

/** @type {DeveyeWindow} */
const w = window;

/**
 * Une étape franchie.
 * @param {string} name
 * @returns {void}
 */
export function trackEvent(name) {
    w.deveye?.event(name);
}

trackEvent('Votre projet');`
        },
        {
            id: 'ts',
            label: 'TypeScript',
            note: 'La déclaration globale à poser une fois, puis des appels vérifiés à la compilation.',
            code: `// À poser une fois, dans un \`.d.ts\` ou en tête d'un module.
declare global {
    interface Window {
        /** Absent tant que la balise n'est pas exécutée, d'où l'optionnel. */
        deveye?: {
            view(path?: string): void;
            event(name: string): void;
            identify(id: string | null): void;
        };
    }
}
export {};

// Puis, n'importe où, même si la balise n'est pas encore chargée :
// l'optionnel fait que l'appel ne fait simplement rien.
export const track = {
    view: (path?: string): void => window.deveye?.view(path),
    event: (name: string): void => window.deveye?.event(name),
    identify: (id: string | null): void => window.deveye?.identify(id)
};

// Dans React, appelez-le depuis un effet : il s'exécute bien après le
// chargement de la balise.
track.event('Votre projet');`
        },
        {
            id: 'node',
            label: 'Node.js',
            note:
                'Côté serveur : pas de balise, on poste directement. Utile pour ce que le navigateur ne voit pas, ' +
                'un paiement confirmé par exemple.' +
                serverVisitorNote,
            code: `// Aucune dépendance : fetch est natif depuis Node 18.
//
// Le site doit être en plateforme « Application native » ou « Web et
// application » : sans en-tête Origin, un site « Web » refuse la mesure.

export async function trackServer(name, path, identity${persistent ? ', visitorId' : ''}) {
    try {
        await fetch('${origin}/api/t/e', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: '${publicKey}',
                type: 'event',
                path: path,
                name: name,
                identity: identity${
                    persistent
                        ? `,
                // Celui que le navigateur a rangé dans localStorage. Sans lui,
                // cet événement compterait pour un visiteur à part.
                visitorId: visitorId`
                        : ''
                }
            }),
            // Une mesure ne doit jamais retenir la requête qui la produit.
            signal: AbortSignal.timeout(2000)
        });
    } catch {
        // Volontairement muet. L'endpoint répond toujours 204, y compris sur
        // un refus : il n'y a rien à déduire de sa réponse, et encore moins
        // une raison de faire échouer un paiement.
    }
}

await trackServer('Commande payée', '/commande', String(userId)${persistent ? ', visitorId' : ''});`
        },
        {
            id: 'node-ts',
            label: 'Node.js (TS)',
            note:
                'La même chose typée, avec la charge utile décrite : les fautes de frappe sur un champ se voient ' +
                'à la compilation.' +
                serverVisitorNote,
            code: `/** Ce que l'ingestion accepte. Tout est facultatif sauf le type et le chemin. */
interface AudienceEvent {
    type: 'view' | 'event';
    path: string;
    name?: string;
    identity?: string;${
        persistent
            ? `
    /** L'identifiant que le navigateur garde. Sans lui, cet événement compte
     *  pour un visiteur distinct, celui du serveur. */
    visitorId?: string;`
            : ''
    }
    /** Secondes epoch. Le serveur borne à 24 h : une horloge fausse ne peut
     *  pas dater une visite de 2038 et écraser l'échelle des graphes. */
    at?: number;
}

const KEY = '${publicKey}';
const ENDPOINT = '${origin}/api/t/e';

export async function trackServer(event: AudienceEvent): Promise<void> {
    try {
        await fetch(ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key: KEY, ...event }),
            signal: AbortSignal.timeout(2000)
        });
    } catch {
        // Muet, et c'est le point : l'endpoint répond toujours 204, donc sa
        // réponse n'apprend rien, et une mesure perdue vaut mieux qu'un
        // paiement qui échoue.
    }
}

await trackServer({ type: 'event', path: '/commande', name: 'Commande payée' });`
        },
        {
            id: 'php',
            label: 'PHP (serveur)',
            note:
                'Un serveur n’a pas de balise : il poste directement. Le site doit être en plateforme ' +
                '« Application native » ou « Web et application », faute de quoi l’absence d’en-tête Origin le ' +
                'fait refuser.' +
                serverVisitorNote,
            code: `<?php
// Depuis un serveur, il n'y a ni navigateur ni en-tête Origin : on poste
// directement sur l'ingestion. C'est utile pour ce que le navigateur ne voit
// pas : un paiement confirmé par le prestataire, une commande expédiée.
//
// L'endpoint répond **toujours** 204, y compris sur un refus : ne lisez pas
// son code pour en déduire quoi que ce soit.

$payload = json_encode([
    'key'      => '${publicKey}',
    'type'     => 'event',
    'path'     => '/commande',
    'name'     => 'Commande payée',
    // Facultatif : ce que *vous* appelez cet utilisateur.
    'identity' => (string) $userId,${
        persistent
            ? `
    // Celui que le navigateur a rangé dans localStorage. Sans lui, cet
    // événement compterait pour un visiteur à part.
    'visitorId' => $visitorId,`
            : ''
    }
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

$ch = curl_init('${origin}/api/t/e');
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_RETURNTRANSFER => true,
    // Court, et l'échec est ignoré : une mesure perdue ne doit jamais
    // retarder la requête qui la produit, ni la faire échouer.
    CURLOPT_TIMEOUT        => 2,
]);
curl_exec($ch);
curl_close($ch);`
        }
    ];
}

/**
 * Les trois façons d'envoyer un retour, dans l'ordre où on les essaie : un
 * `<form>` qui ne demande aucun JavaScript, le même envoi depuis la balise
 * quand la page en a déjà, et un appel direct pour vérifier ou poster depuis
 * un serveur.
 *
 * La première existe parce que le cas visé est un site vraiment statique : lui
 * imposer un bundle pour recueillir un message serait rater la cible.
 */
export function submitExamples(publicKey: string, origin: string): UsageExample[] {
    return [
        {
            id: 'html',
            label: 'Formulaire HTML',
            note: 'Aucun JavaScript. Le visiteur est renvoyé sur _next, qui doit être une page de votre propre site : le serveur refuse toute autre destination, sans quoi cette route serait un redirecteur ouvert.',
            code: formSnippetFor(publicKey, origin, 'contact')
        },
        {
            id: 'js',
            label: 'Depuis la balise',
            note: 'Le visiteur ne quitte pas la page. `submit` rend une promesse (`true` si c’est parti), et n’est jamais groupé avec les mesures : un message ne se perd pas au changement de page.',
            code: submitSnippetFor('contact')
        },
        {
            id: 'curl',
            label: 'Appel direct',
            note: 'Pour vérifier un branchement, ou poster depuis un serveur. Le nom du formulaire est libre : il est créé à la première réception, dans la limite de vingt par site.',
            code: `curl -X POST ${origin}/api/t/s \\
  -H 'Content-Type: application/json' \\
  -d '{
    "key": "${publicKey}",
    "form": "contact",
    "fields": { "email": "moi@exemple.fr", "message": "Bonjour" }
  }'

# Réponse : {"ok":true}. Un 400 signale un corps mal formé, et lui seul :
# une clé inconnue ou une origine refusée rendent le même {"ok":true},
# pour ne pas dire à qui sonde quelles clés existent.`
        }
    ];
}

/**
 * Le mémo destiné à un agent de code, écrit pour être collé tel quel dans une
 * conversation. Les trois pièges qui coûtent une session de débogage sont en
 * tête, un agent lisant le début d'un contexte avec plus d'attention que la fin.
 */
export function agentBrief(publicKey: string, origin: string, persistent = false): string {
    return `# Mesure d'audience DevEye : mémo d'intégration

## Poser la balise
<script defer data-key="${publicKey}"${persistent ? ' data-visitor="persistent"' : ''} src="${origin}/t.js"></script>
Dans <head>, AVANT le bundle de l'application : les scripts différés
s'exécutent dans l'ordre du document, et la balise doit patcher l'History API
avant que le routeur n'y touche.

## API (window.deveye, absent tant que la balise n'est pas chargée)
window.deveye?.view(path?: string)      // une page vue
window.deveye?.event(name: string)      // une étape franchie
window.deveye?.identify(id: string|null) // l'utilisateur connecté

## Trois règles, et elles suffisent
1. NE JAMAIS capturer window.deveye dans une variable au chargement.
   La balise porte defer et s'exécute après les scripts en ligne. Capturer
   trop tôt ne casse rien de visible et n'envoie plus rien du tout.
   Toujours : window.deveye?.event('...')
2. Les pages sont suivies AUTOMATIQUEMENT, changements de route d'une SPA
   compris. N'appelez view() que si vous avez mis data-manual="true".
3. Les noms d'événements sont comparés À L'IDENTIQUE (accents, espaces,
   majuscules). Choisissez-les stables et lisibles : ils s'affichent tels
   quels et servent à composer les entonnoirs.

## Recevoir des retours (formulaires, sondages, signalements)
Un « formulaire » est un canal nommé, créé À SA PREMIÈRE RÉCEPTION : il n'y a
rien à déclarer avant, et vingt par site au maximum. La charge utile est un
objet plat de champs libres (40 au plus), que DevEye range et compte.

Depuis la balise, sans quitter la page :
  await window.deveye?.submit('contact', { email, message })  // rend true si envoyé

Sans une ligne de JavaScript :
${formSnippetFor(publicKey, origin, 'contact')}
_next doit désigner une page de VOTRE site : le serveur compare son hôte à
l'en-tête Origin de l'envoi et refuse tout le reste. _hp est un pot de miel,
laissez-le caché et vide.

Depuis un serveur :
POST ${origin}/api/t/s
{"key":"${publicKey}","form":"contact","fields":{"email":"...","message":"..."}}

Réponses : {"ok":true} en cas de succès ET en cas de refus d'identité (clé
inconnue, origine non autorisée, formulaire fermé ou plein) ; 400 uniquement
quand le corps est mal formé. Vérifiez le branchement dans DevEye, pas au code
de retour.

## Entonnoirs
Le site n'émet que des signaux nommés ; les entonnoirs se composent ensuite
dans DevEye à partir de ce qui a été observé. Il n'y a donc rien à déclarer
côté site, et mesurer un autre parcours ne demande aucun redéploiement.
Une visite atteint une marche si la PREMIÈRE occurrence de chaque marche
précédente s'est produite dans l'ordre.

## Côté serveur (pas de navigateur)
POST ${origin}/api/t/e
Content-Type: application/json
{"key":"${publicKey}","type":"event","path":"/commande","name":"Commande payée"}
Le site doit être en plateforme "app" ou "both" (sans en-tête Origin, un site
"web" refuse). La réponse est TOUJOURS 204, y compris sur un refus : ne rien
en déduire.

## À savoir
${
    persistent
        ? `- Ce site est en mode PERSISTANT : la balise range un identifiant dans
  localStorage (data-visitor="persistent") et le visiteur est reconnu d'une
  visite à l'autre. Cela relève du consentement, cookie ou localStorage : au
  site de le recueillir avant de charger la balise.
- Un appel serveur peut transmettre ce même identifiant (champ visitorId) pour
  que son événement soit rattaché à la bonne personne. Sans lui, il compte pour
  un visiteur distinct, celui du serveur.`
        : `- Aucun cookie, aucun identifiant persistant. Un visiteur n'est pas reconnu
  d'un jour à l'autre, donc pas de visiteurs récurrents. Le mode persistant
  existe et s'active dans les paramètres du site ; il demande alors un
  consentement.
- Un événement envoyé depuis un serveur compte pour un visiteur distinct : il
  n'a ni l'IP ni le navigateur de la personne. Ne le mêlez pas à un entonnoir
  qui commence dans le navigateur.`
}
- Sur localhost et file://, la mesure est coupée. Ajoutez data-local="true"
  pour l'activer en développement.
- Les envois sont groupés (~500 ms) et vidés par sendBeacon au départ de
  l'onglet. Une mesure ne doit jamais faire échouer la page qui la produit.
- submit() fait exception : il part seul et tout de suite, parce qu'un message
  perdu au changement de page ne se rattrape pas.
- Les retours ne sont soumis à aucune rétention : ils restent jusqu'à ce qu'on
  les efface, dans la limite de 50 000 par formulaire.`;
}
