import { useContext } from 'react';

import './style.css';

import { GlobalContext } from '../../context';
import { Header, Row, Card } from '../../components/components';

/**
 * @typedef {import('Types/Context').ContextType} ContextType
 * @typedef {import('Types/Feature').FeatureType} FeatureType
 */

/**
 * @param {ContextType} context
 * @param {FeatureType} feature
 * @returns {JSX.Element}
 */
function FeatureProfile(context, feature) {
    return (
        <div className='profile'>
            <Header context={context} feature={feature} />

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

            {context.id === 'self' ? (
                <SelfProfile context={context} />
            ) : (
                <ContextProfile />
            )}

        </div>
    );
}

function SelfProfile({ context }) {
    const { setUser } = useContext(GlobalContext);

    return (
        <Row>
            <Card.Element size='1/2' color='blue-dark'>
                <h2>{context.id === 'self' ? 'Profil' : 'Settings'}</h2>
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
    );
}

function ContextProfile() {
    return (
        <>
        </>
    );
}

export default FeatureProfile;
