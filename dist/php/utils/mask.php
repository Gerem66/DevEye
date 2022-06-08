<?php

    /**
     * @author BytePhunk bytephunk.wordpress.com, github.com/bytephunk
     * 
     * Basic websocket protocol frame encoding/decoding according to the rfc6455 specifications. 
     * Namely these functions encode/decode dataframes in use AFTER the protocol handshake. No protocol extensions included nor checkup for data integrity and protocol observance.
     * 
     * Documentation about protocol specifics can be found at https://tools.ietf.org/html/rfc6455
     */ 

    /**
     * Encoding of data according to rfc6455 specifications. 
     * 
     * @param string $payload 
     * @param int $opcode. Defaults to text payload.
     * @param bool $fin if the frame is final
     * @param bool $mask according to protocol rules the frame should be always unmasked when sent by the server. The function, however provides the capacity for masking frames.
     * @return string
     */
    function frameEncode($payload, $opcode = 1, $fin = true, $mask = false) {
        $first = 0;
        $first |= $fin ? 128 : 0; // Set final
        $first |= ($opcode & 15); // Restrain opcode to the first 4 bits anyway.
        $length = strlen($payload);

        $second = 0;
        $second |= $mask ? 128 : 0; // Set mask
        if ($length <= 125) {
            $headerLength = 2;
            $second |= $length;
        } else if ($length < (2**16)) { // Fits in 2 bytes
            $headerLength = 4;
            $second |= 126;
            $extraLength = pack("n", $length);
        } else {
            $headerLength = 10;
            $second |= 127;
            $extraLength = pack("J", $length);
        }
        $header = chr($first) . chr($second);
        $header .= $extraLength ?? ''; 

        if ($mask) {
            $maskBytes = openssl_random_pseudo_bytes(4);
            if(!$maskBytes) throw new Exception("Can't generate random mask");

            $header .= $maskBytes;
            $payloadArr = str_split($payload);
            $maskArr = str_split($maskBytes);

            for ($i = 0; $i < $length; $i++) {
                $m = $maskArr[$i % 4];
                $payloadArr[$i] ^= $m;
            }

            $payload = implode('', $payloadArr);
        }
        return $header.$payload;
    }

    /**
     * Decoding of data according to rfc6455 specifications.
     * @param string $frame The raw frame
     * @param array $frameArr Return array containing the frame data
     * @return string? The payload
     */
    function frameDecode($frame, &$frameArr) {
        $f = array_values(unpack("C*", $frame));

        if (count($f) < 2) {
            return null;
            throw new Exception("Invalid frame");
        }

        $fin = ($f[0] & 128) >> 7;
        $rsv1 = ($f[0] & 64) >> 6;
        $rsv2 = ($f[0] & 32) >> 5;
        $rsv3 = ($f[0] & 16) >> 4;
        $opcode = $f[0] & 15;

        $masked = ($f[1] & 128) >> 7;
        $length = $f[1] & 127;

        $offset = 2;
        $payload = '';
        if ($length == 126) {
            $length = unpack("n", substr($frame, $offset, 2))[1];
            $offset += 2;
        } else if ($length == 127) {
            $length = unpack("J", substr($frame, $offset, 8))[1];
            $offset += 8;
        }

        if ($masked) {
            $mask = substr($frame, $offset, 4);
            $offset += 4;
            $payload = substr($frame, $offset, $length);
            $payloadArr = str_split($payload);
            $maskArr = str_split($mask);
            for ($i = 0; $i < $length; $i++) {
                $m = $maskArr[$i % 4];
                $payloadArr[$i] ^= $m;
            }
            $payload=implode('', $payloadArr);
        } else {
            $payload = substr($frame, $offset, $length);
        }

        $frameArr = array(
            "fin" => $fin,
            "rsv1" => $rsv1,
            "rsv2" => $rsv2,
            "rsv3" => $rsv3,
            "opcode" => $opcode,
            "masked" => $masked,
            'offset' => $offset,
            "length" => $length,
            "payload" => $payload
        );
        return $payload;
    }

    function mask($text) {
        $b1 = 0x80 | (0x1 & 0x0f);
        $length = strlen($text);
        if($length <= 125) {
            $header = pack('CC', $b1, $length);
        } else if ($length > 125 && $length < 65536) {
            $header = pack('CCn', $b1, 126, $length);
        } else if ($length >= 65536) {
            // Does not support more than 2^7 bytes

            // Fix
            //$upper_32_bits = $length >> 32;
            //$lower_32_bits = $length & 0xffffffff;
            //$header = pack('CCNN', $b1, 127, $upper_32_bits, $lower_32_bits);

            $header = pack('CCNN', $b1, 127, $length);
        }
        return $header.$text;
    }

    function unmask($text) {
        $length = @ord($text[1]) & 127;
        if ($length <= 125) {
            $masks = substr($text, 2, 4);
            $data = substr($text, 6);
        } else if ($length === 126) {
            $masks = substr($text, 4, 4);
            $data = substr($text, 8);
        } else if ($length === 127) {
            $masks = substr($text, 10, 4);
            $data = substr($text, 14);
        }

        $text = "";
        for ($i = 0; $i < strlen($data); $i++) {
            $text .= $data[$i] ^ $masks[$i % 4];
        }
        return $text;
    }

    function error_handler($errno, $errtxt) {
        $useless = [ 'timed out', 'Interrupted system call' ];
        foreach ($useless as $useless_txt) {
            if (strpos($errtxt, $useless_txt) !== false) {
                return;
            }
        }
        print_r($errtxt);
        echo("\n");
    }

?>