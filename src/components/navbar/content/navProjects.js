import React from 'react';

import user from '../../../class/user';

import './styleProjects.css';

/**
 * @typedef {import('../../../class/feature').ProjectType} ProjectType
 */

const NavProjectsProps = {
    /** @type {(project: ProjectType) => void|undefined} */
    onProjectClick: (project) => {}
};


function NavProjects(props = NavProjectsProps) {
    const { onProjectClick } = props;

    /** @param {ProjectType} context */
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

    return (<>{user.projects.map(ProjectButton)}</>);
}

export default NavProjects;