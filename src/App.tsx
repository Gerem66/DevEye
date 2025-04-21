import { useState } from 'react';

import HomePage from './Pages/Home/index.js';
import LoginPage from './Pages/Login/index.js';

import './Styles/sizes.css';
import './Styles/fonts.css';
import './Styles/icons.css';
import './Styles/colors.css';
import './Styles/input.css';
import './Styles/table.css';

type UserType = import('Types/User').UserType;

function App() {
    const [user, setUser] = useState<UserType | null>(null);

    return (
        <>
            <HomePage user={user} setUser={setUser} />
            <LoginPage user={user} setUser={setUser} />
        </>
    );
}

export default App;
