import React from 'react';

import './style.css';

const HomeProps = {
    disconnect: () => {}
};

class HomePage extends React.Component {
    render() {
        return (
            <div id='home' className='home'>
                <span
                    style={{ color: 'red' }}
                    onClick={this.props.disconnect}
                >
                    Home
                </span>
            </div>
        );
    }
}

HomePage.propTypes = HomeProps;
HomePage.defaultProps = HomeProps;

export default HomePage;