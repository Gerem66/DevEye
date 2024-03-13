import { Component, createContext } from 'react';

import ClientTCP from './Utils/TCP';
import { Load, Save } from './Utils/storage';

/**
 * @typedef {import('Types/User').UserType} UserType
 * 
 * @typedef {Object} ReactContextType
 * @property {ClientTCP} server
 * @property {UserType | null} user
 * @property {(newUser: UserType) => void} setUser
 */

/** @type {ReactContextType} */
const DEFAULT_VALUE = {
    server: new ClientTCP(),
    user: null,
    setUser: () => {}
};

const GlobalContext = createContext(DEFAULT_VALUE);

class ContextProvider extends Component {
    constructor(props) {
        super(props);
        this.state = DEFAULT_VALUE;

        const user = Load('user');
        if (user !== null) {
            this.state.user = user;
        }
    }

    componentDidMount() {
    }

    /** @param {UserType} newUser */
    setUser = (newUser) => {
        Save('user', newUser);
        this.setState({ user: newUser });

        if (newUser === null) {
            this.state.server.Disconnect();
        } else if (!this.state.server.IsConnected()) {
            this.state.server.Connect();
        }
    }

    render() {
        return (
            <GlobalContext.Provider value={{ ...this.state, setUser: this.setUser }}>
                {this.props.children}
            </GlobalContext.Provider>
        );
    }
}

export { GlobalContext };
export default ContextProvider;
