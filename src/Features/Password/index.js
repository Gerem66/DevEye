import styles from './style.module.css';

import { Header, Row, Card } from '../../Components';

/**
 * @typedef {import('Types/Feature').FeatureProps} FeatureProps
 */

/** @param {FeatureProps} props */
function FeaturePassword({ context, feature }) {
    return (
        <div className={styles.profile}>
            <Header
                context={context}
                feature={feature}
            />

            <Row style='center'>
                <Card.Element title='Rechercher (xxx)' style={styles['search-container']} color='blue-dark' size='1/3'>
                    <input
                        className='form-input'
                        type='text'
                        placeholder="Nom d'un service"
                    />
                </Card.Element>
            </Row>

            <Row style='center'>
                <Card.Element title='Catégorie (xx)' size='2/3' color='blue-dark'>
                    <div className={styles.separator} />
                </Card.Element>
            </Row>

        </div>
    );
}

export default FeaturePassword;
