function OpenChangepasswordPopup() {
    let popup = document.getElementById('popup-changepwd');
    popup.classList.add('active');

    let tb_password = document.getElementsByName('pwd')[0];
    let tb_new_password = document.getElementsByName('new-pwd')[0];
    let btn_save = document.getElementsByName('save')[0];
    let btn_back = document.getElementsByName('back')[0];
    tb_password.focus();

    function SavePassword() {
        btn_save.disabled = true;
        let password = tb_password.value;
        let new_password = tb_new_password.value;

        // Get quicklink
        let data = new FormData();
        data.append('changepassword', password);
        data.append('newpassword', new_password);
        params = { method: 'POST', body: data };
        fetch('./user', params)
            .then(function(res) { return res.text(); })
            .then(function(content) {
                if (content === "OK") {
                    tb_password.parentNode.parentNode.innerHTML = "<p>Mot de passe modifié avec succès !</p>";
                } else if (content == "WRONG") {
                    tb_password.parentNode.parentNode.innerHTML = "<p>Une erreur est survenue. (Wrong password)</p>";
                } else {
                    tb_password.parentNode.parentNode.innerHTML = "<p>Une erreur est survenue. (" + content + ")</p>";
                }
            })
            .catch(function(err) {
                tb_password.parentNode.parentNode.innerHTML = "<p>Une erreur est survenue. (" + err + ")</p>";
            })
            .finally(function() {
                btn_save.remove();
                tb_new_password.parentNode.parentNode.remove();
                btn_back.onclick = () => LoadPage('user');
                popup.onclick = (e) => { if (e.target === popup) LoadPage('user'); }
            });
    }

    btn_save.onclick = SavePassword;
    btn_back.onclick = () => popup.classList.remove('active');
    popup.onclick = (e) => { if (e.target === popup) popup.classList.remove('active'); }
}

function OpenQuicklinkPopup() {
    let popup = document.getElementById('popup-quicklink');
    popup.classList.add('active');

    let tb_password = document.getElementsByName('pwd')[1];
    let btn_save = document.getElementsByName('save')[1];
    let btn_back = document.getElementsByName('back')[1];
    tb_password.focus();

    function GetQuicklink() {
        btn_save.disabled = true;
        let password = tb_password.value;

        // Get quicklink
        let data = new FormData();
        data.append('quicklink', password);
        params = { method: 'POST', body: data };
        fetch('./user', params)
            .then(function(res) { return res.text(); })
            .then(function(content) {
                let lines = content.split("\n");
                btn_save.remove();
                if (lines[0] !== "OK") {
                    tb_password.parentNode.parentNode.innerHTML = "<p>Une erreur est survenue. (" + lines[1] + ")</p>";
                } else {
                    let quicklink = lines[1];
                    tb_password.parentNode.parentNode.innerHTML = "<p>Utilisez ce lien pour vous connecter rapidement\
                        (valable uniquement depuis l'adresse IP actuelle) : <br />\
                        <input class=\"form-control\" value=\"" + quicklink + "\" onclick=\"select();document.execCommand('copy');\" readonly></input></p>";
                }
            })
            .catch(function(err) {
                btn_save.remove();
                tb_password.parentNode.parentNode.innerHTML = "<p>Une erreur est survenue. (" + err + ")</p>";
            })
            .finally(function() {
                btn_back.onclick = () => LoadPage('user');
                popup.onclick = (e) => { if (e.target === popup) LoadPage('user'); }
            });
    }

    btn_save.onclick = GetQuicklink;
    btn_back.onclick = () => popup.classList.remove('active');
    popup.onclick = (e) => { if (e.target === popup) popup.classList.remove('active'); }
}