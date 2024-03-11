import React, { useEffect } from 'react';

import ContextProvider from './context';
import Server from './class/node';
import HomePage from './pages/home/index';
import LoginPage from './pages/login/index';

import './styles/sizes.css';
import './styles/fonts.css';
import './styles/icons.css';
import './styles/colors.css';

function App() {
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
                <LoginPage />
            </ContextProvider>
        </React.StrictMode>
    );
}

export default App;