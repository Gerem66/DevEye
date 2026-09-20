import { MotionConfig } from 'framer-motion';
import { useEffect, useState } from 'react';

import HomePage from './Pages/Home/index.js';
import LoginPage from './Pages/Login/index.js';
import SignupPage from './Pages/Signup';
import { readSignupRoute, type SignupRoute } from './Pages/Signup/route';
import { SecrecyGate } from './Components/SecrecyGate';
import { ReportButton } from './Components/ReportButton';
import { AuthProvider, useAuth } from './auth/AuthProvider';

import './Styles/theme.css';
import './Styles/fonts.css';
import './Styles/icons.css';
import './Styles/icons.generated.css';
// La feuille des modules privés est importée ici, pas par un `@import` depuis la
// précédente : postcss fusionne un `@import` hors du pipeline des plugins, et
// l'inlining des icônes ne la verrait jamais. Elle est toujours écrite par
// `gen:features`, vide s'il n'y a aucun module privé.
import './Styles/icons.local.css';
import './Styles/live.css';
import './Styles/input.css';

function AppRoot() {
    const { status } = useAuth();
    const [signup, setSignup] = useState<SignupRoute | null>(readSignupRoute);

    // Le jeton quitte la barre d'adresse dès qu'il est lu : il ne reste ni dans
    // l'historique ni sous les yeux pendant que le formulaire se remplit.
    useEffect(() => {
        if (signup?.kind === 'verify') window.history.replaceState({}, '', '/signup/verify');
    }, [signup]);

    useEffect(() => {
        const onPop = (): void => setSignup(readSignupRoute());
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);

    const go = (path: string): void => {
        window.history.pushState({}, '', path);
        setSignup(readSignupRoute());
    };

    return (
        <>
            {status === 'authenticated' && <HomePage />}
            {status === 'authenticated' && <SecrecyGate />}
            {/* Monté ici et non dans l'accueil : le bouton doit survivre à
                n'importe quelle vue, et se poser au-dessus d'elles toutes. */}
            {status === 'authenticated' && <ReportButton />}

            {/* L'inscription prend l'écran à la place du login. Elle reste montée
                après l'ouverture de la session et s'efface d'elle-même, à la fin de
                son animation : la démonter sur le statut couperait sa barre de
                progression en plein vol. */}
            {signup && (signup.kind === 'verify' || status !== 'authenticated') ? (
                <SignupPage
                    route={signup}
                    onDone={() => {
                        window.history.replaceState({}, '', '/');
                        setSignup(null);
                    }}
                    onLogin={() => go('/')}
                    onRestart={() => go('/signup')}
                />
            ) : (
                <LoginPage onSignup={() => go('/signup')} />
            )}
        </>
    );
}

function App() {
    return (
        // `reducedMotion="user"` honours the OS "reduce motion" setting: framer
        // skips the heavy transform/layout morphs, keeping cheap opacity fades.
        <MotionConfig reducedMotion='user'>
            <AuthProvider>
                <AppRoot />
            </AuthProvider>
        </MotionConfig>
    );
}

export default App;
