import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SecrecyStatus } from '@deveye/types';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeServer } from 'deveye-sdk-client/testing';

import type { DatabaseSecurityTier } from '../contracts/domain';
import { DatabaseTierChoice } from './DatabaseTierChoice';

/**
 * Le choix de protection d'une base. Ce qu'il promet doit être vrai : l'étage
 * protégé ne s'offre que là où le mot de passe garde vraiment la clé, et sa
 * carte dit ce qui reste lisible par le serveur.
 */

const server = fakeServer();

const WITH_PASSWORD: SecrecyStatus = {
    enabled: true,
    unlocked: true,
    recoveryEnabled: false,
    reAuthInterval: null,
    unlockedUntil: Date.now() + 60_000
};

async function mount(kind: 'personal' | 'shared', status?: SecrecyStatus) {
    if (status) server.on('secrecy.status', () => ({ status }));
    server.workspace(kind);
    await server.connect();
    const picked: DatabaseSecurityTier[] = [];
    render(<DatabaseTierChoice value='open' onChange={(tier) => picked.push(tier)} />);
    const guarded = screen.getByRole<HTMLInputElement>('radio', { name: 'Protégée' });
    if (status) await waitFor(() => assert.ok(!screen.queryByText(/Activez d’abord/)));
    return { picked, guarded };
}

test('dans un espace partagé, une base protégée ne s’offre pas : tous les membres la liraient', async () => {
    const { picked, guarded } = await mount('shared', WITH_PASSWORD);
    assert.equal(guarded.disabled, true);
    assert.ok(screen.getByText(/n’existe que dans votre espace personnel/));
    await userEvent.setup().click(guarded);
    assert.deepEqual(picked, []);
});

test('sans chiffrement par mot de passe, elle ne s’offre pas non plus', async () => {
    const { guarded } = await mount('personal');
    // L'état du compte arrive avec la connexion : la carte le suit.
    await screen.findByText('Activez d’abord le chiffrement par mot de passe, dans Sécurité.');
    assert.equal(guarded.disabled, true);
});

test('offerte, sa carte dit ce qu’elle coûte et ce qui reste lisible par le serveur', async () => {
    const { picked, guarded } = await mount('personal', WITH_PASSWORD);
    await waitFor(() => assert.equal(guarded.disabled, false));
    assert.ok(screen.getByText(/ni relevé automatique\s+ni alerte/));
    assert.ok(screen.getByText(/ni d’une sauvegarde ni d’un indicateur de projet/));
    assert.ok(screen.getByText(/Son nom, son\s+hôte et son dernier relevé restent lisibles par le serveur/));
    await userEvent.setup().click(guarded);
    assert.deepEqual(picked, ['guarded']);
});
