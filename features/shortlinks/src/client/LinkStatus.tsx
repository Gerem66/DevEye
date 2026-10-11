import { PlanPausedBadge, StatusBadge } from 'deveye-sdk-client';

import type { Shortlink } from '../contracts/domain';

/** L'état d'un lien pour qui le gère, le même dans la liste et sur sa fiche. Rien quand il est en service. */
export default function LinkStatus({ link }: { link: Shortlink }) {
    return (
        <>
            {link.status === 'disabled' && <StatusBadge tone='neutral'>En pause</StatusBadge>}
            {link.status === 'planPaused' && <PlanPausedBadge />}
            {link.status === 'blocked' && <StatusBadge tone='danger'>Retiré</StatusBadge>}
            {link.status === 'expired' && <StatusBadge tone='neutral'>Expiré</StatusBadge>}
            {link.check.enabled && link.check.state === 'broken' && (
                <StatusBadge tone='warning'>Destination injoignable</StatusBadge>
            )}
            {link.hasPassword && (
                <StatusBadge tone='neutral' dot={false}>
                    <span className='icon icon-lock' aria-hidden='true' /> Mot de passe
                </StatusBadge>
            )}
            {link.foreign && (
                <span title='Ce lien appartient à un autre espace qui le partage ici'>
                    <StatusBadge tone='accent' dot={false}>
                        partagé
                    </StatusBadge>
                </span>
            )}
        </>
    );
}
