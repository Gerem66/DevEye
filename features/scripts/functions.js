function SwitchPasswordVision(element) {
    let parent = element.parentNode.parentNode;
    let input = parent.getElementsByTagName('input')[0];
    let icon = element.getElementsByTagName('i')[0];
    let hidded = input.type == 'password';

    input.type = hidded ? 'text' : 'password';
    icon.classList.remove('fa-eye-slash');
    icon.classList.remove('fa-eye');
    icon.classList.add(hidded ? 'fa-eye' : 'fa-eye-slash')
}