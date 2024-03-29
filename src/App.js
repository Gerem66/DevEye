import { useState } from 'react';

import HomePage from './Pages/Home/index';
import LoginPage from './Pages/Login/index';

import './Styles/sizes.css';
import './Styles/fonts.css';
import './Styles/icons.css';
import './Styles/colors.css';
import './Styles/input.css';
import './Styles/table.css';

/**
 * @typedef {import('Types/User').UserType} UserType
 */

function App() {
    const [ user, setUser ] = useState(/** @type {UserType | null} */ (null));

    return (
        <>
            <HomePage user={user} setUser={setUser} />
            <LoginPage user={user} setUser={setUser} />
        </>
    );
}

export default App;
