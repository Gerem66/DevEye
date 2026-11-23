import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentInfoSchema, type AgentInfo } from '@deveye/types';

import { rootTerminalBlock } from './policy';

function agent(over: { privileged: boolean; terminalRoot?: boolean; user?: string }): AgentInfo {
    return agentInfoSchema.parse({
        privileged: over.privileged,
        user: over.user ?? (over.privileged ? 'root' : 'deploy'),
        policy: {
            terminal: true,
            terminalRoot: over.terminalRoot,
            filesWrite: false,
            power: false,
            pkgUpgrade: false,
            serviceElevate: false,
            destroy: false
        }
    });
}

const linux = (terminalDefaultUser: string | null) => ({ platform: 'linux' as const, terminalDefaultUser });

describe('rootTerminalBlock', () => {
    it('ne concerne ni un agent sans privilèges, ni une machine qui permet le terminal root', () => {
        assert.equal(rootTerminalBlock(linux(null), agent({ privileged: false, terminalRoot: false })), null);
        assert.equal(rootTerminalBlock(linux(null), agent({ privileged: true, terminalRoot: true })), null);
        assert.equal(rootTerminalBlock(linux(null), null), null);
    });

    it('un agent plus ancien que le droit ne le refuse pas', () => {
        assert.equal(rootTerminalBlock(linux(null), agent({ privileged: true })), null);
    });

    it('demande un compte quand le shell serait root', () => {
        const closed = agent({ privileged: true, terminalRoot: false });
        assert.equal(rootTerminalBlock(linux(null), closed), 'account');
        assert.equal(rootTerminalBlock(linux('root'), closed), 'account');
        assert.equal(rootTerminalBlock(linux('deploy'), closed), null);
    });

    it('sous Windows, aucun compte ne change le shell de l’agent', () => {
        const closed = agent({ privileged: true, terminalRoot: false, user: 'SYSTEM' });
        const windows = { platform: 'windows' as const, terminalDefaultUser: 'deploy' };
        assert.equal(rootTerminalBlock(windows, closed), 'policy');
    });
});
