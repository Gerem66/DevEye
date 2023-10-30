/**
 * @typedef {import('./feature').FeatureType} FeatureType
 * @typedef {import('./feature').Context} Context
 * 
 * @typedef UserType
 * @property {number} ID
 * @property {string} Email
 * @property {string} Username
 * @property {string} Password
 * @property {string} Avatar
 * @property {string[]} Settings
 * @property {number} Security
 * @property {number} Created
 * @property {Context[]} Contexts
 */

const LOCAL_KEYS = {
    user: 'data/user'
};

class User {
    ID = 0;
    Email = '';
    Username = '';
    Password = '';
    Avatar = '';
    Settings = [];
    Security = 0;
    Created = 0;

    /** @type {Context[]} */
    Contexts = [];

    Save() {
        const data = this.GetData();
        localStorage.setItem(LOCAL_KEYS.user, data);
    }
    Load() {
        const data = localStorage.getItem(LOCAL_KEYS.user);
        if (data !== null) {
            const parsed = JSON.parse(data);
            this.SetData(parsed);
            return true;
        }
        return false;
    }
    Clear() {
        localStorage.removeItem(LOCAL_KEYS.user);
    }

    /**
     * Define user data & save in local storage
     * @param {UserType} data
     */
    SetData(data) {
        this.ID = data.ID;
        this.Email = data.Email;
        this.Username = data.Username;
        this.Password = data.Password;
        this.Avatar = data.Avatar;
        this.Settings = data.Settings;
        this.Security = data.Security;
        this.Created = data.Created;

        this.Contexts = [
            {
                id: 'self',
                name: this.Username,
                logo: this.Avatar,
                features: [
                    'dashboard',
                    'password'
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

        // Save
        this.Save();
    }

    GetData() {
        const data = {
            ID: this.ID,
            Email: this.Email,
            Username: this.Username,
            Password: this.Password,
            Avatar: this.Avatar,
            Settings: this.Settings,
            Security: this.Security,
            Created: this.Created,
            Contexts: this.Contexts
        };
        return JSON.stringify(data);
    }
}

const user = new User();

export { User };
export default user;