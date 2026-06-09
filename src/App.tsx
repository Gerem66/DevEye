import HomePage from './Pages/Home/index.js';
import LoginPage from './Pages/Login/index.js';
import { AuthProvider, useAuth } from './auth/AuthProvider';

import './Styles/colors.css';
import './Styles/fonts.css';
import './Styles/icons.css';
import './Styles/input.css';
import './Styles/sizes.css';
import './Styles/table.css';

function AppRoot() {
    const { status } = useAuth();

    return (
        <>
            {status === 'authenticated' && <HomePage />}
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
