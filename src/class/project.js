/**
 * @typedef {Object} Feature
 * @property {string} id
 * @property {string} name
 * @property {string} icon
 * @property {JSX.Element} component
 */

/** @type {Object.<string, Feature[]>} */
const Features = {
    'personal': [
        {
            id: 'Profile',
            name: 'Profile',
            icon: 'user',
            component: null
        },
        {
            id: 'Database',
            name: 'Database',
            icon: 'database',
            component: null
        },
        {
            id: 'Bla',
            name: 'Bla',
            icon: 'user',
            component: null
        },
        {
            id: 'Bla2',
            name: 'Bla',
            icon: 'user',
            component: null
        }
    ],
    'Test': [
        {
            id: 'Test 1',
            name: 'Test 1',
            icon: 'user',
            component: null
        },
        {
            id: 'Test 2',
            name: 'Test 2',
            icon: 'user',
            component: null
        },
        {
            id: 'Test 3',
            name: 'Test 3',
            icon: 'user',
            component: null
        },
        {
            id: 'Test 4',
            name: 'Test 4',
            icon: 'user',
            component: null
        }
    ]
}

export default Features;