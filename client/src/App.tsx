import { MotionConfig } from 'framer-motion';

import HomePage from './Pages/Home/index.js';
import LoginPage from './Pages/Login/index.js';
import { SecrecyGate } from './Components/SecrecyGate';
import { AuthProvider, useAuth } from './auth/AuthProvider';

import './Styles/theme.css';
import './Styles/fonts.css';
import './Styles/icons.css';
import './Styles/input.css';

function AppRoot() {
    const { status } = useAuth();

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
