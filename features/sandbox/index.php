<?php

    /**
     * @var User $user
     * @var DataBase $db
     */

    /**
     * Function called to perform server side operations\
     * once the page is loaded (often user actions)
     * @param DataBase $db
     * @param User $user
     * @param string $type
     * @param array $args
     * @return array Array returned to the client
     */
    $action = function($db, $user, $type, $args) {
        $output = array(
            'status' => 'error',
            'result' => 'empty'
        );

        if ($type === 'php') {
            $code = $args['code'];

            if ($user->Level >= 2) {
                $result = null;
                try {
                    $result = eval($code);
                    if ($result === null) {
                        $output['result'] = 'Failed to execute the code';
                    } else {
                        $output['result'] = $result;
                        $output['status'] = 'ok';
                    }
                } catch (ParseError $e) {
                    $output['result'] = $e->getMessage();
                } catch (Exception $e) {
                    $output['result'] = $e->getMessage();
                }
            } else {
                // TODO - Add cheat suspicion
            }
        }

        return $output;
    };

    $variables = array(
        'username' => $user->Username
    );
    return ImportHTML(__DIR__.'/index.html', $variables);

?>