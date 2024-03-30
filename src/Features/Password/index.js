import styles from './style.module.css';

import FeaturePasswordBack from './back';
import PasswordRow from './passwordRow';
import LoadingTable from './loadingTable';
import { Header, Row, Card, Popup } from '../../Components';
import { OpenPopup, ClosePopup } from '../../Components/Popup';

class FeaturePassword extends FeaturePasswordBack {
    render() {
        const { context, feature } = this.props;
        const { search, categories } = this.state;

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
                            value={search}
                            onChange={this.onSearchChange}
                        />
                    </Card.Element>
                </Row>
    
                {Object.keys(categories).length === 0 && (
                    <>
                        <LoadingTable key={'loading-table-password-1'} />
                        <LoadingTable key={'loading-table-password-2'} />
                    </>
                )}
    
                {Object.keys(categories).map((category) => {
                    const passwords = categories[category];
                    if (passwords.length === 0) {
                        return null;
                    }
    
                    return (
                        <Row key={category} style='center'>
                            <Card.Element
                                title={`${category} (${passwords.length})`}
                                size='2/3'
                                color='blue-dark'
                                style={styles['password-container']}
                            >
                                <div className={styles['scroll-mode']}>
                                    <table className={`show-lines ${styles['scroll-mode']}`}>
                                        <thead>
                                            <tr>
                                                <th style={{ width: '20%' }}>Service</th>
                                                <th>Nom d'utilisateur / Email</th>
                                                <th style={{ width: '20%' }}>Mot de passe</th>
                                                <th style={{ width: '10%' }}>Status</th>
                                                <th style={{ width: '5%' }}></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {passwords.map((password) => (
                                                <PasswordRow
                                                    key={password.ID}
                                                    password={password}
                                                    callback={this.GetPassword}
                                                />
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </Card.Element>
                        </Row>
                    );
                })}
    
                <Popup id='popup-unlock' title='Déverrouiller'>
                    <p>
                        Pour accéder à vos mots de passe, veuillez entrer votre mot de passe principal.
                    </p>
    
                    <div className="form-group">
                        <input name="input-password" className="form-input" type="password" placeholder="Mot de passe principal" />
                        <button name="toggle" className="btn" data-input="input-password">
                            <i className="icon icon-eye-close"></i>
                        </button>
                    </div>
    
                    <div className="form-group float-center">
                        <button onClick={() => ClosePopup('popup-unlock')}>Fermer</button>
                        <button name="btn-back" className="btn">Retour</button>
                        <button name="btn-save" className="btn">Déverrouiller</button>
                    </div>
                </Popup>
    
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
}

export default FeaturePassword;
