import React from 'react';

import './style.css';

import { GlobalContext } from '../../context';
import { Navbar } from '../../components/components';

/**
 * @typedef {import('../../context').ReactContextType} ContextType
 */

class HomePage extends React.Component {
    static contextType = GlobalContext;

    render() {
        const { user } = /** @type {ContextType} */ (this.context);
        if (user === null) return null;

        return (
            <div id='home' className='home'>
                <div className="home-left">
                    <Navbar
                        context={user === null || user.Contexts.length === 0 ? null : user.Contexts[0]}
                    />
                </div>

                <div className="home-right">
                    {/* Content */}
                </div>
            </div>
        );
    }
}

export default HomePage;