import './style.css';

import { Header, Row, Card } from '../../Components';

/**
 * @typedef {import('Types/Feature').FeatureProps} FeatureProps
 */

/** @param {FeatureProps} props */
function FeatureDashboard({ user, setUser, context, feature }) {
    return (
        <div className='profile'>
            <Header
                context={context}
                feature={feature}
            />

            <Row>
                <Card.Value
                    title='Nombre total de projets'
                    value='0'
                    color='blue'
                    icon='details'
                />

                <Card.Value
                    title='Tâches en cours'
                    value='0'
                    color='green'
                    icon='sandbox'
                />

                <Card.Value
                    title='Mails non lus'
                    value='0'
                    color='yellow'
                    icon='mail'
                />
            </Row>

            <Row>
                <Card.Element color='blue-dark'>
                    <h2>Profil</h2>
                    <div className='separator' />

                    <button onClick={() => setUser(null)}>
                        Disconnect
                    </button>
                </Card.Element>

                <Card.Element color='blue-dark'>
                    <h2>News</h2>
                    <div className='separator' />
                </Card.Element>
            </Row>

        </div>
    );
}

export default FeatureDashboard;
