import { PasswordResetForm } from './Reset';
import { PasswordResetStart } from './Start';
import type { PasswordResetRoute } from './route';

interface PasswordResetPageProps {
    route: PasswordResetRoute;
    /** Retour au formulaire de connexion, le nom d'utilisateur prérempli une fois le mot de passe changé. */
    onLogin: (username?: string) => void;
    onRestart: () => void;
}

export default function PasswordResetPage({ route, onLogin, onRestart }: PasswordResetPageProps) {
    return route.kind === 'reset' ? (
        <PasswordResetForm token={route.token} onLogin={onLogin} onRestart={onRestart} />
    ) : (
        <PasswordResetStart onLogin={() => onLogin()} />
    );
}
