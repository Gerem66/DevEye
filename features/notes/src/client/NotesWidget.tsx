import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

/**
 * `notes.count` is not gated by the password-encryption unlock: private notes are
 * counted like any other and the card never prompts. Archived notes are left
 * out, so the count matches the list.
 */
export function NotesWidget() {
    const state = useWorkspaceCount('notes.count');
    return <CountWidget state={state} noun='note' hint='Vos notes et pense-bêtes' empty='Aucune note' />;
}

export default NotesWidget;
