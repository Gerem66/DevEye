import { Component, createContext } from 'react';

import ClientTCP from './Utils/TCP';
import { Clear, Load, Save } from './Utils/storage';

/**
 * @typedef {import('Types/User').UserType} UserType
 * 
 * @typedef {Object} ReactContextType
 * @property {ClientTCP} server
 * @property {UserType | null} user
 * @property {(newUser: UserType | null) => void} setUser
 */

/** @type {ReactContextType} */
const DEFAULT_VALUE = {
    server: new ClientTCP(),
    user: null,
    /** @param {UserType | null} user */
    setUser: (user) => {}
};

const GlobalContext = createContext(DEFAULT_VALUE);

class ContextProvider extends Component {
    /** @param {Object} props */
    constructor(props) {
        super(props);
        this.state = DEFAULT_VALUE;

        const user = /** @type {UserType | null} */ (Load('user'));
        if (user !== null) {
            this.state.user = user;
        }
    }

    componentDidMount() {
    }

    /** @param {UserType | null} newUser */
    setUser = (newUser) => {
        if (newUser === null) {
            Clear('user');
        } else {
            Save('user', newUser);
        }
        this.setState({ user: newUser });
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
