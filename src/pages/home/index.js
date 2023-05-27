import React from 'react';

import './style.css';
import user from '../../class/user';

import { Navbar } from '../../components/components';

function HomePage() {
    const [ context, setContext ] = React.useState(user.contexts[0]);
    const [ content, setContent ] = React.useState(null);

    return (
        <div id='home' className='home'>
            <div className="home-left">
                <Navbar
                    context={context}
                    setContent={setContent}
                    setContext={setContext}
                />
            </div>

            <div className="home-right">
                {content}
            </div>
        </div>
    );
}

export default HomePage;