/** Ce que la fenêtre de la banque a dit, en une phrase à montrer telle quelle. */
export class ConsentError extends Error {}

/**
 * La fenêtre où l'on consent chez sa banque. Elle passe par la banque, qui
 * tient donc `window.opener` : seul un message venu de l'origine de DevEye ET
 * de cette fenêtre fait foi. Une fenêtre fermée avant la fin rend `null`.
 */
export function awaitBankWindow(popup: Window): Promise<{ ok: boolean; error: string | null } | null> {
    return new Promise((resolve) => {
        const finish = (verdict: { ok: boolean; error: string | null } | null) => {
            window.removeEventListener('message', onMessage);
            window.clearInterval(poll);
            resolve(verdict);
        };
        function onMessage(e: MessageEvent) {
            if (e.origin !== window.location.origin || e.source !== popup) return;
            const data = e.data as { source?: string; ok?: boolean; error?: string | null } | undefined;
            if (data?.source !== 'deveye-finance-bank') return;
            finish({ ok: data.ok === true, error: data.error ?? null });
        }
        const poll = window.setInterval(() => {
            if (popup.closed) finish(null);
        }, 500);
        window.addEventListener('message', onMessage);
    });
}

/** Ouvre la banque dans une fenêtre et attend son accord. Lève `ConsentError` sur tout autre dénouement. */
export async function consentAtBank(authUrl: string): Promise<{ ok: boolean; error: string | null }> {
    const popup = window.open(authUrl, 'deveye-finance-bank', 'width=520,height=720');
    if (!popup)
        throw new ConsentError(
            'Fenêtre bloquée par le navigateur : autorisez les fenêtres de DevEye, puis recommencez.'
        );
    const verdict = await awaitBankWindow(popup);
    if (verdict === null) throw new ConsentError('La fenêtre de la banque s’est fermée avant la fin.');
    if (!verdict.ok) throw new ConsentError(`La banque n’a pas été reliée : ${verdict.error ?? 'raison inconnue'}`);
    return verdict;
}
