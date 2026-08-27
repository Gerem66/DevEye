import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Privilège de native rapatriée, commenté à chaque usage : `webhookBody` est la
// fonction de l'app qui décide, pour chaque type de canal, si l'embed remplace
// le texte. Elle est partagée par les cinq émetteurs, et c'est précisément ce
// partage qui se vérifie ici depuis le point de vue d'Uptime.
import { webhookBody, type Alert } from '@/Services/notifications';

import { buildNotice } from './notice';

/**
 * L'avis de disponibilité tel que Discord le reçoit.
 *
 * Comme pour l'avis de déploiement, la mise en page se juge à l'œil dans
 * Discord ; ce qui est vérifié ici, ce sont les endroits où un avis peut
 * **partir de travers sans que rien ne le dise** : une valeur de champ trop
 * longue (Discord rejette le message entier, donc l'alerte n'arrive jamais), un
 * lien Markdown cassé par l'adresse surveillée, et le choix entre texte et
 * embed selon le webhook réglé.
 *
 * Ce dernier point est le plus traître : se tromper de branche n'échoue pas, ça
 * envoie deux fois la même chose à Discord, ou du texte perdu vers un point
 * d'entrée maison qui attendait ses champs.
 */

type Embed = Record<string, unknown> & { fields: { name: string; value: string; inline?: boolean }[] };

const embed = (notice: Parameters<typeof buildNotice>[0]): Embed => buildNotice(notice)[0] as Embed;
const valueOf = (e: Embed, name: string): string => e.fields.find((f) => f.name.includes(name))?.value ?? '';

describe('buildNotice : la panne', () => {
    const down = embed({
        event: 'down',
        service: 'API OxyFoo',
        url: 'https://api.oxyfoo.com/health',
        at: 1_700_000_000,
        error: 'Statut HTTP 502 (attendu 2xx/3xx)',
        httpStatus: 502
    });

    it('porte la couleur et le titre de l’état', () => {
        assert.equal(down.color, 0xed4245);
        assert.equal(down.title, '🔴 Service hors ligne');
    });

    it('date en horodatage Discord, pas en heure du serveur', () => {
        // `<t:…>` est rendu dans le fuseau du lecteur, et le relatif continue de
        // compter. Une date formatée ici serait juste pour la machine qui l'a
        // écrite, fausse pour les autres, et figée pour tout le monde.
        assert.equal(valueOf(down, 'Depuis'), '<t:1700000000:R>');
    });

    it('dit « aucune réponse » plutôt qu’un statut inventé', () => {
        const noAnswer = embed({
            event: 'down',
            service: 'API',
            url: 'https://exemple.fr',
            at: 1,
            error: 'Délai dépassé (10 s)',
            httpStatus: null
        });
        assert.equal(valueOf(noAnswer, 'Réponse'), 'Aucune réponse');
    });
});

describe('buildNotice : les limites de Discord', () => {
    it('tient sous les 1024 caractères d’un champ', () => {
        // Une erreur vient d'un point d'entrée quelconque : rien n'en borne la
        // longueur. Au-delà de la limite, Discord refuse **tout le message** :
        // l'alerte ne serait donc pas seulement laide, elle serait absente.
        const long = embed({
            event: 'down',
            service: 'API',
            url: 'https://exemple.fr',
            at: 1,
            error: 'x'.repeat(5000),
            httpStatus: 500
        });
        assert.ok(valueOf(long, 'Erreur').length <= 1024);
    });

    it('ne laisse pas une erreur refermer le bloc de code', () => {
        // Une réponse d'erreur peut contenir n'importe quoi, ``` compris : le
        // laisser passer ferait sortir la suite du bloc, et le Markdown de la
        // page d'erreur s'appliquerait au message.
        const tricky = embed({
            event: 'down',
            service: 'API',
            url: 'https://exemple.fr',
            at: 1,
            error: 'réponse ```\n# titre injecté',
            httpStatus: 500
        });
        assert.equal(valueOf(tricky, 'Erreur').split('```').length - 1, 2);
    });

    it('montre une adresse à parenthèses en code plutôt qu’en lien cassé', () => {
        // Un `)` ferme le lien Markdown au mauvais endroit : le champ arriverait
        // moitié lien, moitié texte nu.
        const weird = embed({
            event: 'down',
            service: 'API',
            url: 'https://exemple.fr/a(b)c',
            at: 1,
            error: null,
            httpStatus: null
        });
        assert.equal(valueOf(weird, 'Adresse'), '`https://exemple.fr/a(b)c`');
    });

    it('réduit une adresse valide à son hôte', () => {
        const long = embed({
            event: 'down',
            service: 'API',
            url: 'https://api.exemple.fr/v2/health?token=abcdefghijklmnop',
            at: 1,
            error: null,
            httpStatus: null
        });
        assert.equal(
            valueOf(long, 'Adresse'),
            '[api.exemple.fr](https://api.exemple.fr/v2/health?token=abcdefghijklmnop)'
        );
    });
});

