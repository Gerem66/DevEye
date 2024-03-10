import React, { Component, createContext } from 'react';

/**
 * @typedef {import('Types/User').UserType} UserType
 * 
 * @typedef {Object} ReactContextType
 * @property {UserType | null} user
 * @property {(newUser: UserType) => void} setUser
 */

/** @type {ReactContextType} */
const DEFAULT_VALUE = {
    user: null,
    setUser: () => {}
};

const GlobalContext = createContext(DEFAULT_VALUE);

// Création du fournisseur de contexte en tant que composant de classe
class ContextProvider extends Component {
    constructor(props) {
        super(props);
        this.state = DEFAULT_VALUE;
    }

    setUser = (newUser) => {
        this.setState({ user: newUser });
    };

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
