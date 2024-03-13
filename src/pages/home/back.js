import React from 'react';

import { GlobalContext } from '../../context';

/**
 * @typedef {import('../../context').ReactContextType} ReactContextType
 * @typedef {import('Types/Context').ContextType} ContextType
 */

class HomePageBack extends React.Component {
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
}

export default HomePageBack;
