import React, { useEffect } from 'react';

import user from './class/user';
import auth from './class/auth';
import HomePage from './pages/home/index';
import LoginPage from './pages/login/index';
import Server from './class/node';

import './styles/sizes.css';
import './styles/fonts.css';
import './styles/icons.css';
import './styles/colors.css';

function App() {
    const loaded = user.Load();

    const [ showLogin, setShowLogin ] = React.useState(!loaded);
    const [ logged, setLogged ] = React.useState(loaded);
    auth.SetHooks(setLogged, setShowLogin);

    useEffect(() => {
        const server = new Server();
        server.Connect();
    }, []);

    return (
        <React.StrictMode>
            {logged && <HomePage />}
            <LoginPage show={showLogin} />
        </React.StrictMode>
    );
}

export default App;