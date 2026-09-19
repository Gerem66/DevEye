import { api } from './api';

import type { MailAccount } from '../contracts/domain';

/**
 * L'attente d'une fenêtre de consentement OAuth, partagée par l'ajout d'une
 * boîte et par la reconnexion d'une boîte existante : les deux ouvrent la même
 * fenêtre et lisent le même verdict.
 */

/** Ce que le serveur a répondu, ou `null` quand seule la fermeture a parlé. */
export interface ConsentVerdict {
    ok: boolean;
    error: string | null;
}

/**
 * Attend la fin du consentement : le verdict du serveur s'il parvient à
 * traverser, la fermeture de la fenêtre sinon.
 *
 * La page de callback est servie sur l'origine de l'app, qui n'est pas
 * forcément celle d'où le SPA a été chargé (en développement, le port de
 * l'API contre celui de Vite) : un `postMessage` dont l'origine cible ne
 * correspond pas est jeté sans un mot. D'où `verdict: null` quand seule la
 * fermeture a parlé : on ne sait pas, et l'appelant va demander à la liste.
 */
export function awaitConsentWindow(popup: Window): Promise<{ verdict: ConsentVerdict | null }> {
    return new Promise((resolve) => {
        const finish = (result: { verdict: ConsentVerdict | null }) => {
            window.removeEventListener('message', onMessage);
            clearInterval(poll);
            resolve(result);
        };
        function onMessage(e: MessageEvent) {
            // La popup passe par le fournisseur, qui tient donc `window.opener` : seul
            // un message venu de notre origine ET de cette fenêtre fait foi.
            if (e.origin !== window.location.origin || e.source !== popup) return;
            const data = e.data as { source?: string; ok?: boolean; error?: string } | undefined;
            if (data?.source !== 'deveye-mail-oauth') return;
            finish({ verdict: { ok: data.ok === true, error: data.error ?? null } });
        }
        const poll = window.setInterval(() => {
            if (popup.closed) finish({ verdict: null });
        }, 500);
        window.addEventListener('message', onMessage);
    });
}

/** Le nom du fournisseur tel qu'il s'écrit dans un bouton. */
export function providerLabel(account: MailAccount): string {
    return account.authMethod === 'oauth_google' ? 'Google' : 'Microsoft';
}

/**
 * Une reconnexion ne répare qu'une impasse d'autorisation : un serveur
 * injoignable revient tout seul, et repasser par le consentement n'ajouterait
 * qu'un geste inutile. Une boîte projetée depuis un autre espace se reconnecte
 * chez elle, le serveur refusant d'ici.
 */
export function canReconnect(account: MailAccount): boolean {
    return account.authMethod !== 'password' && !account.foreign && (account.needsReauth || account.status === 'auth');
}

/**
 * Repasse par le consentement du fournisseur pour CETTE boîte : ses messages et
 * ses dossiers restent, seuls ses jetons sont remplacés. La suppression suivie
 * d'un nouvel ajout ferait le même travail au prix du cache entier.
 *
 * Lève sur fenêtre bloquée et sur échec annoncé par le serveur ; l'appelant
 * garde son propre état d'occupation et recharge ce qu'il affiche.
 */
export async function reconnectAccount(account: MailAccount): Promise<ConsentVerdict | null> {
    const res = await api.send('mail.oauthStart', {
        provider: account.authMethod === 'oauth_google' ? 'google' : 'microsoft',
        securityTier: account.securityTier,
        displayName: '',
        accountId: account.id
    });
    const popup = window.open(res.authUrl, 'deveye-mail-oauth', 'width=520,height=680');
    if (!popup) throw new Error('Fenêtre bloquée par le navigateur : autorisez les popups pour DevEye.');
    const { verdict } = await awaitConsentWindow(popup);
    // Un échec annoncé par le serveur s'affiche tel quel : lui seul sait ce qui
    // a manqué, et le paraphraser perdrait la seule information utile.
    if (verdict && !verdict.ok) throw new Error(verdict.error ?? 'Échec de connexion.');
    return verdict;
}
