import type { MailAccount, MailFolder } from '../contracts/domain';

/**
 * Dans quel état la vue Mail se trouve, et ce qu'on peut y faire.
 *
 * Une seule question posée à un seul endroit, parce que trois surfaces en
 * dépendaient chacune de leur côté et se contredisaient : la colonne des
 * messages disait « Sélectionnez une boîte mail » alors qu'une boîte était
 * ouverte, la colonne des dossiers restait muette, et le bouton de relève se
 * désactivait précisément quand il était le seul recours.
 *
 * `empty` porte ce qu'il faut afficher ET ce qu'il faut proposer : un état vide
 * sans issue est ce qui bloque, pas le vide lui-même.
 */
export type MailViewState =
    /** La liste des boîtes n'est pas encore là. */
    | { kind: 'loading' }
    /** Aucune boîte dans cet espace. */
    | { kind: 'no-accounts' }
    /** Des boîtes, mais aucune ouverte. */
    | { kind: 'no-selection' }
    /**
     * Une boîte ouverte dont aucun dossier n'est connu. Jamais relevée, ou
     * relevée sans succès : le serveur sert son cache plutôt que d'échouer, si
     * bien que l'absence de dossiers arrive ici sans erreur à afficher.
     */
    | { kind: 'no-folders'; account: MailAccount }
    /** Des dossiers, mais aucun ouvert. */
    | { kind: 'no-folder-picked'; account: MailAccount }
    /** Un dossier est ouvert : la vue a du contenu. */
    | { kind: 'ready' };

export interface MailViewInput {
    accountsLoading: boolean;
    foldersLoading: boolean;
    accounts: MailAccount[];
    selectedAccount: MailAccount | null;
    folders: MailFolder[];
    selectedFolderId: number | null;
}

export function mailViewState(input: MailViewInput): MailViewState {
    // Le chargement des dossiers compte comme celui de la vue : sans cela, la
    // seconde qui les sépare afficherait « aucun dossier » puis se raviserait.
    if (input.accountsLoading || input.foldersLoading) return { kind: 'loading' };
    if (input.accounts.length === 0) return { kind: 'no-accounts' };
    if (!input.selectedAccount) return { kind: 'no-selection' };
    if (input.folders.length === 0) return { kind: 'no-folders', account: input.selectedAccount };
    if (input.selectedFolderId === null) return { kind: 'no-folder-picked', account: input.selectedAccount };
    return { kind: 'ready' };
}

/** Ce qu'un état vide dit, et l'intitulé de son recours quand il en a un. */
export interface MailEmptyView {
    title: string;
    hint: string | null;
    /** `null` quand l'état se résout par un geste évident (choisir dans la liste). */
    action: string | null;
}

/**
 * Le texte d'un état vide. À part du calcul d'état pour que les deux colonnes
 * qui l'affichent disent la même chose, et pour que le libellé se relise sans
 * ouvrir un composant.
 */
export function describeEmptyState(state: MailViewState): MailEmptyView | null {
    switch (state.kind) {
        case 'loading':
            return { title: 'Chargement…', hint: null, action: null };
        case 'no-accounts':
            return {
                title: 'Aucune boîte mail',
                hint: 'Ajoutez une boîte IMAP/SMTP, ou connectez-en une chez Google ou Microsoft.',
                action: null
            };
        case 'no-selection':
            return { title: 'Aucune boîte ouverte', hint: 'Choisissez-en une dans la liste.', action: null };
        case 'no-folders':
            return {
                title: 'Aucun dossier relevé',
                hint: state.account.enabled
                    ? 'Les dossiers de cette boîte n’ont pas encore pu être lus. Un serveur qui vient d’accorder un accès met parfois un moment à le rendre.'
                    : 'Cette boîte est en pause : plus rien n’est relevé. Reprenez la relève dans ses réglages, ou lisez ses dossiers une fois.',
                action: 'Relever les dossiers'
            };
        case 'no-folder-picked':
            return { title: 'Aucun dossier ouvert', hint: 'Choisissez-en un à gauche.', action: null };
        case 'ready':
            return null;
    }
}
