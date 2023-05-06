import React from 'react';

import './style.css';
import Navbar from '../../components/navbar';

function HomePage() {
    return (
        <div id='home' className='home'>
            <div className="home-left">
                <Navbar />
            </div>

            <div className="home-right">
            </div>
        </div>
    );
}

export default HomePage;