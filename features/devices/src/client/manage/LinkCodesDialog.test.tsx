import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useEffect } from 'react';
import type { LinkCodeResponse } from '@deveye/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeServer } from 'deveye-sdk-client/testing';

import { manifest } from '../../manifest';
import { POLICY_KEYS } from '../policy';
import { installCommand, linkCommand, type InstallChoice } from './installCommand';
import { LinkCodesDialog } from './LinkCodesDialog';
import { useLinkCodes } from './useLinkCodes';

/**
 * La fenêtre d'appairage : ce qu'elle fait copier est ce qui tournera sur la
 * machine, avec les droits que la machine retiendra. Chaque choix à l'écran
 * doit donc se lire dans la commande, et aucun droit n'y entrer sans un geste.
 */

const server = fakeServer();

const SERVER = 'https://deveye.exemple';
const ONE: LinkCodeResponse = { code: 'ABCD-EFGH', expiresAt: 1_900_000_000, maxUses: 1, uses: 0 };
const FLEET: LinkCodeResponse = { code: 'WXYZ-2345', expiresAt: 1_900_000_000, maxUses: 20, uses: 3 };

/** Ce que la fenêtre choisit à l'ouverture, sur un poste Linux. */
const BASE: InstallChoice = {
    os: 'linux',
    server: SERVER,
    code: ONE.code,
    allowed: [],
    autostart: true,
    admin: false,
    shuffleId: false
};

function Pairing() {
    const links = useLinkCodes(() => undefined);
    useEffect(() => void links.openLinkModal(), []);
    return <LinkCodesDialog links={links} onDownload={() => undefined} />;
}

async function opened(codes: LinkCodeResponse[] = [ONE], origin = SERVER): Promise<ReturnType<typeof userEvent.setup>> {
    server.feature(manifest).on('devices.linkCodeList', () => ({ codes, server: origin, quota: null }));
    await server.connect();
    const user = userEvent.setup();
    render(<Pairing />);
    await screen.findByRole('button', { name: 'Copier la commande' });
    return user;
}

const shown = (): string => document.querySelector('pre')?.textContent ?? '';
const pick = (role: 'radio' | 'button' | 'switch' | 'checkbox', name: string | RegExp): HTMLElement =>
    screen.getByRole(role, { name });

test('à l’ouverture, la commande ne donne aucun droit à DevEye sur la machine', async () => {
    await opened();

    assert.equal(pick('radio', 'Surveillance seule').matches(':checked'), true);
    assert.equal(shown(), installCommand(BASE));
    assert.ok(!shown().includes('--allow'));
});

test('les droits choisis sont ceux de la commande, et « Sur mesure » part de rien', async () => {
    const user = await opened();

    await user.click(pick('radio', 'Contrôle complet'));
    assert.equal(shown(), installCommand({ ...BASE, allowed: POLICY_KEYS }));
    assert.ok(shown().includes('--allow all'));

    await user.click(pick('radio', 'Sur mesure'));
    assert.equal(shown(), installCommand(BASE));

    // Le terminal root ne se coche qu'avec le terminal, et tombe avec lui.
    assert.equal(pick('checkbox', 'Terminal root').matches(':disabled'), true);
    await user.click(pick('checkbox', 'Terminal'));
    assert.equal(shown(), installCommand({ ...BASE, allowed: ['terminal'] }));
    await user.click(pick('checkbox', 'Terminal root'));
    assert.equal(shown(), installCommand({ ...BASE, allowed: ['terminal', 'terminalRoot'] }));
    assert.ok(shown().includes('--allow terminal,terminal-root'));
    await user.click(pick('checkbox', 'Terminal'));
    assert.equal(shown(), installCommand(BASE));
});

test('le système, le démarrage, l’administrateur et la variante se lisent dans la commande', async () => {
    const user = await opened();

    await user.click(pick('switch', /En administrateur/));
    assert.equal(shown(), installCommand({ ...BASE, admin: true }));
    assert.ok(shown().includes('| sudo sh'));

    await user.click(pick('switch', /Démarrer avec la machine/));
    assert.equal(shown(), installCommand({ ...BASE, admin: true, autostart: false }));

    await user.click(pick('button', 'Agent déjà installé'));
    assert.equal(shown(), linkCommand({ ...BASE, admin: true, autostart: false }));

    await user.click(pick('button', 'Windows'));
    assert.equal(shown(), linkCommand({ ...BASE, os: 'windows', admin: true, autostart: false }));

    await user.click(pick('button', 'Installer l’agent'));
    assert.equal(shown(), installCommand({ ...BASE, os: 'windows', admin: true, autostart: false }));
});

test('le code choisi dans la liste est celui de la commande, et un code de flotte propose une identité par machine', async () => {
    const user = await opened([ONE, FLEET]);
    assert.ok(!screen.queryByRole('checkbox', { name: /Machines clonées/ }));

    await user.click(pick('button', FLEET.code));
    assert.equal(shown(), installCommand({ ...BASE, code: FLEET.code }));

    await user.click(pick('checkbox', /Machines clonées/));
    assert.equal(shown(), installCommand({ ...BASE, code: FLEET.code, shuffleId: true }));
});

test('« Copier la commande » met au presse-papiers ce qui est affiché', async () => {
    const user = await opened();
    await user.click(pick('radio', 'Contrôle complet'));

    await user.click(pick('button', 'Copier la commande'));

    assert.ok(await screen.findByRole('button', { name: 'Copié' }));
    assert.equal(await navigator.clipboard.readText(), shown());
});

test('un serveur sans HTTPS est dit avant que l’agent ne le refuse', async () => {
    await opened([ONE], 'http://192.168.1.20:3000');

    assert.ok(screen.getByText(/n’est pas en HTTPS/));
    assert.equal(shown(), installCommand({ ...BASE, server: 'http://192.168.1.20:3000' }));
});
