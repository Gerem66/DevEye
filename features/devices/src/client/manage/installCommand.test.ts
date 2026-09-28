import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { POLICY_KEYS } from '../policy';
import { installCommand, linkCommand, osOf, psArg, shArg, type InstallChoice } from './installCommand';

const base: InstallChoice = {
    os: 'linux',
    server: 'https://app.deveye.fr',
    code: 'ABCD-EFGH',
    denied: [],
    autostart: true,
    admin: false,
    shuffleId: false
};

describe('installCommand', () => {
    it('installe et relie en une ligne, sans option pour le contrôle complet', () => {
        assert.equal(
            installCommand(base),
            'curl -fsSL https://app.deveye.fr/install.sh | sh -s -- ABCD-EFGH --autostart'
        );
    });

    it("passe sous sudo pour l'administrateur, et les refus dans l'ordre de l'agent", () => {
        assert.equal(
            installCommand({ ...base, admin: true, denied: ['power', 'terminal'], shuffleId: true }),
            'curl -fsSL https://app.deveye.fr/install.sh | sudo sh -s -- ABCD-EFGH --deny terminal,power --autostart --shuffle-id'
        );
    });

    it('tout refuser se dit --monitor-only', () => {
        assert.match(
            installCommand({ ...base, denied: POLICY_KEYS, autostart: false }),
            /-- ABCD-EFGH --monitor-only$/
        );
    });

    it('sous Windows, force TLS 1.2 et encadre la liste, que PowerShell prendrait pour un tableau', () => {
        const command = installCommand({ ...base, os: 'windows', admin: true, denied: ['terminal', 'sync'] });
        assert.ok(command.startsWith('[Net.ServicePointManager]::SecurityProtocol'));
        assert.ok(
            command.endsWith(
                "& ([scriptblock]::Create((irm https://app.deveye.fr/install.ps1))) ABCD-EFGH --deny 'terminal,sync' --autostart"
            ),
            command
        );
        assert.doesNotMatch(command, /sudo/);
    });
});

describe('linkCommand', () => {
    it('nomme toujours le serveur, pour une instance hébergée ailleurs', () => {
        assert.equal(
            linkCommand({ ...base, server: 'http://localhost:3000' }),
            'deveye-agent link ABCD-EFGH --server http://localhost:3000 --autostart'
        );
        assert.equal(
            linkCommand({ ...base, admin: true, autostart: false }),
            'sudo -H deveye-agent link ABCD-EFGH --server https://app.deveye.fr'
        );
        assert.match(linkCommand({ ...base, os: 'windows' }), /^deveye-agent\.exe link ABCD-EFGH --server /);
    });
});

describe('les mots des commandes', () => {
    it("n'encadre que ce qui en a besoin, et échappe l'apostrophe", () => {
        assert.equal(shArg('terminal,power'), 'terminal,power');
        assert.equal(shArg("l'hôte"), `'l'\\''hôte'`);
        assert.equal(psArg('terminal,power'), "'terminal,power'");
        assert.equal(psArg("l'hôte"), "'l''hôte'");
        assert.equal(psArg('@x'), "'@x'");
    });

    it('devine le système depuis la plateforme du navigateur', () => {
        assert.equal(osOf('Win32'), 'windows');
        assert.equal(osOf('macOS'), 'macos');
        assert.equal(osOf('MacIntel'), 'macos');
        assert.equal(osOf('Darwin'), 'macos');
        assert.equal(osOf('Linux x86_64'), 'linux');
        assert.equal(osOf(''), 'linux');
    });
});
