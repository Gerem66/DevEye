import { useEffect, useState } from 'react';
import { CountWidget, onSocketOpen, useResourceVersion, type CountState } from 'deveye-sdk-client';

import { api } from './api';

/**
 * Le compte des boîtes, à la main plutôt que par `useWorkspaceCount` : ce
 * hook n'admet que les commandes nommées `<feature>.count`, et celle-ci
 * s'appelle `mail.accountCount`. Même discipline que lui : relu à chaque
 * ouverture de la socket et à chaque invalidation de sa clé, et une lecture
 * qui échoue garde le dernier nombre plutôt que de retomber sur un « 0 » qui
 * mentirait.
 */
function useAccountCount(): CountState {
    const version = useResourceVersion('mail.accountCount');
    const [state, setState] = useState<CountState>({ kind: 'loading' });

    useEffect(() => {
        let cancelled = false;
        const off = onSocketOpen(() => {
            api.send('mail.accountCount', {})
                .then((res) => {
                    if (!cancelled) setState({ kind: 'ready', count: res.count });
                })
                .catch(() => {});
        });
        return () => {
            cancelled = true;
            off();
        };
    }, [version]);

    return state;
}

/**
 * Compact dashboard card: number of configured mail accounts. Backed by
 * `mail.accountCount`, clear metadata with no unlock gate — same "always
 * renders a number" discipline as `password.count`/`notes.count`.
 */
export function MailWidget() {
    const state = useAccountCount();
    return <CountWidget state={state} noun='compte' hint='Boîtes mail configurées' empty='Aucune boîte configurée' />;
}

export default MailWidget;
