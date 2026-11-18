function shouldShowExternalSubtitles(isChecked, subtitleCount, hasVideo) {
    return Boolean(isChecked && subtitleCount > 0 && hasVideo);
}

function determineSubtitleRenderer(fullscreenElement, video) {
    if (!fullscreenElement) return "window-dom";
    if (fullscreenElement === video || fullscreenElement.tagName === "VIDEO") {
        return "text-track";
    }
    return "fullscreen-dom";
}

function getCueTimes(begin, end, offset) {
    const startTime = Math.max(0, begin + offset);
    const endTime = Math.max(0, end + offset);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) ||
        endTime <= startTime || endTime <= 0) {
        return null;
    }
    return { startTime, endTime };
}

function findReplacementVideo(currentVideo, videos, isVisible) {
    if (currentVideo && isVisible(currentVideo)) return null;
    const visibleVideos = videos.filter(isVisible);
    return visibleVideos.length === 1 ? visibleVideos[0] : null;
}

function getCueSyncError(subtitleCount, addedCount, failedCount, firstErrorMessage) {
    if (subtitleCount > 0 && addedCount === 0) {
        return failedCount > 0
            ? `${failedCount} subtitle cue(s) could not be added: ${firstErrorMessage}`
            : "no valid cue times after applying the time offset";
    }
    if (failedCount > 0) {
        return `${failedCount} subtitle cue(s) skipped; first error: ${firstErrorMessage}`;
    }
    return null;
}

module.exports = {
    shouldShowExternalSubtitles,
    determineSubtitleRenderer,
    getCueTimes,
    findReplacementVideo,
    getCueSyncError
};