describe('buildNotice : le rétablissement', () => {
    const up = embed({
        event: 'recovered',
        service: 'API OxyFoo',
        url: 'https://api.oxyfoo.com/health',
        at: 1_700_003_700,
        startedAt: 1_700_000_000,
        cause: 'Statut HTTP 502 (attendu 2xx/3xx)',
        responseMs: 143
    });

    it('donne la durée de la panne, pas deux dates à soustraire', () => {
        assert.equal(up.color, 0x57f287);
        assert.equal(valueOf(up, 'Indisponible'), '1 h 01 min');
    });

    it('omet la cause quand elle n’a pas pu être déchiffrée', () => {
        // Un champ vide est refusé par Discord ; une case « Cause : inconnue »
        // n'apprendrait rien. Elle disparaît.
        const noCause = embed({
            event: 'recovered',
            service: 'API',
            url: 'https://exemple.fr',
            at: 100,
            startedAt: 40,
            cause: null,
            responseMs: null
        });
        assert.equal(
            noCause.fields.some((f) => f.name.includes('Cause')),
            false
        );
    });
});

describe('webhookBody : quel canal reçoit quoi', () => {
    const alert: Alert = {
        subject: 'sujet',
        body: 'le corps en clair',
        payload: { event: 'down', service: 'API' },
        embeds: [{ title: '🔴 Service hors ligne' }]
    };

    it('envoie l’embed seul à un canal Discord', () => {
        // Garder `content` afficherait deux fois la même alerte : le pavé de
        // texte au-dessus de sa propre mise en page.
        const body = webhookBody('discord', alert);
        assert.deepEqual(body.embeds, alert.embeds);
        assert.equal(body.content, undefined);
        assert.equal(body.event, 'down');
    });

    it('garde le texte sur un canal webhook générique', () => {
        // Slack lit `text`, un point d'entrée maison lit ses champs : ni l'un ni
        // l'autre ne sait rendre un embed.
        const body = webhookBody('webhook', alert);
        assert.equal(body.content, 'le corps en clair');
        assert.equal(body.text, 'le corps en clair');
        assert.equal(body.embeds, undefined);
    });

    it('ne décide plus d’après l’URL, mais d’après le type déclaré', () => {
        // Le reniflage d'URL décidait à la place de l'utilisateur : un point
        // d'entrée maison servi depuis un domaine Discord recevait des embeds
        // au lieu de son texte, et rien ne permettait de demander l'inverse.
        // Un canal déclaré `webhook` garde son texte, quelle que soit son URL.
        const body = webhookBody('webhook', alert);
        assert.equal(body.content, 'le corps en clair');
        assert.equal(body.embeds, undefined);
    });

    it('garde le texte pour une feature qui ne fournit pas d’embed', () => {
        // Mieux vaut un message simple qu'aucun : un canal Discord sans mise en
        // page reçoit l'alerte comme n'importe quel webhook.
        const plain: Alert = { subject: 's', body: 'corps', payload: {} };
        const body = webhookBody('discord', plain);
        assert.equal(body.content, 'corps');
    });
});
