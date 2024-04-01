import './style.css';

import { Header, Row, Card, Popup, Button } from '../../Components';
import { ChangeImage, EditPassword } from './actions';

/**
 * @typedef {import('Types/Feature').FeatureProps} FeatureProps
 */

/** @param {FeatureProps} props */
function FeatureProfile({ user, setUser, context, feature }) {
    /** @type {(time: number) => string} */
    const convertDate = (time) => new Date(time * 1000)
        .toLocaleDateString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        })
        .split(' ')
        .map((word) => word.length <= 1 ? word : word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');

    const dateCreated = convertDate(user.Created);
    const dateLastLogin = !!user.LastLogin ? convertDate(user.LastLogin) : 'Première connexion';

    return (
        <div className='profile'>
            <Header
                context={context}
                feature={feature}
            />

            <Row style='center'>
                <Card.Element size='1/3' color='blue-dark'>
                    <div className='profile-header'>
                        <div className='profile-avatar' onClick={ChangeImage}>
                            <img
                                className='profile-avatar-logo'
                                src={'./images/' + context.logo}
                                alt={context.name}
                            />
                        </div>
                        <h2 className='profile-avatar-name'>{context.name}</h2>
                    </div>

                    <div className='separator' />
                    <div className='profile-info'>
                        <h3 className='profile-info-title'>Adresse e-mail</h3>
                        <p className='profile-info-text'>{user.Email}</p>
                    </div>

                    <div className='separator' />
                    <div className='profile-info'>
                        <h3 className='profile-info-title'>Nombre d'entreprises</h3>
                        <p className='profile-info-text'>{user.Contexts.length - 1}</p>
                    </div>

                    <div className='separator' />
                    <div className='profile-info'>
                        <h3 className='profile-info-title'>Mot de passe</h3>
                        <div className='profile-info-content'>
                            <Button className='profile-btn-edit' onClick={EditPassword}>
                                Modifier le mot de passe
                            </Button>
                        </div>
                    </div>

                    <div className='separator' />
                    <div className='profile-info'>
                        <h3 className='profile-info-title'>Dernière connexion</h3>
                        <p className='profile-info-text'>{dateLastLogin}</p>
                    </div>

                    <div className='separator' />
                    <div className='profile-info'>
                        <h3 className='profile-info-title'>Créé le</h3>
                        <p className='profile-info-text'>{dateCreated}</p>
                    </div>

                    <div className='separator' />
                    <Button className='profile-btn-disconnect' onClick={() => setUser(null)}>
                        Se déconnecter
                    </Button>
                </Card.Element>
            </Row>

            <Popup id='in-dev'>
                <h2>En développement</h2>
                <p>
                    Cette fonctionnalité est en cours de développement.
                    <br />
                    Elle sera bientôt disponible.
                </p>
            </Popup>
        </div>
    );
}

export default FeatureProfile;
