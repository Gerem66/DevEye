import './style.css';

import { Header, Row, Card } from '../../Components';

/**
 * @typedef {import('Types/Feature').FeatureProps} FeatureProps
 */

/** @param {FeatureProps} props */
function FeatureProfile({ user, setUser, context, feature }) {
    return (
        <div className='profile'>
            <Header
                context={context}
                feature={feature}
            />

            <Row>
                <Card.Element size='1/2' color='blue-dark'>
                    <h2>Profil</h2>
                    <div className='separator' />

                    <button onClick={() => setUser(null)}>
                        Disconnect
                    </button>
                </Card.Element>
            </Row>

        </div>
    );
}

export default FeatureProfile;
