/**
 * Les contextes (AAD) sous lesquels la clé serveur scelle une ligne : le blob
 * ne s'ouvre que pour la ligne qui l'a écrit. Partagés entre les services et
 * les scripts de re-scellement, qui doivent produire exactement la même chaîne.
 */
export const userDekContext = (userId: number): string => `user_secret_keys:dek:${userId}`;
export const userOpenDekContext = (userId: number): string => `user_secret_keys:open_dek:${userId}`;
export const workspaceDekContext = (workspaceId: number): string => `workspace_secret_keys:dek:${workspaceId}`;
export const totpContext = (userId: number): string => `user_2fa:secret:${userId}`;
