/**
 * @typedef {import('./feature').FeatureType} FeatureType
 * @typedef {import('./feature').ProjectContext} ProjectContext
 */

class User {
    username = 'Gerem';
    avatar = 'gerem.png';
    email = 'test@mail.fr';

    /** @type {ProjectContext[]} */
    projects = [
        {
            id: 'self',
            name: this.username,
            logo: this.avatar,
            features: [
                'profile'
            ]
        },
        {
            id: 'test',
            name: 'test',
            logo: 'default.png',
            features: [
                'profile'
            ]
        }
    ];
}

const user = new User();

export { User };
export default user;