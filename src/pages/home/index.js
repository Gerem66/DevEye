import React from 'react';

import auth from '../../scripts/auth';

import './style.css';

function HomePage() {
    return (
        <div id='home' className='home'>
            <span
                style={{ color: 'red' }}
                onClick={auth.Logout}
            >
                Home
            </span>
        </div>
    );
}

export default HomePage;