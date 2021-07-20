function Switch(element) {
    let el_switch = element.getElementsByTagName('div')[0];
    el_switch.classList.toggle('active');

    let bt_save = document.getElementById('bt-save-settings');
    bt_save.disabled = false;
}

function SaveSettings() {
    LoadPage('settings', {'save': GetSettingsBin()}, true);
}

function GetSettingsBin() {
    let output = 0;
    let settings = document.getElementsByName('setting');

    let all = true;
    for (let i = 0; i < settings.length; i++) {
        let setting = settings[i];
        if (setting.children[0].classList.contains('active')) {
            let index = parseInt(setting.id);
            output += 2 ** index;
        } else if (all) {
            all = false;
        }
    }

    return all ? '-1' : output;
}

function SelectNewIndex(disable = false) {
    let bt_save_dp = document.getElementById('bt-save-dp');
    bt_save_dp.disabled = disable;
}
function SaveDefaultPage() {
    SelectNewIndex(true);
    let d = document.getElementById('options_dp').value;
    LoadPage('settings', { 'save_dp' : d }, false, true);
}