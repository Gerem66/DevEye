/**
 * @typedef {import('./feature').FeatureType} FeatureType
 * @typedef {import('./feature').Context} Context
 */

class User {
    username = 'Gerem';
    avatar = 'gerem.png';
    email = 'test@mail.fr';

    /** @type {Context[]} */
    contexts = [
        {
            id: 'self',
            name: this.username,
            logo: this.avatar,
            features: [
                'dashboard'
            ]
        },
        {
            id: 'test',
            name: 'test',
            logo: 'default.png',
            features: [
                'dashboard'
            ]
        }
    ];
}

const user = new User();

export { User };
export default user;