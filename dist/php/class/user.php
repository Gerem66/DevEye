<?php

    class User
    {
        /** @var int $ID */
        public $ID;

        /** @var string $Email */
        public $Email;

        /** @var string $Username */
        public $Username;

        /** @var string $Password */
        public $Password;

        /**
         * Variable used to store the user's salt.
         * This is'nt stored in the database. (define in the constructor)
         * @var string $hashedPassword
         */
        public $hashedPassword;

        /** @var string $Avatar */
        public $Avatar;

        /** @var int $Level */
        public $Level;

        /** @var array $Settings */
        public $Settings;

        /** @var string|null $TwoFactorAuth */
        public $TwoFactorAuth;

        /** @var int $Created */
        public $Created;

        /**
         * @param array $user Contains all user information
         * @param string $hashedPassword The user's hashed password
         * @throws Exception If the user contains incorrect data
         */
        public function __construct($user, $hashedPassword) {
            if ($user === null || !$this->isValid($user)) {
                throw(new Exception('Invalid user'));
            }
            $this->ID = intval($user['ID']);
            $this->Email = $user['Email'];
            $this->Username = $user['Username'];
            $this->Password = $user['Password'];
            $this->hashedPassword = $hashedPassword;
            $this->Avatar = $user['Avatar'];
            $this->Level = intval($user['Level']);
            $this->Settings = json_decode($user['Settings'], true);
            $this->TwoFactorAuth = $user['TwoFactorAuth'];
            $this->Created = strtotime($user['Created']);
        }

        /**
         * @param array $user Contains all user information
         * @return User|null Returns the user if it contains correct data, null otherwise
         */
        public static function Load($user, $hashedPassword) {
            try { return new User($user, $hashedPassword); }
            catch (Exception $e) { return null; }
        }

        /**
         * @param array $arr Contains all user information
         * @return bool True if the user contains correct data, false otherwise
         */
        private function isValid($arr) {
            if (!$arr) return false;
            $vars = array_keys(get_object_vars($this));
            foreach ($vars as $var) {
                // Exception for the hashedPassword variable
                if ($var === 'hashedPassword') continue;
                if (!array_key_exists($var, $arr)) {
                    return false;
                }
            }
            return true;
        }
    }

?>