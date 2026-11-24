import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SecrecyStatus } from '@deveye/types';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ensureUnlocked, getSecrecy, UnlockCancelledError } from '@/stores/secrecy';
import { fakeServer, Refusal } from '@/test/fakeServer';
import SecrecyGate from './SecrecyGate';

const server = fakeServer();

const LOCKED: SecrecyStatus = {
    enabled: true,
    unlocked: false,
    recoveryEnabled: false,
    reAuthInterval: null,
    unlockedUntil: null
};
const UNLOCKED: SecrecyStatus = { ...LOCKED, unlocked: true, unlockedUntil: Date.now() + 60_000 };

/** Une session verrouillée, l'invite montée, et une action qui attend le déverrouillage. */
async function locked(): Promise<{ waiting: Promise<'ouverte' | Error>; field: HTMLInputElement }> {
    server.on('secrecy.status', () => ({ status: LOCKED }));
    await server.connect();
    await waitFor(() => assert.equal(getSecrecy().enabled, true));
    render(<SecrecyGate />);
    const waiting = ensureUnlocked().then(
        () => 'ouverte' as const,
        (error: Error) => error
    );
    return { waiting, field: await screen.findByPlaceholderText<HTMLInputElement>('Mot de passe') };
}

/** Le champ est marqué en erreur : c'est tout ce que `TextInput` montre du message qu'on lui passe. */
const flagged = (field: HTMLInputElement): boolean => field.classList.contains('input-error');

test('le mot de passe part une seule fois, et l’invite se ferme sur ce qui attendait', async () => {
    const user = userEvent.setup();
    const { waiting, field } = await locked();
    let answer!: (output: { status: SecrecyStatus }) => void;
    server.on('secrecy.unlock', () => new Promise((resolve) => (answer = resolve)));

    await user.type(field, 'correct horse{Enter}');
    // Tant que le serveur n'a pas répondu, ni Entrée ni le bouton ne renvoient le mot de passe.
    const busy = await screen.findByRole<HTMLButtonElement>('button', { name: 'Déverrouillage…' });
    assert.equal(busy.disabled, true);
    await user.keyboard('{Enter}');
    answer({ status: UNLOCKED });

    assert.equal(await waiting, 'ouverte');
    assert.deepEqual(server.calls('secrecy.unlock'), [{ password: 'correct horse' }]);
    await waitFor(() => assert.ok(!screen.queryByRole('dialog')));
    assert.equal(getSecrecy().unlocked, true);
});

test('un mot de passe refusé s’efface du champ, et l’invite reste ouverte', async () => {
    const user = userEvent.setup();
    const { waiting, field } = await locked();
    server.on('secrecy.unlock', () => {
        throw new Refusal('auth_invalid');
    });

    await user.type(field, 'faux{Enter}');

    await waitFor(() => assert.ok(flagged(field)));
    assert.equal(field.value, '');
    assert.equal(getSecrecy().unlocked, false);
    assert.ok(screen.getByRole('dialog'));

    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    assert.ok((await waiting) instanceof UnlockCancelledError);
    assert.equal(server.calls('secrecy.unlock').length, 1);
});

test('une panne du serveur efface aussi le champ, sans accuser le mot de passe', async () => {
    const user = userEvent.setup();
    const { waiting, field } = await locked();
    server.on('secrecy.unlock', () => {
        throw new Refusal('internal', 'boom');
    });

    await user.type(field, 'correct horse{Enter}');

    assert.ok(await screen.findByText(/Le déverrouillage a échoué/));
    assert.equal(field.value, '');
    assert.equal(flagged(field), false);

    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    assert.ok((await waiting) instanceof UnlockCancelledError);
});

test('sans mot de passe, rien ne part', async () => {
    const user = userEvent.setup();
    const { waiting, field } = await locked();

    await user.click(screen.getByRole('button', { name: 'Déverrouiller' }));

    await waitFor(() => assert.ok(flagged(field)));
    assert.deepEqual(server.calls('secrecy.unlock'), []);

    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    assert.ok((await waiting) instanceof UnlockCancelledError);
});
