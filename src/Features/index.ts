import { RequestCommands } from 'deveye-types';
import { IFeature } from '@/Interfaces/IFeature';

// Authentification
import { Login } from '@/Features/Auth/login';

// Contexts
import { AddContext } from '@/Features/Contexts/add-context';
import { DeleteContext } from '@/Features/Contexts/delete-context';
import { SetFavorite } from '@/Features/Contexts/set-favorite-context';

// Passwords
import { AddPassword } from '@/Features/PasswordManager/add-password';
import { EditPassword } from '@/Features/PasswordManager/edit-password';
import { DeletePassword } from '@/Features/PasswordManager/delete-password';
import { GetPassword } from '@/Features/PasswordManager/get-password';
import { GetPasswords } from '@/Features/PasswordManager/get-passwords';
import { CheckPassword } from '@/Features/PasswordManager/check-password';

// GameLife
import { GetGameLifeData } from '@/Features/GameLife/gamelife-set-loop';

type FeaturesType = {
    [K in keyof RequestCommands]: IFeature<K>;
};

export const Features: FeaturesType = {
    // Authentification
    login: Login,

    // Contexts
    'add-context': AddContext,
    'delete-context': DeleteContext,
    'set-favorite-context': SetFavorite,

    // Passwords
    'add-password': AddPassword,
    'edit-password': EditPassword,
    'delete-password': DeletePassword,
    'get-password': GetPassword,
    'get-passwords': GetPasswords,
    'check-password': CheckPassword,

    // GameLife
    'gamelife-set-loop': GetGameLifeData
};
