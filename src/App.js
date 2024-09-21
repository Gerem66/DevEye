import { useState } from 'react';

import HomePage from './Pages/Home/index.js';
import LoginPage from './Pages/Login/index.js';

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
    /** @type {[UserType | null, React.Dispatch<React.SetStateAction<UserType | null>>]} */
    // @ts-ignore
    const [user, setUser] = useState(null);

    return (
        <>
            <HomePage user={user} setUser={setUser} />
            <LoginPage user={user} setUser={setUser} />
        </>
    );
}

export default App;
