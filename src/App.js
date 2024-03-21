import { useState } from 'react';

import HomePage from './Pages/Home/index';
import LoginPage from './Pages/Login/index';

import './Styles/sizes.css';
import './Styles/fonts.css';
import './Styles/icons.css';
import './Styles/colors.css';

import ClientTCP from './Utils/TCP';

/**
 * @typedef {import('Types/User').UserType} UserType
 */

function App() {
    const tcp = new ClientTCP();
    const [ user, setUser ] = useState(/** @type {UserType | null} */ (null));

    return (
        <>
            <HomePage tcp={tcp} user={user} setUser={setUser} />
            <LoginPage tcp={tcp} user={user} setUser={setUser} />
        </>
    );
}

export default App;
