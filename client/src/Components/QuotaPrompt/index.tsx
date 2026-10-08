import { useEffect, useState } from 'react';

import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import { accountEntries } from '@/sdk/registry';
import { openAccountView } from '@/stores/accountView';
import { onQuotaExceeded, type QuotaPromptRequest } from '@/stores/quotaPrompt';
import { useWorkspacePermissions } from '@/stores/workspace';

/**
 * L'invite commune à toute limite d'offre : une création refusée, un élément
 * en pause qu'on voulait lancer, ou une fonctionnalité que l'offre n'inclut
 * pas. Montée une fois, par l'accueil.
 *
 * L'offre est celle du propriétaire de l'espace : lui seul se voit proposer
 * d'en changer, un membre apprend à qui s'adresser.
 */
export function QuotaPrompt() {
    const [request, setRequest] = useState<QuotaPromptRequest | null>(null);
    const { isOwner } = useWorkspacePermissions();
    useEffect(() => onQuotaExceeded(setRequest), []);

    const close = (): void => setRequest(null);
    const offers = accountEntries().length > 0;

    if (request?.kind === 'pro') {
        return (
            <Dialog
                open
                onClose={close}
                title={request.title}
                description={
                    <>
                        {request.body}
                        {!isOwner && (
                            <>
                                <br />
                                L’offre est celle du propriétaire de l’espace : lui seul peut la changer.
                            </>
                        )}
                    </>
                }
                width={460}
                footer={
                    <>
                        <Button variant='secondary' onClick={close}>
                            Fermer
                        </Button>
                        {offers && isOwner && (
                            <Button
                                onClick={() => {
                                    close();
                                    openAccountView(undefined, 'pro');
                                }}
                            >
                                Voir l’offre Pro
                            </Button>
                        )}
                    </>
                }
            />
        );
    }

    // Le message de la priorité dit déjà quand tout reprend.
    const description = !request
        ? ''
        : request.priority
          ? request.message
          : request.paused
            ? `${request.message} Il reprend dès que l’offre le permet, ou qu’un plus ancien est supprimé.`
            : `${request.message} Ce que vous avez déjà n’est pas touché.`;
    return (
        <Dialog
            open={request !== null}
            onClose={close}
            title={
                request?.priority
                    ? 'Réservé aux abonnés pour le moment'
                    : request?.paused
                      ? 'Élément en pause'
                      : 'Limite de votre offre atteinte'
            }
            description={description}
            width={440}
            footer={
                <>
                    <Button variant='secondary' onClick={close}>
                        Fermer
                    </Button>
                    {offers && (
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
