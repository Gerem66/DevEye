import { useEffect, useState } from 'react';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import { accountEntries } from '@/sdk/registry';
import { openAccountView } from '@/stores/accountView';
import { onQuotaExceeded } from '@/stores/quotaPrompt';

/** L'invite commune à toute limite d'offre atteinte. Montée une fois, par l'accueil. */
export function QuotaPrompt() {
    const [message, setMessage] = useState<string | null>(null);
    useEffect(() => onQuotaExceeded(setMessage), []);

    const close = (): void => setMessage(null);
    return (
        <Dialog
            open={message !== null}
            onClose={close}
            title='Limite de votre offre atteinte'
            description={`${message ?? ''} Vos éléments existants restent pleinement utilisables.`}
            width={440}
            footer={
                <>
                    <Button variant='secondary' onClick={close}>
                        Fermer
                    </Button>
                    {accountEntries().length > 0 && (
                        <Button
                            onClick={() => {
                                close();
                                openAccountView();
                            }}
                        >
                            Voir les offres
                        </Button>
                    )}
                </>
            }
        />
    );
}
