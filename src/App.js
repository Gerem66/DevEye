import React from 'react';

import ContextProvider from './context';
import HomePage from './pages/home/index';
import LoginPage from './pages/login/index';

import './styles/sizes.css';
import './styles/fonts.css';
import './styles/icons.css';
import './styles/colors.css';

function App() {
    return (
        <ContextProvider>
            <HomePage />
            <LoginPage />
        </ContextProvider>
    );
}

export default App;
