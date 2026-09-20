import { MotionConfig } from 'framer-motion';

import HomePage from './Pages/Home/index.js';
import LoginPage from './Pages/Login/index.js';
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

    return (
        <>
            {status === 'authenticated' && <HomePage />}
            {status === 'authenticated' && <SecrecyGate />}
            {/* Monté ici et non dans l'accueil : le bouton doit survivre à
                n'importe quelle vue, et se poser au-dessus d'elles toutes. */}
            {status === 'authenticated' && <ReportButton />}

            <LoginPage />
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
