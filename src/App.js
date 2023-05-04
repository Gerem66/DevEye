import React from 'react';
import { LoginPage, HomePage } from './pages';

import './global/fonts.css'
import './global/icons.css';

function App() {
    const user = localStorage.getItem('user');

    const [ showLogin, setShowLogin ] = React.useState(user === null);
    const [ logged, setLogged ] = React.useState(user !== null);
    const disconnect = () => {
        const input_username = /** @type {HTMLInputElement} */ (document.getElementById('tb-username'));
        input_username.focus();
        localStorage.removeItem('user');
        setLogged(false);
        setShowLogin(true);
    };

    return (
        <React.StrictMode>
            {logged && <HomePage disconnect={disconnect} />}
            <LoginPage show={showLogin} setShowLogin={setShowLogin} setLogged={setLogged} />
        </React.StrictMode>
    );
}

export default App;