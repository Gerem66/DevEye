import React from 'react';

import user from '../../class/user';
import Navbar from '../../components/navbar';

import './style.css';

function HomePage() {
    const [ context, setContext ] = React.useState(user.projects[0]);
    const [ content, setContent ] = React.useState(null);

    return (
        <div id='home' className='home'>
            <div className="home-left">
                <Navbar
                    context={context}
                    setContent={setContent}
                    onProjectClick={(project) => setContext(project)}
                />
            </div>

            <div className="home-right">
                {content}
            </div>
        </div>
    );
}

export default HomePage;