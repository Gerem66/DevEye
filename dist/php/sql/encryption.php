<?php

    /**
     * @link https://stackoverflow.com/questions/6770370/aes-256-encryption-in-php
     */
    class Encryption {
        private $keyA;
        private $cipher_algo = 'AES-256-CTR';

        /**
         * @param string $key Key to use for encryption from config.php
         */
        public function __construct($key) {
            $this->keyA = $key;
        }

        public static function HashPassword($password) {
            return hash('sha512', $password);
        }

        /**
         * Encrypt with AES-256-CTR + HMAC-SHA-512
         * @param string $plaintext Your message
         * @param string $hashedPassword Used to calculating the MAC from his hash
         * @return string
         */
        public function Encrypt($plaintext, $hashedPassword)
        {
            $nonce = random_bytes(16);
            $ciphertext = openssl_encrypt(
                $plaintext,
                $this->cipher_algo,
                $this->keyA,
                OPENSSL_RAW_DATA,
                $nonce
            );
            $keyB = hash('ripemd128', $hashedPassword);
            $mac = hash_hmac('sha512', $nonce.$ciphertext, $keyB, true);
            return base64_encode($mac.$nonce.$ciphertext);
        }

        /**
         * Verify HMAC-SHA-512 then decrypt AES-256-CTR
         * @param string $message Encrypted message
         * @param string $hashedPassword Used to calculating the MAC from his hash
         * @return string|null
         */
        public function Decrypt($message, $hashedPassword) {
            $decoded = base64_decode($message);
            $mac = mb_substr($decoded, 0, 64, '8bit');
            $nonce = mb_substr($decoded, 64, 16, '8bit');
            $ciphertext = mb_substr($decoded, 80, null, '8bit');

            $keyB = hash('ripemd128', $hashedPassword);
            $calc = hash_hmac('sha512', $nonce.$ciphertext, $keyB, true);
            if (!hash_equals($calc, $mac)) {
                return null;
                throw new Exception('HMAC verification failed');
            }
            return openssl_decrypt(
                $ciphertext,
                $this->cipher_algo,
                $this->keyA,
                OPENSSL_RAW_DATA,
                $nonce
            );
        }
    }

?>