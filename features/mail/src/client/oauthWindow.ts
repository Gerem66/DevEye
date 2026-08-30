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
