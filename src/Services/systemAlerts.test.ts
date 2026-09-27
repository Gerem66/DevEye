import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import { HOUR_MS, HOURLY_MAX, KEY_WINDOW_MS, composeAlert, createThrottle, describeError } from './systemAlerts';

describe('createThrottle', () => {
    it('une clé ne repart qu’après sa fenêtre, avec le compte de ses répétitions', () => {
        const throttle = createThrottle(() => undefined);
        assert.deepEqual(throttle.admit('ws:notes.list', 0), { send: true, repeats: 0 });
        for (let i = 1; i <= 4; i++) assert.deepEqual(throttle.admit('ws:notes.list', i * 1000), { send: false });
        assert.deepEqual(throttle.admit('ws:notes.list', KEY_WINDOW_MS), { send: true, repeats: 4 });
    });

    it('des clés distinctes ne se gênent pas', () => {
        const throttle = createThrottle(() => undefined);
        assert.equal(throttle.admit('a', 0).send, true);
        assert.equal(throttle.admit('b', 0).send, true);
    });

    it('au-delà du plafond horaire, retient puis résume en une seule alerte', () => {
        mock.timers.enable({ apis: ['setTimeout'] });
        try {
            const summaries: number[] = [];
            const throttle = createThrottle((held) => summaries.push(held));
            let sent = 0;
            for (let i = 0; i < HOURLY_MAX + 5; i++) if (throttle.admit(`k${i}`, i).send) sent++;
            assert.equal(sent, HOURLY_MAX);
            assert.deepEqual(summaries, []);
            mock.timers.tick(HOUR_MS);
            assert.deepEqual(summaries, [5]);
            // Une heure plus tard, la fenêtre est neuve.
            assert.equal(throttle.admit('fresh', HOUR_MS + 1).send, true);
        } finally {
            mock.timers.reset();
        }
    });
});

describe('composeAlert', () => {
    it('dit l’instance, le détail et les répétitions sur tous les canaux', () => {
        const alert = composeAlert(
            { key: 'crash', level: 'critical', title: 'Plantage du serveur', detail: 'Error: boom' },
            3,
            1_800_000_000,
            'https://app.deveye.fr'
        );
        assert.equal(alert.subject, '[DevEye] Plantage du serveur');
        assert.match(alert.body, /Error: boom/);
        assert.match(alert.body, /Répétée 3 fois/);
        assert.match(alert.body, /Instance : https:\/\/app\.deveye\.fr/);
        assert.equal(alert.payload.level, 'critical');
        assert.match(String(alert.embeds?.[0]?.description), /```\nError: boom\n```/);
    });

    it('sans détail ni répétition, l’embed n’a pas de description', () => {
        const alert = composeAlert({ key: 'boot', level: 'info', title: 'Serveur démarré' }, 0, 0, 'x');
        assert.equal(alert.embeds?.[0]?.description, undefined);
    });
});

describe('describeError', () => {
    it('garde le message et le haut de la pile', () => {
        const text = describeError(new TypeError('x is undefined'));
        assert.match(text, /^TypeError: x is undefined\n\s+at /);
    });

    it('accepte ce qui n’est pas une erreur', () => {
        assert.equal(describeError('refus'), 'refus');
    });
});
