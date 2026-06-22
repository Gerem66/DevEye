import { CountWidget, useWorkspaceCount } from '@/Components/CountWidget';

/**
 * Compact dashboard card for Notes: a plain count of the workspace's notes.
 * Backed by `note.count`, which is not gated by the password-encryption unlock,
 * so locked notes are counted like any other and the card never prompts.
 */
export function NotesWidget() {
    const state = useWorkspaceCount('note.count');
    return <CountWidget state={state} noun='note' hint='Vos notes et pense-bêtes' empty='Aucune note' />;
}

export default NotesWidget;
