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

        /** @var string $Avatar */
        public $Avatar;

        /** @var int $Created */
        public $Created;

        /**
         * @param array $user Contains all user information
         * @throws Exception If the user contains incorrect data
         */
        public function __construct($user) {
            if ($user === null || !$this->isValid($user)) {
                throw(new Exception('Invalid user'));
            }
            $this->ID = intval($user['ID']);
            $this->Email = $user['Email'];
            $this->Username = $user['Username'];
            $this->Password = $user['Password'];
            $this->Avatar = $user['Avatar'];
            $this->Created = strtotime($user['Created']);
        }

        /**
         * @param array $user Contains all user information
         * @return User|null Returns the user if it contains correct data, null otherwise
         */
        public static function Load($user) {
            try {
                $user = new User($user);
                return $user;
            } catch (Exception $e) {
                return null;
            }
        }

        /**
         * @param array $arr Contains all user information
         * @return bool True if the user contains correct data, false otherwise
         */
        private function isValid($arr) {
            $vars = array_keys(get_object_vars($this));
            foreach ($vars as $var) {
                if (!array_key_exists($var, $arr)) {
                    return false;
                }
            }
            return true;
        }
    }

?>