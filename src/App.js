import React from 'react';

import auth from './class/auth';
import HomePage from './pages/home/index';
import LoginPage from './pages/login/index';

import './global/fonts.css'
import './global/icons.css';

function App() {
    const user = localStorage.getItem('user');

    const [ showLogin, setShowLogin ] = React.useState(user === null);
    const [ logged, setLogged ] = React.useState(user !== null);
    auth.SetHooks(setLogged, setShowLogin);

    return (
        <React.StrictMode>
            {logged && <HomePage />}
            <LoginPage show={showLogin} />
        </React.StrictMode>
    );
}

export default App;