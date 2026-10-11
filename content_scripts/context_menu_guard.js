(function() {
    if (window.__addSubtitlesContextMenuGuardInstalled) {
        return;
    }

    window.__addSubtitlesContextMenuGuardInstalled = true;

    window.addEventListener('contextmenu', function(event) {
        event.stopImmediatePropagation();
    }, true);
})();