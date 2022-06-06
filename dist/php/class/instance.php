<?php

    class Instance
    {
        /** @var int $ID */
        public $ID;

        /** @var string $Name */
        public $Name;

        /** @var string $Avatar */
        public $Avatar;

        /** @var array<int> $Roles */
        public $Roles;

        /** @var int $CreatedBy */
        public $CreatedBy;

        /** @var int $CreatedAt */
        public $CreatedAt;

        /**
         * @param array $instance Contains all instance information
         * @throws Exception If the instance contains incorrect data
         */
        public function __construct($instance) {
            if ($instance === null || !$this->isValid($instance)) {
                throw(new Exception('Invalid instance'));
            }
            $this->ID = intval($instance['ID']);
            $this->Name = $instance['Name'];
            $this->Avatar = $instance['Avatar'];
            $this->Roles = json_decode($instance['Roles'], true);
            $this->CreatedBy = intval($instance['CreatedBy']);
            $this->CreatedAt = strtotime($instance['CreatedAt']);
        }

        /**
         * @param array $instance Contains all instance information
         * @return Instance|null Returns the instance if it contains correct data, null otherwise
         */
        public static function Load($instance) {
            try { return new Instance($instance); }
            catch (Exception $e) { return null; }
        }

        /**
         * @param array $arr Contains all instance information
         * @return bool True if the instance contains correct data, false otherwise
         */
        private function isValid($arr) {
            if (!$arr) return false;
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