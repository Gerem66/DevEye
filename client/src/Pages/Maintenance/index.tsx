import { useEffect } from 'react';

import StatusPageLink from '@/Components/StatusPageLink';
import { LoginScene } from '@/Pages/Login/Scene';
import { TextLink } from '@/Pages/Login/TextLink';
import { refreshPublicMaintenance } from '@/stores/maintenance';

/** Le retour du site se voit sans recharger la page. */
const POLL_MS = 30_000;

interface MaintenancePageProps {
    message: string;
    /** Le formulaire de connexion, réservé aux administrateurs pendant la maintenance. */
    onAdminLogin: () => void;
}

/** Ce que voit quiconque la maintenance du site garde dehors, connecté ou non. */
export default function MaintenancePage({ message, onAdminLogin }: MaintenancePageProps) {
    useEffect(() => {
        void refreshPublicMaintenance();
        const timer = setInterval(() => void refreshPublicMaintenance(), POLL_MS);
        return () => clearInterval(timer);
    }, []);

    return (
        <LoginScene
            footer={
                <TextLink href='/' shown onNavigate={onAdminLogin}>
                    Accès administrateur
                </TextLink>
            }
        >
            <div className='maintenance' role='status'>
                <span className='icon icon-wrench' aria-hidden='true' />
                <p className='maintenance-message'>{message}</p>
                <StatusPageLink>Suivre l’état des services</StatusPageLink>
            </div>
        </LoginScene>
    );
}
