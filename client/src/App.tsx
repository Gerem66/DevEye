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
        <AuthProvider>
            <AppRoot />
        </AuthProvider>
    );
}

export default App;
