import React from 'react';

import './style.css';

import { GlobalContext } from '../../context';
import { Navbar } from '../../components/components';

/**
 * @typedef {import('../../context').ReactContextType} ReactContextType
 * @typedef {import('Types/Context').ContextType} ContextType
 */

class HomePage extends React.Component {
    static contextType = GlobalContext;

    state = {
        /** @type {ContextType|null} */
        context: null,
        content: null
    };

    componentDidMount() {
        const { user } = /** @type {ReactContextType} */ (this.context);
        if (user === null || user.Contexts.length === 0) {
            return;
        }

        this.setState({ context: user.Contexts[0] });
    }

    componentDidUpdate() {
        const { user } = /** @type {ReactContextType} */ (this.context);
        if (user === null || user.Contexts.length === 0) {
            return;
        }

        // Set default context on login
        if (this.state.context === null) {
            this.setState({ context: user.Contexts[0] });
        }
    }

    render() {
        const { context } = this.state;
        const { user } = /** @type {ReactContextType} */ (this.context);
        if (user === null) return null;

        return (
            <div id='home' className='home'>
                <div className="home-left">
                    <Navbar
                        context={context}
                        setContext={(context) => this.setState({ context })}
                        setContent={(content) => this.setState({ content })}
                    />
                </div>

                <div className="home-right">
                    {/* Content */}
                    {this.state.content}
                </div>
            </div>
        );
    }
}

export default HomePage;