import React from 'react';

import './style.css';
import user from '../../class/user';
import Features from '../../class/feature';

import Navbar from '../../components/navbar';

function HomePage() {
    const [ context, setContext ] = React.useState(user.contexts[0]);
    const [ content, setContent ] = React.useState(Features[0].component(user.contexts[0]));

    return (
        <div id='home' className='home'>
            <div className="home-left">
                <Navbar
                    context={context}
                    setContent={setContent}
                    onContextClick={(context) => setContext(context)}
                />
            </div>

            <div className="home-right">
                {content}
            </div>
        </div>
    );
}

export default HomePage;