import { MotionConfig } from 'framer-motion';
import { useState } from 'react';

import HomePage from './Pages/Home/index.js';
import LoginPage from './Pages/Login/index.js';
import RegisterPage, { readRegisterToken } from './Pages/Login/Register';
import { CrashScreen } from './Components/CrashScreen';
import { SecrecyGate } from './Components/SecrecyGate';
import { AuthProvider, useAuth } from './auth/AuthProvider';

import './Styles/theme.css';
import './Styles/fonts.css';
import './Styles/icons.css';
import './Styles/live.css';
import './Styles/input.css';

function AppRoot() {
    const { status } = useAuth();
    // Lu une seule fois : l'URL est nettoyée dès que le compte est créé, pour
    // qu'un rafraîchissement ne repropose pas un jeton déjà consommé.
    const [registerToken, setRegisterToken] = useState<string | null>(readRegisterToken);

    return (
        <>
            {status === 'authenticated' && <HomePage />}
            {status === 'authenticated' && <SecrecyGate />}

            {/* Un lien d'inscription prend l'écran : celui qui le suit n'a
                justement pas encore de compte, l'écran de connexion ne lui sert
                à rien.

                Il reste monté même une fois le compte créé et la session
                ouverte : c'est lui qui décide de s'effacer, à la fin de son
                animation. Le démonter dès que le statut passe à « authentifié »
                couperait la barre de progression en plein vol — au moment le
                plus visible du parcours. */}
            {registerToken ? (
                <RegisterPage
                    token={registerToken}
                    onDone={() => {
                        setRegisterToken(null);
                        window.history.replaceState({}, '', '/');
                    }}
                />
            ) : (
                <LoginPage />
            )}
        </>
    );
}

function App() {
    return (
        // `reducedMotion="user"` honours the OS "reduce motion" setting: framer
        // skips the heavy transform/layout morphs (keeping cheap opacity fades),
        // which is both an accessibility win and lighter on low-end GPUs.
        <MotionConfig reducedMotion='user'>
            {/* Une erreur de rendu démonte la racine entière chez React 19 :
                sans cette frontière, la moindre exception ne laisse qu'un fond
                uni, sans message ni trace. Elle ne répare rien — elle rend la
                panne lisible, ce qui est la condition pour la corriger. */}
            <CrashScreen>
                <AuthProvider>
                    <AppRoot />
                </AuthProvider>
            </CrashScreen>
        </MotionConfig>
    );
}

export default App;
