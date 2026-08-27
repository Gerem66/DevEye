import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildNotice } from './notice';

/**
 * Le constat tel que Discord le reçoit.
 *
 * La mise en page se juge à l'œil dans Discord ; ce qui est vérifié ici, ce
 * sont les endroits où un avis peut **partir de travers sans que rien ne le
 * dise** : la gravité qui doit se lire avant le texte (pastille ET couleur, la
 * couleur seule disparaît en notification poussée), un détail de sonde qui
 * refermerait le bloc de code, et une remédiation absente qui ne doit pas
 * produire une case vide (Discord refuse alors le message entier).
 */

type Embed = Record<string, unknown> & { fields: { name: string; value: string; inline?: boolean }[] };

const embed = (notice: Parameters<typeof buildNotice>[0]): Embed => buildNotice(notice)[0] as Embed;
const valueOf = (e: Embed, name: string): string => e.fields.find((f) => f.name.includes(name))?.value ?? '';

describe('buildNotice : la gravité', () => {
    it('porte la pastille dans le titre et la couleur de la bordure', () => {
        const critical = embed({
            device: 'Serveur',
            rule: 'Interpréteur avec connexion sortante',
            severity: 'critical',
            detail: 'bash|/usr/bin/bash',
            remediation: 'Coupez la connexion.',
            at: 1_700_000_000
        });
        assert.equal(critical.title, '🔴 Interpréteur avec connexion sortante');
        assert.equal(critical.color, 0xed4245);
        assert.equal(valueOf(critical, 'Gravité'), 'Critique');

        const high = embed({
            device: 'Serveur',
            rule: 'Port exposé',
            severity: 'high',
            detail: '',
            remediation: null,
            at: 1
        });
        assert.equal(high.title, '🟠 Port exposé');
        assert.equal(high.color, 0xfee75c);
    });

    it('date en horodatage Discord, pas en heure du serveur', () => {
        const n = embed({ device: 'S', rule: 'R', severity: 'low', detail: '', remediation: null, at: 1_700_000_000 });
        assert.equal(valueOf(n, 'Constaté'), '<t:1700000000:f>');
        assert.equal(n.timestamp, '2023-11-14T22:13:20.000Z');
    });
});

describe('buildNotice : les cases facultatives', () => {
    it('omet le détail vide et la remédiation absente plutôt que d’envoyer une case vide', () => {
        const bare = embed({ device: 'S', rule: 'R', severity: 'low', detail: '   ', remediation: null, at: 1 });
        assert.deepEqual(
            bare.fields.map((f) => f.name),
            ['🖥️ Appareil', '⚖️ Gravité', '📅 Constaté']
        );
    });

    it('met le détail en bloc de code sans le laisser refermer le bloc', () => {
        // Un sujet vient d'une sonde : un chemin, une ligne de commande, ``` compris.
        const tricky = embed({
            device: 'S',
            rule: 'R',
            severity: 'high',
            detail: 'sujet ```\n# titre injecté',
            remediation: 'Regardez.',
            at: 1
        });
        assert.equal(valueOf(tricky, 'Ce qui a été vu').split('```').length - 1, 2);
        assert.equal(valueOf(tricky, 'Que faire'), 'Regardez.');
    });
});
