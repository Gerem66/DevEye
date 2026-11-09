import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { POLICY_KEYS } from '../policy';
import {
    installCommand,
    isInstanceName,
    linkCommand,
    osOf,
    psArg,
    shArg,
    suggestInstanceName,
    type InstallChoice
} from './installCommand';

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

    it("nomme l'instance de l'agent avant la commande, et le script la reçoit après le code", () => {
        const choice = { ...base, server: 'https://nas.lan', instance: 'nas', admin: true };
        assert.equal(
            linkCommand(choice),
            'sudo -H deveye-agent --instance nas link ABCD-EFGH --server https://nas.lan --autostart'
        );
        assert.match(linkCommand({ ...choice, os: 'windows' }), /^deveye-agent\.exe --instance nas link ABCD-EFGH /);
        assert.equal(
            installCommand(choice),
            'curl -fsSL https://nas.lan/install.sh | sudo sh -s -- ABCD-EFGH --instance nas --autostart'
        );
        assert.equal(linkCommand({ ...choice, instance: null }), linkCommand({ ...choice, instance: undefined }));
    });
});

describe("le nom d'une instance", () => {
    it("suit le contrat de l'agent", () => {
        for (const good of ['nas', 'prod-2', 'a', 'x'.repeat(32)]) assert.ok(isInstanceName(good), good);
        for (const bad of ['', '-nas', 'nas-', 'Nas', 'nas.lan', 'default', 'x'.repeat(33)]) {
            assert.ok(!isInstanceName(bad), bad);
        }
    });

    it("se propose depuis le libellé de l'instance, sinon son hôte, sinon un mot", () => {
        assert.equal(suggestInstanceName('NAS maison', 'https://nas.lan'), 'nas-maison');
        assert.equal(suggestInstanceName('Défaut', 'https://nas.lan'), 'defaut');
        assert.equal(suggestInstanceName('default', 'https://nas.lan:3000'), 'nas-lan');
        assert.equal(suggestInstanceName('!!!', 'pas une adresse'), 'distant');
        assert.equal(suggestInstanceName('Un libellé vraiment très long pour une instance distante', 'x').length, 32);
        assert.ok(isInstanceName(suggestInstanceName('Un libellé vraiment très long pour une instance distante', 'x')));
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
