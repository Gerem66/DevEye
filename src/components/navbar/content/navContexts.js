import React from 'react';

import './styleContexts.css';
import user from '../../../class/user';

/**
 * @typedef {import('Types/Context').ContextType} ContextType
 */

const NavContextsProps = {
    /** @type {(context: ContextType|null) => void} */
    onContextClick: (context) => {}
};


function NavContexts(props = NavContextsProps) {
    const { onContextClick } = props;

    /** @param {ContextType} context */
    function ContextButton(context) {
        const { id, name, logo } = context;
        return (
            <button
                key={'context-' + id}
                className='button nav-context-button'
                onClick={() => onContextClick(context)}
            >
                <img
                    className='nav-context-logo'
                    src={'./images/' + logo}
                    alt={name}
                />
                <span>{name}</span>
            </button>
        );
    }

    return (
        <>
            <button
                key={'context-back'}
                className='button nav-back-button'
                onClick={() => onContextClick(null)}
            >
                <span className='icon icon-arrow' />
                <span>Retour</span>
                <span className='icon icon-blank' />
            </button>
            {user.Contexts.map(ContextButton)}
        </>
    );
}

export default NavContexts;