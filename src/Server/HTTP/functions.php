<?php

/**
 * Generate a random token
 * @param int $length The length of the token
 * @return string The token
 */
function GenerateToken($length = 32) {
    $token = bin2hex(random_bytes($length));
    return $token;
}

?>
