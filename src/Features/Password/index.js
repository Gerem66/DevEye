import './style.css';

import { Header, Row, Card } from '../../Components';

/**
 * @typedef {import('Types/Feature').FeatureProps} FeatureProps
 */

/** @param {FeatureProps} props */
function FeaturePassword({ context, feature }) {
    return (
        <div className='profile'>
            <Header
                context={context}
                feature={feature}
            />

            <Row>
                <Card.Value
                    title='Nombre total de mot de passe'
                    value='0'
                    color='blue'
                    size='1/3'
                    icon='details'
                />
            </Row>

            <Row>
                <Card.Element size='1/2' color='blue-dark'>
                    <h2>{'Mot de passes'}</h2>
                    <div className='separator' />
                </Card.Element>

                <Card.Element size='1/2' color='blue-dark'>
                    <h2>News</h2>
                    <div className='separator' />
                </Card.Element>
            </Row>

        </div>
    );
}

export default FeaturePassword;
