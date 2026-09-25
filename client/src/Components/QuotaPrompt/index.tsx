import { useEffect, useState } from 'react';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import { accountEntries } from '@/sdk/registry';
import { openAccountView } from '@/stores/accountView';
import { onQuotaExceeded } from '@/stores/quotaPrompt';

/**
 * L'invite commune à toute limite d'offre : une création refusée, ou un élément
 * en pause qu'on voulait lancer. Montée une fois, par l'accueil.
 */
export function QuotaPrompt() {
    const [refusal, setRefusal] = useState<{ message: string; paused: boolean } | null>(null);
    useEffect(() => onQuotaExceeded((message, paused) => setRefusal({ message, paused })), []);

    const close = (): void => setRefusal(null);
    return (
        <Dialog
            open={refusal !== null}
            onClose={close}
            title={refusal?.paused ? 'Élément en pause' : 'Limite de votre offre atteinte'}
            description={
                refusal?.paused
                    ? `${refusal.message} Il reprend dès que l’offre le permet, ou qu’un plus ancien est supprimé.`
                    : `${refusal?.message ?? ''} Ce que vous avez déjà n’est pas touché.`
            }
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
