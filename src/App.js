import React from 'react';
import { LoginPage, HomePage } from './pages';

import './global/fonts.css'
import './global/icons.css';

function App() {
    console.log(location);
    return (
        <React.StrictMode>
            <HomePage />
            <LoginPage />
        </React.StrictMode>
    );
}

export default App;