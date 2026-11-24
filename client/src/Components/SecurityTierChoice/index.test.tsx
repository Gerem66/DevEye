import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SecrecyStatus } from '@deveye/types';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { getSecrecy } from '@/stores/secrecy';
import { fakeServer } from '@/test/fakeServer';
import SecurityTierChoice, { type SecurityTier } from './index';

const server = fakeServer();

const WITH_PASSWORD: SecrecyStatus = {
    enabled: true,
    unlocked: true,
    recoveryEnabled: false,
    reAuthInterval: null,
    unlockedUntil: Date.now() + 60_000
};

/** Les deux cartes, telles qu'un module les monte ; `picked` reçoit ce qui est choisi. */
function mount(over: { value?: SecurityTier; unavailable?: string } = {}) {
    const picked: SecurityTier[] = [];
    render(
        <SecurityTierChoice
            aria-label='Protection de la base'
            value={over.value ?? 'open'}
            onChange={(tier) => picked.push(tier)}
            open='Le serveur la relève seul.'
            guarded='Le serveur ne la joint qu’en votre présence.'
            unavailable={over.unavailable}
        />
    );
    return {
        picked,
        open: screen.getByRole<HTMLInputElement>('radio', { name: 'Ouverte' }),
        guarded: screen.getByRole<HTMLInputElement>('radio', { name: 'Protégée' })
    };
}

test('sans chiffrement par mot de passe, l’étage protégé s’explique au lieu de s’offrir', async () => {
    await server.connect();
    const { picked, guarded, open } = mount();
    // L'état du compte arrive avec la connexion : la carte le suit.
    await screen.findByText('Activez d’abord le chiffrement par mot de passe, dans Sécurité.');
    assert.equal(open.checked, true);
    assert.equal(guarded.disabled, true);
    await userEvent.setup().click(guarded);
    assert.deepEqual(picked, []);
});

test('avec lui, l’étage protégé se choisit', async () => {
    server.on('secrecy.status', () => ({ status: WITH_PASSWORD }));
    await server.connect();
    await waitFor(() => assert.equal(getSecrecy().enabled, true));
    const { picked, guarded } = mount();
    assert.equal(guarded.disabled, false);
    assert.ok(!screen.queryByText(/Activez d’abord/));
    assert.ok(!screen.queryByRole('alert'));
    await userEvent.setup().click(guarded);
    assert.deepEqual(picked, ['guarded']);
});

test('la raison du module passe avant celle du compte', async () => {
    server.on('secrecy.status', () => ({ status: WITH_PASSWORD }));
    await server.connect();
    await waitFor(() => assert.equal(getSecrecy().enabled, true));
    const { guarded } = mount({ unavailable: 'Une base protégée n’existe que dans votre espace personnel.' });
    assert.equal(guarded.disabled, true);
    assert.ok(screen.getByText('Une base protégée n’existe que dans votre espace personnel.'));
});

test('un élément déjà protégé le reste affiché, pour pouvoir le rouvrir', async () => {
    // Le chiffrement par mot de passe a été éteint depuis : rien ne le dit protégé à tort, mais on doit pouvoir en sortir.
    await server.connect();
    await waitFor(() => assert.equal(getSecrecy().enabled, false));
    const { picked, guarded, open } = mount({ value: 'guarded' });
    assert.equal(guarded.checked, true);
    assert.ok(!screen.queryByText(/Activez d’abord/));
    // Sa carte ne promet plus ce que le compte ne tient plus.
    assert.match(
        screen.getByRole('alert').textContent ?? '',
        /le serveur garde de\s+quoi lire ce que cet étage protège/
    );
    await userEvent.setup().click(open);
    assert.deepEqual(picked, ['open']);
});
