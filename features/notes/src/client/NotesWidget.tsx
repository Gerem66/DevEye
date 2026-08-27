import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

/**
 * Compact dashboard card for Notes: a plain count of the workspace's notes.
 * Backed by `notes.count`, which is not gated by the password-encryption unlock,
 * so private notes are counted like any other and the card never prompts.
 * Archived notes are excluded: the card mirrors what the list shows.
 */
export function NotesWidget() {
    const state = useWorkspaceCount('notes.count');
    return <CountWidget state={state} noun='note' hint='Vos notes et pense-bêtes' empty='Aucune note' />;
}

export default NotesWidget;
