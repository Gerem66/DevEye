import React from 'react';

const NavProjectsProps = {
    /** @type {() => void} */
    onProjectClick: () => {}
};

class NavProjects extends React.Component {
    render() {
        return (
            <div>
                <button className='button' onClick={this.props.onProjectClick}>
                    <span className='icon icon-home' />
                    <span>Test 1</span>
                </button>
            </div>
        );
    }
}

NavProjects.prototype.props = NavProjectsProps;
NavProjects.defaultProps = NavProjectsProps;

export default NavProjects;