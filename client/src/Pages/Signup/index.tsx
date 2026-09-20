import { SignupStart } from './Start';
import { SignupVerify } from './Verify';
import type { SignupRoute } from './route';

interface SignupPageProps {
    route: SignupRoute;
    /** Le compte est créé et la scène s'est effacée. */
    onDone: () => void;
    onLogin: () => void;
    onRestart: () => void;
}

export default function SignupPage({ route, onDone, onLogin, onRestart }: SignupPageProps) {
    return route.kind === 'verify' ? (
        <SignupVerify token={route.token} onDone={onDone} onRestart={onRestart} />
    ) : (
        <SignupStart plan={route.plan} onLogin={onLogin} />
    );
}
