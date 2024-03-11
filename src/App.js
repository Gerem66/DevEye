import React, { useEffect } from 'react';

import user from './class/user';
import HomePage from './pages/home/index';
import LoginPage from './pages/login/index';
import Server from './class/node';

import './styles/sizes.css';
import './styles/fonts.css';
import './styles/icons.css';
import './styles/colors.css';
import ContextProvider, { GlobalContext } from './context';

function App() {
    const loaded = false; //user.Load();

    const { user } = React.useContext(GlobalContext);
    const [ showLogin, setShowLogin ] = React.useState(!loaded);

    useEffect(() => {
        const server = new Server();
        server.Connect();

        return () => {
            server.Disconnect();
        };
    }, []);

    return (
        <React.StrictMode>
            <ContextProvider>
                <HomePage />
                <LoginPage
                    showLogin={showLogin}
                    setShowLogin={setShowLogin}
                />
            </ContextProvider>
        </React.StrictMode>
    );
}

export default App;