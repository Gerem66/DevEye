import styles from './style.module.css';

import { Header, Row, Card, Popup } from '../../Components';
import { OpenPopup, ClosePopup } from '../../Components/Popup';
import PasswordRow from './passwordRow';

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
                    <a className={`link ${styles['add-password']}`} onClick={() => OpenPopup('popup-add-password')}>
                        Ajouter un mot de passe
                    </a>
                    <input
                        className='form-input'
                        type='text'
                        placeholder="Nom d'un service"
                    />
                </Card.Element>
            </Row>

            <Row style='center'>
                <Card.Element
                    title='Catégorie (xx)'
                    size='2/3'
                    color='blue-dark'
                    style={styles['password-container']}
                >
                    <div className={styles['scroll-mode']}>
                        <table className={`show-lines ${styles['scroll-mode']}`}>
                            <thead>
                                <tr>
                                    <th>Service</th>
                                    <th>Nom d'utilisateur / Email</th>
                                    <th>Mot de passe</th>
                                    <th>Status</th>
                                    <th></th>
                                </tr>
                            </thead>
                            <tbody>
                                <PasswordRow password={{
                                    ID: 2,
                                    category: 'Achats',
                                    service: 'AirBnB',
                                    email: 'Google',
                                    password: '',
                                    status: 'active',
                                }} />
                                <PasswordRow password={{
                                    ID: 1,
                                    category: 'Achats',
                                    service: 'Amazon',
                                    email: 'Google',
                                    password: '**********',
                                    status: 'active',
                                }} />
                                <PasswordRow password={{
                                    ID: 3,
                                    category: 'Achats',
                                    service: 'Banggood',
                                    email: 'Google',
                                    password: '**********',
                                    status: 'active',
                                }} />
                            </tbody>
                        </table>
                    </div>
                </Card.Element>
            </Row>

            <Popup id='popup-add-password' title='Ajouter un mot de passe'>
                <p>
                    Stocker un mot de passe est une bonne pratique pour protéger vos compte.
                    <br />
                    Les informations concernant les mots de passe sont chiffrées.
                </p>

                <input name="input-category" list="category" className="form-input" placeholder="Catégorie" />
                <datalist id="category"><option value="Achats">Achats</option><option value="Administratif">Administratif</option><option value="Antivirus / VPN">Antivirus / VPN</option><option value="Argent">Argent</option><option value="Autre">Autre</option><option value="Jeux">Jeux</option><option value="Local">Local</option><option value="Médias">Médias</option><option value="Perso">Perso</option><option value="Pro">Pro</option><option value="Réseaux sociaux">Réseaux sociaux</option><option value="Serveurs">Serveurs</option><option value="Services">Services</option></datalist>

                <div className="form-group">
                    <input name="input-service" className="form-input" type="text" placeholder="Service" />
                </div>

                <div className="form-group">
                    <input name="input-username" className="form-input" type="text" placeholder="Nom d'utilisateur / Email" />
                </div>

                <div className="form-group">
                    <input name="input-password" className="form-input" type="password" placeholder="Mot de passe" />
                    <button name="toggle" className="btn" data-input="input-password">
                        <i className="icon icon-eye-close"></i>
                    </button>
                </div>

                <select name="input-status" className="select-grey">
                    <option value="enable">Actif</option>
                    <option value="disable">Inactif</option>
                    <option value="none">Indéterminé</option>
                </select> 

                <div className="form-group float-center">
                    <button name="btn-back" className="btn">Retour</button>
                    <button name="btn-save" className="btn">Ajouter</button>
                </div>

                <button onClick={() => ClosePopup('popup-add-password')}>Fermer</button>
            </Popup>

        </div>
    );
}

export default FeaturePassword;
