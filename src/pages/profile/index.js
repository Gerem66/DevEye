import React from 'react';

import './style.css';
import auth from '../../class/auth';

import { Header, Row, Card } from '../../components/components';

/**
 * @typedef {import('../../class/feature').Context} Context
 * @typedef {import('../../class/feature').FeatureType} FeatureType
 */

/**
 * @param {Context} context
 * @param {FeatureType} feature
 * @returns {JSX.Element}
 */
function FeatureProfile(context, feature) {
    return (
        <div>
            <Header
                title={context.name}
                context_name={context.name}
                feature_name={feature.id}
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

            <button
                onClick={auth.Logout}
            >
                Disconnect
            </button>
        </div>
    );
}

export default FeatureProfile;