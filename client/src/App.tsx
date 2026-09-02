import { MotionConfig } from 'framer-motion';
import { useState } from 'react';

import HomePage from './Pages/Home/index.js';
import LoginPage from './Pages/Login/index.js';
import RegisterPage, { readRegisterToken } from './Pages/Login/Register';
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
    // Lu une seule fois : l'URL est nettoyée dès que le compte est créé, pour
    // qu'un rafraîchissement ne repropose pas un jeton déjà consommé.
    const [registerToken, setRegisterToken] = useState<string | null>(readRegisterToken);

    return (
        <>
            {status === 'authenticated' && <HomePage />}
            {status === 'authenticated' && <SecrecyGate />}
            {/* Monté ici et non dans l'accueil : le bouton doit survivre à
                n'importe quelle vue, et se poser au-dessus d'elles toutes. */}
            {status === 'authenticated' && <ReportButton />}

            {/* Un lien d'inscription prend l'écran, celui qui le suit n'ayant pas
                encore de compte. Il reste monté après l'ouverture de la session et
                décide lui-même de s'effacer, à la fin de son animation : le démonter
                sur le statut couperait sa barre de progression en plein vol. */}
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
        // skips the heavy transform/layout morphs, keeping cheap opacity fades.
        <MotionConfig reducedMotion='user'>
            <AuthProvider>
                <AppRoot />
            </AuthProvider>
        </MotionConfig>
    );
}

export default App;
