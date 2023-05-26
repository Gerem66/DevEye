import React from 'react';

import './styleProjects.css';
import user from '../../../class/user';

/**
 * @typedef {import('../../../class/feature').ProjectContext} ProjectContext
 */

const NavProjectsProps = {
    /** @type {(project: ProjectContext|null) => void} */
    onProjectClick: (project) => {}
};


function NavProjects(props = NavProjectsProps) {
    const { onProjectClick } = props;

    /** @param {ProjectContext} context */
    function ProjectButton(context) {
        const { id, name, logo } = context;
        return (
            <button
                key={'project-' + id}
                className='button nav-project-button'
                onClick={() => onProjectClick(context)}
            >
                <img
                    className='nav-project-logo'
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
                key={'project-back'}
                className='button nav-back-button'
                onClick={() => onProjectClick(null)}
            >
                <span className='icon icon-arrow' />
                <span>Retour</span>
                <span className='icon icon-blank' />
            </button>
            {user.projects.map(ProjectButton)}
        </>
    );
}

export default NavProjects;