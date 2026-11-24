import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SecrecyStatus } from '@deveye/types';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeServer, Refusal } from 'deveye-sdk-client/testing';

import type { Database } from '../contracts/domain';
import { manifest } from '../manifest';
import DatabaseEncryptionPanel from './DatabaseEncryptionPanel';

/**
 * L'onglet Chiffrement d'une base : choisir applique, et l'écran dit ce que le
 * changement vient de couper.
 */

const server = fakeServer();

const WITH_PASSWORD: SecrecyStatus = {
    enabled: true,
    unlocked: true,
    recoveryEnabled: false,
    reAuthInterval: null,
    unlockedUntil: Date.now() + 60_000
};

const BASE: Database = {
    id: 4,
    engine: 'mysql',
    securityTier: 'open',
    name: 'Prod',
    host: 'db.exemple.fr',
    port: 3306,
    database: 'shop',
    username: 'ro',
    foreign: false,
    hasPassword: true,
    access: { kind: 'direct', host: '', port: null, username: '', auth: 'password', hasSecret: false, deviceId: null },
    monitorEnabled: true,
    intervalSeconds: 300,
    autoLoadTables: true,
    lastCheckAt: null,
    lastElapsedMs: null,
    status: 'unknown',
    lastError: null,
    serverVersion: null,
    sizeBytes: null,
    tableCount: null,
    alertCount: 0,
    firingCount: 0,
    projectCount: 0,
    planPaused: false,
    created: 1
};

/** L'onglet ouvert sur la base 4, dans un espace personnel dont le compte a le chiffrement par mot de passe. */
async function opened(database: Database = BASE, canWrite = true) {
    const database_ = server.feature(manifest);
    let current = database;
    server.on('secrecy.status', () => ({ status: WITH_PASSWORD }));
    database_.on('database.get', () => ({ database: current, usage: [], alerts: [], kpis: [] }));
    server.workspace('personal');
    await server.connect();
    render(
        <DatabaseEncryptionPanel
            scope={{ kind: 'item', itemId: '4', itemLabel: 'Prod' }}
            canWrite={canWrite}
            close={() => undefined}
            gone={() => undefined}
        />
    );
    const guarded = await screen.findByRole<HTMLInputElement>('radio', { name: 'Protégée' });
    await waitFor(() => assert.ok(!screen.queryByText(/Activez d’abord/)));
    return {
        commands: database_,
        guarded,
        open: screen.getByRole<HTMLInputElement>('radio', { name: 'Ouverte' }),
        /** Ce que le serveur rendra à la relecture qui suit un changement. */
        become: (next: Database) => void (current = next)
    };
}

test('choisir « Protégée » l’applique, et dit ce qui vient de s’arrêter', async () => {
    const { commands, guarded, become } = await opened();
    const after: Database = { ...BASE, securityTier: 'guarded', monitorEnabled: false };
    commands.on('database.setTier', () => {
        become(after);
        return { database: after };
    });

    await userEvent.setup().click(guarded);

    await screen.findByText(/La base est maintenant protégée\. Son relevé automatique est arrêté/);
    assert.deepEqual(commands.calls('database.setTier'), [{ databaseId: 4, securityTier: 'guarded' }]);
    await waitFor(() => assert.equal(guarded.checked, true));
});

test('une session verrouillée fait rejouer la commande au lieu de l’abandonner', async () => {
    const { commands, guarded, become } = await opened();
    const after: Database = { ...BASE, securityTier: 'guarded', monitorEnabled: false };
    let asked = 0;
    commands.on('database.setTier', () => {
        asked += 1;
        if (asked === 1) throw new Refusal('locked', 'Cette base est protégée par votre mot de passe.');
        become(after);
        return { database: after };
    });

    await userEvent.setup().click(guarded);

    await screen.findByText(/La base est maintenant protégée/);
    assert.equal(asked, 2);
});

test('un refus du serveur se lit, et la base reste ce qu’elle était', async () => {
    const { commands, guarded, open } = await opened();
    commands.on('database.setTier', () => {
        throw new Refusal('validation', 'Activez d’abord le chiffrement par mot de passe, dans Sécurité.');
    });

    await userEvent.setup().click(guarded);

    await screen.findByText('Activez d’abord le chiffrement par mot de passe, dans Sécurité.');
    assert.equal(open.checked, true);
    assert.ok(!screen.queryByRole('status'));
});

test('sans droit d’écriture, le choix se lit sans se changer', async () => {
    const { guarded, open } = await opened(BASE, false);
    assert.equal(guarded.disabled, true);
    assert.equal(open.disabled, true);
    assert.ok(screen.getByText(/Votre rôle ne permet pas de changer la protection d’une base/));
});

test('une base venue d’un autre espace ne se règle pas ici', async () => {
    const commands = server.feature(manifest);
    commands.on('database.get', () => ({ database: { ...BASE, foreign: true }, usage: [], alerts: [], kpis: [] }));
    server.workspace('personal');
    await server.connect();
    render(
        <DatabaseEncryptionPanel
            scope={{ kind: 'item', itemId: '4', itemLabel: 'Prod' }}
            canWrite
            close={() => undefined}
            gone={() => undefined}
        />
    );
    await screen.findByText(/Sa protection se règle depuis là-bas/);
    assert.ok(!screen.queryByRole('radio'));
});
