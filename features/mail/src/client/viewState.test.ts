import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MailAccount, MailFolder } from '../contracts/domain';
import { describeEmptyState, mailViewState, type MailViewInput } from './viewState';

/**
 * Ce que la vue Mail a à montrer, et ce qu'elle propose quand elle n'a rien.
 *
 * L'état vide est le mode de panne le plus discret de cette feature : rien ne
 * casse, l'écran est simplement muet, et c'est arrivé plusieurs fois sans qu'un
 * test s'en aperçoive. La règle qui compte tient en une phrase : tout état vide
 * dit ce qui manque, et celui dont on ne sort pas seul propose un geste.
 */

const account = (over: Partial<MailAccount> = {}): MailAccount =>
    ({ id: 1, displayName: 'Perso', enabled: true, ...over }) as MailAccount;

const folder = (id: number): MailFolder => ({ id, name: 'INBOX' }) as MailFolder;

function input(over: Partial<MailViewInput> = {}): MailViewInput {
    return {
        accountsLoading: false,
        foldersLoading: false,
        accounts: [account()],
        selectedAccount: account(),
        folders: [folder(10)],
        selectedFolderId: 10,
        ...over
    };
}

describe('l’état de la vue Mail', () => {
    it('un dossier ouvert : la vue a du contenu', () => {
        assert.equal(mailViewState(input()).kind, 'ready');
    });

    it('une boîte ouverte dont les dossiers n’ont pas pu être lus', () => {
        // Le serveur sert son cache plutôt que d'échouer : l'absence de dossiers
        // arrive ici SANS erreur, et c'est le seul signe qu'il s'est passé
        // quelque chose. C'est le cas qui laissait l'écran muet.
        const state = mailViewState(input({ folders: [], selectedFolderId: null }));
        assert.equal(state.kind, 'no-folders');
    });

    it('le chargement des dossiers ne passe pas par « aucun dossier »', () => {
        // Sinon la seconde qui les sépare annoncerait une boîte vide, puis se
        // raviserait : un clignotement qui se lit comme un bug.
        assert.equal(mailViewState(input({ foldersLoading: true, folders: [] })).kind, 'loading');
    });

    it('des dossiers, mais aucun ouvert', () => {
        assert.equal(mailViewState(input({ selectedFolderId: null })).kind, 'no-folder-picked');
    });

    it('aucune boîte ouverte, et aucune boîte du tout', () => {
        assert.equal(mailViewState(input({ selectedAccount: null })).kind, 'no-selection');
        assert.equal(mailViewState(input({ accounts: [], selectedAccount: null })).kind, 'no-accounts');
    });
});

describe('ce qu’un état vide raconte', () => {
    it('tout état vide se nomme ; seul « ready » n’a rien à dire', () => {
        for (const state of [
            mailViewState(input({ accountsLoading: true })),
            mailViewState(input({ accounts: [], selectedAccount: null })),
            mailViewState(input({ selectedAccount: null })),
            mailViewState(input({ folders: [], selectedFolderId: null })),
            mailViewState(input({ selectedFolderId: null }))
        ]) {
            assert.ok(describeEmptyState(state)?.title, `${state.kind} doit se nommer`);
        }
        assert.equal(describeEmptyState(mailViewState(input())), null);
    });

    it('l’état dont on ne sort pas seul propose un geste', () => {
        const stuck = mailViewState(input({ folders: [], selectedFolderId: null }));
        assert.equal(describeEmptyState(stuck)?.action, 'Relever les dossiers');
    });

    it('une boîte en pause le dit, plutôt que de laisser croire à une panne', () => {
        const paused = mailViewState(
            input({ selectedAccount: account({ enabled: false }), folders: [], selectedFolderId: null })
        );
        assert.match(describeEmptyState(paused)?.hint ?? '', /pause/);
    });

    it('les états dont on sort par un clic évident ne proposent rien', () => {
        for (const state of [
            mailViewState(input({ selectedAccount: null })),
            mailViewState(input({ selectedFolderId: null }))
        ]) {
            assert.equal(describeEmptyState(state)?.action, null);
        }
    });
});
