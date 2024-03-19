import './style.css';

import { Header, Row, Card } from '../../components/components';

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
                <Card.Value
                    title='Nombre total de projets'
                    value='0'
                    color='blue'
                    size='1/3'
                    icon='details'
                />

                <Card.Value
                    title='Tâches en cours'
                    value='0'
                    color='green'
                    size='1/3'
                    icon='sandbox'
                />

                <Card.Value
                    title='Mails non lus'
                    value='0'
                    color='yellow'
                    size='1/3'
                    icon='mail'
                />
            </Row>

            <Row>
                <Card.Element size='1/2' color='blue-dark'>
                    <h2>Profil</h2>
                    <div className='separator' />

                    <button onClick={() => setUser(null)}>
                        Disconnect
                    </button>
                </Card.Element>

                <Card.Element size='1/2' color='blue-dark'>
                    <h2>News</h2>
                    <div className='separator' />
                </Card.Element>
            </Row>

        </div>
    );
}

export default FeatureProfile;
