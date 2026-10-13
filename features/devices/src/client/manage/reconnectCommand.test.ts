import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reconnectCommands, type ReconnectChoice } from './reconnectCommand';

const base: ReconnectChoice = { os: 'linux', root: false, autostart: true, scope: 'user' };

describe('reconnectCommands', () => {
    it('refait le service de session sans sudo', () => {
        assert.deepEqual(reconnectCommands(base), [{ command: 'deveye-agent service install', admin: false }]);
    });

    it("élève par le chemin de l'agent, que le PATH de sudo ne connaît pas", () => {
        assert.deepEqual(reconnectCommands({ ...base, root: true, autostart: false }), [
            { command: 'sudo "$(command -v deveye-agent)" service install --system --no-autostart', admin: true }
        ]);
    });

    it('rétrograde en retirant le service système, puis en refaisant celui du compte', () => {
        assert.deepEqual(reconnectCommands({ ...base, os: 'macos', scope: 'system' }), [
            { command: 'sudo deveye-agent service uninstall && deveye-agent service install', admin: true }
        ]);
    });

    it('relance à la main un agent sans service ni démarrage automatique', () => {
        assert.deepEqual(reconnectCommands({ ...base, autostart: false, scope: 'none' }), [
            { command: 'deveye-agent run --detach', admin: false }
        ]);
    });

    it('garde le service de session en place, désarmé', () => {
        assert.deepEqual(reconnectCommands({ ...base, autostart: false }), [
            { command: 'deveye-agent service install --no-autostart', admin: false }
        ]);
    });

    it("demande l'administrateur pour la tâche d'ouverture de session de Windows", () => {
        assert.deepEqual(reconnectCommands({ ...base, os: 'windows', scope: 'none' }), [
            { command: 'deveye-agent service install', admin: true }
        ]);
    });

    it('sépare sous Windows ce qui exige l’administrateur de ce qui ne l’exige pas', () => {
        assert.deepEqual(reconnectCommands({ ...base, os: 'windows', autostart: false, scope: 'system' }), [
            { command: 'deveye-agent service uninstall', admin: true },
            { command: 'deveye-agent run --detach', admin: false }
        ]);
    });

    it('enchaîne sous Windows les lignes de même niveau', () => {
        assert.deepEqual(reconnectCommands({ ...base, os: 'windows', scope: 'system' }), [
            { command: 'deveye-agent service uninstall\ndeveye-agent service install', admin: true }
        ]);
    });
});
