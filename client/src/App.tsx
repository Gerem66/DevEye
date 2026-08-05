import { MotionConfig } from 'framer-motion';
import { useState } from 'react';

import HomePage from './Pages/Home/index.js';
import LoginPage from './Pages/Login/index.js';
import RegisterPage, { readRegisterToken } from './Pages/Login/Register';
import { SecrecyGate } from './Components/SecrecyGate';
import { AuthProvider, useAuth } from './auth/AuthProvider';

import './Styles/theme.css';
import './Styles/fonts.css';
import './Styles/icons.css';
import './Styles/input.css';

function AppRoot() {
    const { status } = useAuth();
    // Lu une seule fois : l'URL est nettoyée dès que le compte est créé, pour
    // qu'un rafraîchissement ne repropose pas un jeton déjà consommé.
    const [registerToken, setRegisterToken] = useState<string | null>(readRegisterToken);

    // Un lien d'inscription prime sur l'écran de connexion : celui qui le suit
    // n'a justement pas encore de compte.
    if (registerToken && status !== 'authenticated') {
        return (
            <RegisterPage
                token={registerToken}
                onDone={() => {
                    setRegisterToken(null);
                    window.history.replaceState({}, '', '/');
                }}
            />
        );
    }

    return (
        <>
            {status === 'authenticated' && <HomePage />}
            {status === 'authenticated' && <SecrecyGate />}
            <LoginPage />
        </>
    );
}

function App() {
    return (
        // `reducedMotion="user"` honours the OS "reduce motion" setting: framer
        // skips the heavy transform/layout morphs (keeping cheap opacity fades),
        // which is both an accessibility win and lighter on low-end GPUs.
        <MotionConfig reducedMotion='user'>
            <AuthProvider>
                <AppRoot />
            </AuthProvider>
        </MotionConfig>
    );
}

export default App;
