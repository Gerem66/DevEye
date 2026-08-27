import { CountWidget, useWorkspaceCount } from 'deveye-sdk-client';

/**
 * Compact dashboard card for the password vault: a plain count of stored
 * entries. Backed by `password.count`, which is not gated by the
 * password-encryption unlock, so the card shows a number even when locked.
 */
export function PasswordWidget() {
    const state = useWorkspaceCount('password.count');
    return <CountWidget state={state} noun='entrée' hint='Vos mots de passe' empty='Aucun mot de passe' />;
}

export default PasswordWidget;
