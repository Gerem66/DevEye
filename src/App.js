import React from 'react';
import { LoginPage } from './pages';

import './global/fonts.css'
import './global/icons.css';

function App() {
    console.log(location);
    return (
        <React.StrictMode>
            <LoginPage />
        </React.StrictMode>
    );
}

export default App;