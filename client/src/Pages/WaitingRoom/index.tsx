import { ws } from '@/api/ws';
import Button from '@/Components/Button';
import { LoginScene } from '@/Pages/Login/Scene';
import { TextLink } from '@/Pages/Login/TextLink';
import type { Admission } from '@/stores/admission';

interface WaitingRoomPageProps {
    admission: NonNullable<Admission>;
    onLogout: () => void;
}

/**
 * Ce que voit un compte que les places simultanées font attendre. La socket
 * relance d'elle-même : la page entre sans qu'on y touche dès qu'une place se
 * libère.
 */
export default function WaitingRoomPage({ admission, onLogout }: WaitingRoomPageProps) {
    return (
        <LoginScene
            footer={
                <TextLink href='/' shown onNavigate={onLogout}>
                    Se déconnecter
                </TextLink>
            }
        >
            <div className='maintenance' role='status' aria-live='polite'>
                {admission.kind === 'queued' ? (
                    <>
                        <span className='icon icon-clock' aria-hidden='true' />
                        <p className='maintenance-message'>
                            {`Le serveur est très demandé : pour ne pas dégrader le service, les entrées se font une à une.\nVous êtes n° ${admission.position} dans la file d’attente. Cette page vous fera entrer d’elle-même.`}
                        </p>
                    </>
                ) : (
                    <>
                        <span className='icon icon-pause' aria-hidden='true' />
                        <p className='maintenance-message'>
                            Après 20 minutes sans activité, votre place est allée à quelqu’un qui attendait.
                        </p>
                        <Button onClick={() => void ws.local.reconnect().catch(() => {})}>Reprendre</Button>
                    </>
                )}
            </div>
        </LoginScene>
    );
}
