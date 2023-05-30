<?php

    // Table: Contexts

    class Context {
        /** @var int $ID */
        public $ID;

        /** @var string $Name */
        public $Name;

        /** @var int[] */
        public $UsersID;

        /** @var string[] */
        public $EnabledFeatures;

        /** @var int $Created */
        public $Created;

        /**
         * @param array $context Contains all context information
         * @param array $contextRoles The context's roles
         * @throws Exception If the context contains incorrect data
         */
        public function __construct($context, $contextRoles) {
            if ($context === null || !$this->isValid($context)) {
                throw(new Exception('Invalid context'));
            }
            $this->ID = intval($context['ID']);
            $this->Name = $context['Name'];
            $this->UsersID = json_decode($context['UsersID'], true);
            $this->EnabledFeatures = json_decode($context['EnabledFeatures'], true);
            $this->Created = strtotime($context['Created']);
        }

        /**
         * @param array $context Contains all context information
         * @param array $contextRoles The context's roles
         * @return Context|null Returns the context if it contains correct data, null otherwise
         */
        public static function Load($context, $contextRoles) {
            try { return new Context($context, $contextRoles); }
            catch (Exception $e) { return null; }
        }

        /**
         * @param array $arr Contains all context information
         * @return bool True if the context contains correct data, false otherwise
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