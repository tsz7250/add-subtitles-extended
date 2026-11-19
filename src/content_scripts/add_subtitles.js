import JSZip from 'jszip';
import { Archive } from 'libarchive.js';
import { Converter } from 'opencc-js/cn2t';
const {
    shouldShowExternalSubtitles,
    determineSubtitleRenderer,
    getCueTimes,
    findReplacementVideo,
    getCueSyncError,
    groupByEpisode,
    archivePathLabel,
    hasSubhdEpisodeLayer,
    subhdEpisodeSortKey,
    subhdTitleForQuery,
    subhdLabel,
    subhdCountText,
    subhdLanguageMatch,
    subhdLanguageLabel,
    getPagedResults,
    runArchiveSelection,
    buildPickerBaseSegments,
    getDownloadCacheKey,
    hasUsableSubtitleFormat,
    parseSubtitleColor,
    SUBTITLE_FORMATS
} = require('../subtitle_logic');
const { SUBHD_MIRRORS } = require('../subhd_config');
const {
    createSearchState,
    captureSearchView,
    restoreSearchView,
    resetSubhdState,
    isLanguageOnlyChange,
    findSearchCandidate
} = require('../search_state');

(function(){

if(window.has_run){
    const shadow_root = document.getElementById("shadow_host").shadowRoot;
    const menu = shadow_root.getElementById("addsubtitle_menu");
    menu.style.display = menu.style.display == "none" ? "inline-block" : "none";
    return;
}
else{
    if(document.getElementById("addsubtitle_menu") != null){
        document.getElementById("addsubtitle_menu").outerHTML = "";
        document.getElementById("subtitle_element").outerHTML = "";
    }
}
window.has_run = true;

// Global variable definitions - Remove duplicate declarations, these variables will be properly defined later

// Added: Performance optimization related variables
// subtitleCache will be defined later as a class
let isLargeFile = false;
const LARGE_FILE_THRESHOLD = 1024 * 1024; // 1MB
let loadingProgress = 0;

// Added: Error handling class
class SubtitleError extends Error {
    constructor(message, type = 'GENERAL', details = null) {
        super(message);
        this.name = 'SubtitleError';
        this.type = type;
        this.details = details;
    }
}

// Added: File validation class
class FileValidator {
    static SUPPORTED_FORMATS = SUBTITLE_FORMATS;
    static ARCHIVE_FORMATS = ['zip', '7z', 'rar'];
    static MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
    
    static validateFile(file) {
        const errors = [];
        
        if (!file) {
            throw new SubtitleError('No file selected', 'FILE_NOT_SELECTED');
        }
        
        // File size check
        if (file.size > this.MAX_FILE_SIZE) {
            throw new SubtitleError(
                `File too large (${Math.round(file.size / 1024 / 1024)}MB), maximum supported ${this.MAX_FILE_SIZE / 1024 / 1024}MB`,
                'FILE_TOO_LARGE'
            );
        }
        
        // File format check
        const extension = file.name.split('.').pop().toLowerCase();
        const isArchive = this.ARCHIVE_FORMATS.includes(extension);
        if (!this.SUPPORTED_FORMATS.includes(extension) && !isArchive) {
            throw new SubtitleError(
                `Unsupported file format: .${extension}. Supported formats: ${this.SUPPORTED_FORMATS.join(', ')}, ${this.ARCHIVE_FORMATS.join(', ')}`,
                'UNSUPPORTED_FORMAT'
            );
        }
        
        return {
            isLarge: file.size > LARGE_FILE_THRESHOLD,
            format: extension,
            isArchive: isArchive,
            size: file.size
        };
    }
    
    static validateContent(content, format) {
        if (!content || content.trim().length === 0) {
            throw new SubtitleError('Subtitle file content is empty', 'EMPTY_CONTENT');
        }
        
        // Format-specific validation
        switch(format) {
            case 'srt':
                if (!this.validateSRTFormat(content)) {
                    throw new SubtitleError('SRT format validation failed', 'INVALID_SRT_FORMAT');
                }
                break;
            case 'vtt':
                if (!content.includes('WEBVTT')) {
                    throw new SubtitleError('VTT format validation failed: missing WEBVTT identifier', 'INVALID_VTT_FORMAT');
                }
                break;
            case 'ass':
            case 'ssa':
                const lowerContent = content.toLowerCase();
                if (!lowerContent.includes('[events]') || !lowerContent.includes('[script info]')) {
                    throw new SubtitleError('ASS/SSA format validation failed: missing required sections', 'INVALID_ASS_FORMAT');
                }
                break;
        }
        
        return true;
    }
    
    static validateSRTFormat(content) {
        const blocks = content.trim().split(/\n\s*\n/);
        if (blocks.length === 0) return false;
        
        // Check at least one subtitle block format
        const firstBlock = blocks[0].trim().split('\n');
        if (firstBlock.length < 3) return false;
        
        // Check sequence number
        const sequenceNumber = parseInt(firstBlock[0]);
        if (isNaN(sequenceNumber)) return false;
        
        // Check time format - more flexible pattern to handle standard SRT format
        // Support formats like: 00:00:39,131 --> 00:00:40,299
        const timePattern = /^\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}$/;
        const hasValidTimeline = firstBlock.some(line => timePattern.test(line.trim()));
        return hasValidTimeline;
    }
}

// Added: Progress indicator class
class ProgressIndicator {
    constructor(container, blockTarget) {
        this.container = container;
        this.blockTarget = blockTarget || null;
        this.progressElement = null;
    }
    
    show(message = 'Loading...') {
        if (this.progressElement) {
            this.hide();
        }
        if (this.blockTarget) {
            this.blockTarget.inert = true;
            this.blockTarget.setAttribute('aria-busy', 'true');
        }
        
        this.progressElement = document.createElement('div');
        this.progressElement.className = 'loading-progress';
        
        // Create message element
        const messageDiv = document.createElement('div');
        messageDiv.className = 'loading-message';
        messageDiv.textContent = message;
        this.progressElement.appendChild(messageDiv);
        
        // Create progress bar container
        const loadingBar = document.createElement('div');
        loadingBar.className = 'loading-bar indeterminate';
        loadingBar.setAttribute('role', 'progressbar');
        loadingBar.setAttribute('aria-valuemin', '0');
        loadingBar.setAttribute('aria-valuemax', '100');
        loadingBar.setAttribute('aria-valuenow', '0');
        
        // Create progress bar fill element
        const loadingFill = document.createElement('div');
        loadingFill.className = 'loading-fill';
        loadingBar.appendChild(loadingFill);
        
        this.progressElement.appendChild(loadingBar);
        
        this.container.appendChild(this.progressElement);
    }
    
    updateProgress(percent, message) {
        if (!this.progressElement) return;
        
        const fill = this.progressElement.querySelector('.loading-fill');
        const bar = this.progressElement.querySelector('.loading-bar');
        const messageEl = this.progressElement.querySelector('.loading-message');
        const safePercent = Math.min(100, Math.max(0, percent));
        
        if (bar) bar.classList.remove('indeterminate');
        if (fill) fill.style.width = `${safePercent}%`;
        if (bar) bar.setAttribute('aria-valuenow', String(Math.round(safePercent)));
        if (message && messageEl) messageEl.textContent = `${message} · ${Math.round(safePercent)}%`;
    }
    
    hide() {
        if (this.blockTarget) {
            this.blockTarget.inert = false;
            this.blockTarget.removeAttribute('aria-busy');
        }
        if (this.progressElement) {
            this.progressElement.remove();
            this.progressElement = null;
        }
    }
}

const subtitle_element = document.createElement("div");
subtitle_element.id = "subtitle_element";
subtitle_element.style.pointerEvents = "none";
subtitle_element.style.textAlign = "center";
document.body.append(subtitle_element);

const shadow_host = document.createElement("div");
shadow_host.id = "shadow_host";
document.body.appendChild(shadow_host);
const shadow = shadow_host.attachShadow({mode: "open"});
const shadow_root = shadow_host.shadowRoot;

const menu = document.createElement("div");
menu.id = "addsubtitle_menu";

// Use DOM methods instead of innerHTML
const closeButton = document.createElement("button");
closeButton.id = "close_button";
closeButton.type = "button";
closeButton.setAttribute("aria-label", "Close subtitle controls");
// SVG Icon for close button
const closeSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
closeSvg.setAttribute("width", "24");
closeSvg.setAttribute("height", "24");
closeSvg.setAttribute("viewBox", "0 0 24 24");
closeSvg.setAttribute("fill", "none");
closeSvg.setAttribute("stroke", "currentColor");
closeSvg.setAttribute("stroke-width", "2");
closeSvg.setAttribute("stroke-linecap", "round");
closeSvg.setAttribute("stroke-linejoin", "round");

const line1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
line1.setAttribute("x1", "18");
line1.setAttribute("y1", "6");
line1.setAttribute("x2", "6");
line1.setAttribute("y2", "18");
closeSvg.appendChild(line1);

const line2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
line2.setAttribute("x1", "6");
line2.setAttribute("y1", "6");
line2.setAttribute("x2", "18");
line2.setAttribute("y2", "18");
closeSvg.appendChild(line2);

closeButton.appendChild(closeSvg);
menu.appendChild(closeButton);

// Tab bar + pages
const tab_pages = {};
const tab_buttons = {};
function activate_tab(name){
    for (const key in tab_pages) {
        tab_pages[key].style.display = key === name ? "block" : "none";
        tab_buttons[key].classList.toggle("active", key === name);
        tab_buttons[key].setAttribute("aria-selected", key === name ? "true" : "false");
        tab_buttons[key].tabIndex = key === name ? 0 : -1;
    }
    requestAnimationFrame(sync_tab_heights);
}
const tab_bar = document.createElement("div");
tab_bar.id = "tab_bar";
tab_bar.setAttribute("role", "tablist");
tab_bar.setAttribute("aria-label", "Subtitle controls");
menu.appendChild(tab_bar);
[["main", "Load"], ["search", "Search"], ["settings", "Settings"]].forEach(function(pair){
    const btn = document.createElement("button");
    btn.type = "button";
    btn.id = "tab_" + pair[0];
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-controls", "page_" + pair[0]);
    btn.textContent = pair[1];
    btn.addEventListener("click", function(){ activate_tab(pair[0]); });
    tab_buttons[pair[0]] = btn;
    tab_bar.appendChild(btn);

    const page = document.createElement("div");
    page.className = "tab_page";
    page.id = "page_" + pair[0];
    page.setAttribute("role", "tabpanel");
    page.setAttribute("aria-labelledby", btn.id);
    tab_pages[pair[0]] = page;
    menu.appendChild(page);
});
tab_bar.addEventListener("keydown", function(event){
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const names = Object.keys(tab_buttons);
    const current = names.findIndex(name => tab_buttons[name] === shadow_root.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = names[(current + step + names.length) % names.length];
    activate_tab(next);
    tab_buttons[next].focus();
});
activate_tab("main");

const tab_page_main = tab_pages.main;
const tab_page_search = tab_pages.search;
const tab_page_settings = tab_pages.settings;

// the Search page owns the leftover panel height; its list scrolls instead
tab_page_search.classList.add("search_page");

// Use the tallest non-search page for all tabs so switching never resizes the panel.
function sync_tab_heights(){
    const pages = Object.values(tab_pages);
    const visiblePage = pages.find(function(page){ return page.style.display !== "none"; });
    const pageWidth = visiblePage ? visiblePage.getBoundingClientRect().width : 0;
    let maxHeight = 0;

    pages.forEach(function(page){
        // [reason] search results stretch to fill the page; measuring their full
        // content would grow the panel instead of letting the list scroll
        if (page === tab_page_search) return;
        page.style.height = "";
        const hidden = page.style.display === "none";
        if (hidden) {
            page.style.display = "block";
            page.style.position = "absolute";
            page.style.visibility = "hidden";
            page.style.pointerEvents = "none";
            if (pageWidth > 0) page.style.width = pageWidth + "px";
        }
        maxHeight = Math.max(maxHeight, page.scrollHeight);
        if (hidden) {
            page.style.display = "none";
            page.style.position = "";
            page.style.visibility = "";
            page.style.pointerEvents = "";
            page.style.width = "";
        }
    });

    if (maxHeight > 0) {
        // [reason] keep the page inside the panel's max-height (80vh, cap 600px)
        // so the menu itself never scrolls and the Search header stays put
        // shortcut: mirrors #addsubtitle_menu's max-height; update both together
        const panelCap = Math.min(window.innerHeight * 0.8, 600) - (tab_bar.offsetHeight + 24);
        if (panelCap > 0) maxHeight = Math.min(maxHeight, panelCap);
        pages.forEach(function(page){
            page.style.height = Math.ceil(maxHeight) + "px";
        });
    }
}

const line = document.createElement("div");
line.className = "section_heading";

const videoHeading = document.createElement("h2");
videoHeading.textContent = "Video target";
line.appendChild(videoHeading);

const refreshButton = document.createElement("button");
refreshButton.id = "refresh_video_list";
refreshButton.textContent = "Refresh";
line.appendChild(refreshButton);

tab_page_main.appendChild(line);

const video_elements_list = document.createElement("div");
video_elements_list.id = "video_elements_list";
tab_page_main.appendChild(video_elements_list);

const subtitle_file_fieldset = document.createElement("fieldset");

// Create legend element
const legend = document.createElement("legend");
legend.textContent = "Subtitles file:";
subtitle_file_fieldset.appendChild(legend);

// Create first line: file upload
const uploadFileLine = document.createElement("div");
uploadFileLine.className = "field";

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".srt,.vtt,.ass,.ssa,.zip,.7z,.rar";
fileInput.id = "subtitle_file_input";
fileInput.autocomplete = "off";
const fileLabel = document.createElement("label");
fileLabel.htmlFor = fileInput.id;
fileLabel.textContent = `Subtitle file (${FileValidator.SUPPORTED_FORMATS.concat(FileValidator.ARCHIVE_FORMATS).join(', ').toUpperCase()})`;
uploadFileLine.appendChild(fileLabel);
uploadFileLine.appendChild(fileInput);

subtitle_file_fieldset.appendChild(uploadFileLine);

// Create second line: URL input
const urlLine = document.createElement("div");
urlLine.className = "field";

const urlInput = document.createElement("input");
urlInput.type = "text";
urlInput.id = "subtitle_url_input";
urlInput.autocomplete = "off";
urlInput.placeholder = "https://example.com/subtitles.srt";
const urlLabel = document.createElement("label");
urlLabel.htmlFor = urlInput.id;
urlLabel.textContent = "Or load from URL";
urlLine.appendChild(urlLabel);
urlLine.appendChild(urlInput);

subtitle_file_fieldset.appendChild(urlLine);

// Create third line: buttons and error messages
const buttonLine = document.createElement("div");
buttonLine.className = "line";

const uploadButton = document.createElement("button");
uploadButton.id = "subtitle_upload_button";
uploadButton.textContent = "Upload";
buttonLine.appendChild(uploadButton);

buttonLine.appendChild(document.createTextNode(" "));

const retryButton = document.createElement("button");
retryButton.id = "retry_button";
retryButton.style.display = "none";
retryButton.textContent = "Retry";
buttonLine.appendChild(retryButton);

buttonLine.appendChild(document.createTextNode(" "));

const goto_search_button = document.createElement("button");
goto_search_button.id = "goto_search";
goto_search_button.textContent = "Search online…";
goto_search_button.addEventListener("click", function(){ activate_tab("search"); });
buttonLine.appendChild(goto_search_button);

buttonLine.appendChild(document.createTextNode(" "));

const errorMessage = document.createElement("span");
errorMessage.id = "upload_error_message";
errorMessage.setAttribute("aria-live", "polite");
buttonLine.appendChild(errorMessage);

subtitle_file_fieldset.appendChild(buttonLine);

// Create progress container
const progressContainer = document.createElement("div");
progressContainer.id = "upload_progress_container";
subtitle_file_fieldset.appendChild(progressContainer);

tab_page_main.appendChild(subtitle_file_fieldset);

// ======= Online subtitle search (OpenSubtitles / assrt / SubHD) =======
const search_block = document.createElement("div");
search_block.id = "search_block";

// Detected name hint (from page title chain, filled later)
const search_hint = document.createElement("span");
search_hint.id = "search_hint";
search_hint.className = "detected_hint";
search_block.appendChild(search_hint);

// Search input line
const search_input_line = document.createElement("div");
search_input_line.className = "search_input_row";

const search_query_input = document.createElement("input");
search_query_input.type = "text";
search_query_input.id = "search_query_input";
search_query_input.autocomplete = "off";
search_query_input.placeholder = "Movie or release name";
search_query_input.setAttribute("aria-label", "Movie or release name");
search_input_line.appendChild(search_query_input);

const search_button = document.createElement("button");
search_button.id = "search_button";
search_button.textContent = "Search";
search_input_line.appendChild(search_button);
search_query_input.addEventListener("keydown", function(event){
    if (event.key !== "Enter") return;
    event.preventDefault();
    search_button.click();
});

search_block.appendChild(search_input_line);

// Provider + language line
const search_provider_line = document.createElement("div");
search_provider_line.className = "filter_row";

const search_provider = document.createElement("select");
search_provider.id = "search_provider";
const providerLabel = document.createElement("label");
providerLabel.htmlFor = search_provider.id;
providerLabel.textContent = "Provider";
search_provider_line.appendChild(providerLabel);
[
    ["opensubtitles", "OpenSubtitles"],
    ["assrt", "Shooter (assrt.net)"],
    ["subhd", "SubHD"]
].forEach(function(pair){
    const opt = document.createElement("option");
    opt.value = pair[0];
    opt.textContent = pair[1];
    search_provider.appendChild(opt);
});
search_provider_line.appendChild(search_provider);

const search_language = document.createElement("select");
search_language.id = "search_language";
const languageLabel = document.createElement("label");
languageLabel.htmlFor = search_language.id;
languageLabel.textContent = "Language";
search_provider_line.appendChild(languageLabel);
// per-provider options: only languages each provider can actually filter
const SEARCH_LANGS_ZH = [["all", "All"], ["en", "English"], ["zh-hans", "简体中文"], ["zh-hant", "繁體中文"]];
const SEARCH_LANGS = {
    opensubtitles: SEARCH_LANGS_ZH.concat([["ja", "Japanese"], ["ko", "Korean"], ["es", "Spanish"], ["fr", "French"], ["de", "German"], ["ru", "Russian"]]),
    subhd: SEARCH_LANGS_ZH,
    assrt: SEARCH_LANGS_ZH
};
function rebuild_search_language(){
    search_language.textContent = "";
    SEARCH_LANGS[search_provider.value].forEach(function(pair){
        const opt = document.createElement("option");
        opt.value = pair[0];
        opt.textContent = pair[1];
        search_language.appendChild(opt);
    });
}
search_language.title = "OpenSubtitles: API-side filter. SubHD/assrt: filters the returned list client-side.";
search_provider_line.appendChild(search_language);

search_block.appendChild(search_provider_line);

const search_key_hint = document.createElement("div");
search_key_hint.id = "search_key_hint";
search_key_hint.className = "inline_hint";
search_key_hint.hidden = true;
search_key_hint.setAttribute("aria-live", "polite");
const search_key_hint_text = document.createElement("span");
const search_key_settings_button = document.createElement("button");
search_key_settings_button.type = "button";
search_key_settings_button.textContent = "Open Settings";
search_key_hint.append(search_key_hint_text, search_key_settings_button);
search_block.appendChild(search_key_hint);

// Provider/title bar above the results (SubHD multi-title picker)
const search_results_nav = document.createElement("div");
search_results_nav.id = "search_results_nav";
search_results_nav.className = "subtitle_path";
search_block.appendChild(search_results_nav);

// Results list (scrollable)
const search_results = document.createElement("div");
search_results.id = "search_results";
search_block.appendChild(search_results);

// Page links for the result list
const search_pager = document.createElement("div");
search_pager.id = "search_pager";
search_block.appendChild(search_pager);

// Status message
const search_status_elem = document.createElement("span");
search_status_elem.id = "search_status";
search_status_elem.setAttribute("aria-live", "polite");
search_block.appendChild(search_status_elem);

// Progress overlay for the Search page (centered while a load runs)
const search_progress_container = document.createElement("div");
search_progress_container.id = "search_progress_container";

// API key settings (live in the Settings tab, no collapsible wrapper)
const os_key_line = document.createElement("div");
os_key_line.className = "field";
const os_api_key_input = document.createElement("input");
os_api_key_input.type = "password";
os_api_key_input.id = "os_api_key";
os_api_key_input.autocomplete = "off";
const osKeyLabel = document.createElement("label");
osKeyLabel.htmlFor = os_api_key_input.id;
osKeyLabel.textContent = "OpenSubtitles API key";
const os_key_input_row = document.createElement("div");
os_key_input_row.className = "secret_input_row";
const os_key_visibility_button = document.createElement("button");
os_key_visibility_button.type = "button";
os_key_visibility_button.className = "secret_visibility_button";
os_key_visibility_button.setAttribute("aria-label", "Show OpenSubtitles API key");
os_key_visibility_button.setAttribute("aria-pressed", "false");
os_key_input_row.append(os_api_key_input, os_key_visibility_button);
os_key_line.appendChild(osKeyLabel);
os_key_line.appendChild(os_key_input_row);
tab_page_settings.appendChild(os_key_line);

const assrt_key_line = document.createElement("div");
assrt_key_line.className = "field";
const assrt_token_input = document.createElement("input");
assrt_token_input.type = "password";
assrt_token_input.id = "assrt_token";
assrt_token_input.autocomplete = "off";
const assrtKeyLabel = document.createElement("label");
assrtKeyLabel.htmlFor = assrt_token_input.id;
assrtKeyLabel.textContent = "Shooter (assrt.net) token";
const assrt_key_input_row = document.createElement("div");
assrt_key_input_row.className = "secret_input_row";
const assrt_key_visibility_button = document.createElement("button");
assrt_key_visibility_button.type = "button";
assrt_key_visibility_button.className = "secret_visibility_button";
assrt_key_visibility_button.setAttribute("aria-label", "Show Shooter token");
assrt_key_visibility_button.setAttribute("aria-pressed", "false");
assrt_key_input_row.append(assrt_token_input, assrt_key_visibility_button);
assrt_key_line.appendChild(assrtKeyLabel);
assrt_key_line.appendChild(assrt_key_input_row);
tab_page_settings.appendChild(assrt_key_line);

function create_secret_visibility_icon(){
    const namespace = "http://www.w3.org/2000/svg";
    const icon = document.createElementNS(namespace, "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("focusable", "false");
    const eye = document.createElementNS(namespace, "path");
    eye.setAttribute("d", "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z");
    const pupil = document.createElementNS(namespace, "circle");
    pupil.setAttribute("cx", "12");
    pupil.setAttribute("cy", "12");
    pupil.setAttribute("r", "3");
    const slash = document.createElementNS(namespace, "path");
    slash.setAttribute("d", "M4 4 20 20");
    slash.classList.add("secret_visibility_slash");
    slash.style.display = "none";
    icon.append(eye, pupil, slash);
    return icon;
}

function bind_secret_visibility(input, button, label){
    const slash = button.appendChild(create_secret_visibility_icon())
        .querySelector(".secret_visibility_slash");
    button.title = "Show " + label;
    button.addEventListener("click", function(){
        const visible = input.type === "password";
        input.type = visible ? "text" : "password";
        const action = (visible ? "Hide " : "Show ") + label;
        slash.style.display = visible ? "" : "none";
        button.title = action;
        button.setAttribute("aria-label", action);
        button.setAttribute("aria-pressed", visible ? "true" : "false");
    });
}
bind_secret_visibility(os_api_key_input, os_key_visibility_button, "OpenSubtitles API key");
bind_secret_visibility(assrt_token_input, assrt_key_visibility_button, "Shooter token");

const keys_line = document.createElement("div");
keys_line.className = "line";
const save_keys_button = document.createElement("button");
save_keys_button.id = "save_keys";
save_keys_button.textContent = "Save keys";
keys_line.appendChild(save_keys_button);
const keys_status_elem = document.createElement("span");
keys_status_elem.id = "keys_status";
keys_line.appendChild(keys_status_elem);
tab_page_settings.appendChild(keys_line);

// Simplified-to-Traditional conversion toggle (persisted in chrome.storage.local)
const s2t_line = document.createElement("div");
s2t_line.className = "toggle_row";
var s2t_enabled_checkbox = document.createElement("input");
s2t_enabled_checkbox.type = "checkbox";
s2t_enabled_checkbox.id = "s2t_enabled";
s2t_enabled_checkbox.className = "switch";
s2t_enabled_checkbox.checked = true;
const s2tLabel = document.createElement("label");
s2tLabel.htmlFor = s2t_enabled_checkbox.id;
s2tLabel.textContent = "Convert Simplified Chinese to Traditional";
s2t_line.appendChild(s2tLabel);
s2t_line.appendChild(s2t_enabled_checkbox);
tab_page_settings.appendChild(s2t_line);

tab_page_search.appendChild(search_block);
tab_page_search.appendChild(search_progress_container);

// Create grid container for settings
const settingsGrid = document.createElement("div");
settingsGrid.id = "settings_grid";

var subtitle_offset_line = document.createElement("div");
subtitle_offset_line.className = "field grid-item";

var subtitle_offset_input = document.createElement("input");
subtitle_offset_input.type = "number";
subtitle_offset_input.step = "0.01";
subtitle_offset_input.id = "subtitle_offset_input";
subtitle_offset_input.value = "0";
const offsetLabel = document.createElement("label");
offsetLabel.htmlFor = subtitle_offset_input.id;
offsetLabel.textContent = "Time offset (seconds)";
subtitle_offset_line.appendChild(offsetLabel);
subtitle_offset_line.appendChild(subtitle_offset_input);

var position_offset_line = document.createElement("div");
position_offset_line.className = "field grid-item";

var subtitle_offset_top_input = document.createElement("input");
subtitle_offset_top_input.type = "number";
subtitle_offset_top_input.id = "subtitle_offset_top_input";
subtitle_offset_top_input.value = "-100";
const positionLabel = document.createElement("label");
positionLabel.htmlFor = subtitle_offset_top_input.id;
positionLabel.textContent = "Position offset (px)";
position_offset_line.appendChild(positionLabel);
position_offset_line.appendChild(subtitle_offset_top_input);

var subtitle_font_size_line = document.createElement("div");
subtitle_font_size_line.className = "field grid-item";

var subtitle_font_size_input = document.createElement("input");
subtitle_font_size_input.type = "number";
subtitle_font_size_input.id = "subtitle_font_size";
subtitle_font_size_input.value = "26";
const fontSizeLabel = document.createElement("label");
fontSizeLabel.htmlFor = subtitle_font_size_input.id;
fontSizeLabel.textContent = "Font size (px)";
subtitle_font_size_line.appendChild(fontSizeLabel);
subtitle_font_size_line.appendChild(subtitle_font_size_input);

var subtitle_font_line = document.createElement("div");
subtitle_font_line.className = "field grid-item";

var subtitle_font_input = document.createElement("select");
subtitle_font_input.id = "subtitle_font";
[
    ["system-ui, -apple-system, sans-serif", "System Sans"],
    ["Arial", "Arial"],
    ["serif", "Serif"],
    ["monospace", "Monospace"],
    ["custom", "Custom"]
].forEach(function(pair){
    const option = document.createElement("option");
    option.value = pair[0];
    option.textContent = pair[1];
    subtitle_font_input.appendChild(option);
});
subtitle_font_input.value = "Arial";
const fontLabel = document.createElement("label");
fontLabel.htmlFor = subtitle_font_input.id;
fontLabel.textContent = "Font";
subtitle_font_line.appendChild(fontLabel);
subtitle_font_line.appendChild(subtitle_font_input);

const custom_font_input = document.createElement("input");
custom_font_input.type = "text";
custom_font_input.id = "subtitle_custom_font";
custom_font_input.placeholder = "Installed font name";
custom_font_input.style.display = "none";
custom_font_input.setAttribute("aria-label", "Custom font name");
subtitle_font_line.appendChild(custom_font_input);

function create_color_field(id, labelText, initialValue){
    const field = document.createElement("div");
    field.className = "field color_field grid-item";
    const label = document.createElement("label");
    label.htmlFor = id + "_picker";
    label.textContent = labelText;
    field.appendChild(label);

    const controls = document.createElement("div");
    controls.className = "color_controls";
    const picker = document.createElement("input");
    picker.type = "color";
    picker.id = id + "_picker";
    const parsed = parseSubtitleColor(initialValue);
    picker.value = parsed.hex;
    controls.appendChild(picker);

    const alpha = document.createElement("input");
    alpha.type = "range";
    alpha.id = id + "_alpha";
    alpha.min = "0";
    alpha.max = "100";
    alpha.value = String(Math.round(parsed.alpha * 100));
    alpha.setAttribute("aria-label", labelText + " opacity");
    controls.appendChild(alpha);

    const alphaValue = document.createElement("output");
    alphaValue.htmlFor = alpha.id;
    alphaValue.textContent = alpha.value + "%";
    controls.appendChild(alphaValue);
    field.appendChild(controls);

    const details = document.createElement("details");
    details.className = "advanced_color";
    const summary = document.createElement("summary");
    summary.textContent = "Advanced color value";
    details.appendChild(summary);
    const text = document.createElement("input");
    text.type = "text";
    text.id = id;
    text.value = parsed.rgba;
    text.setAttribute("aria-describedby", id + "_error");
    details.appendChild(text);
    const error = document.createElement("span");
    error.id = id + "_error";
    error.className = "field_error";
    error.setAttribute("aria-live", "polite");
    details.appendChild(error);
    field.appendChild(details);
    return { field, picker, alpha, alphaValue, text, error };
}

const fontColorControl = create_color_field("subtitle_font_color", "Text color", "rgba(255, 255, 255, 1)");
var subtitle_font_color_line = fontColorControl.field;
var subtitle_font_color_input = fontColorControl.text;

const backgroundColorControl = create_color_field("subtitle_background_color", "Background color", "rgba(0, 0, 0, 0.7)");
var subtitle_background_color_line = backgroundColorControl.field;
var subtitle_background_color_input = backgroundColorControl.text;

settingsGrid.appendChild(subtitle_offset_line);

tab_page_main.appendChild(settingsGrid);

// Show/hide the external subtitles (DOM overlay in windowed mode, TextTrack in fullscreen)
const showSubsLine = document.createElement("div");
showSubsLine.className = "toggle_row";
var showExternalCheckbox = document.createElement("input");
showExternalCheckbox.type = "checkbox";
showExternalCheckbox.id = "show_external_subtitles";
showExternalCheckbox.className = "switch";
showExternalCheckbox.checked = true;
const showSubsLabel = document.createElement("label");
showSubsLabel.htmlFor = showExternalCheckbox.id;
showSubsLabel.textContent = "Show external subtitles";
showSubsLine.appendChild(showSubsLabel);
showSubsLine.appendChild(showExternalCheckbox);
tab_page_main.appendChild(showSubsLine);
showExternalCheckbox.addEventListener("change", applySubtitleVisibility);

// Low-frequency appearance controls live in Settings so the Main tab stays compact
const appearanceFieldset = document.createElement("fieldset");
appearanceFieldset.id = "appearance_fieldset";
appearanceFieldset.className = "settings_group";
const appearanceLegend = document.createElement("legend");
appearanceLegend.appendChild(document.createTextNode("Subtitle appearance "));
const appearanceInfoBtn = document.createElement("button");
appearanceInfoBtn.id = "appearance_info_btn";
appearanceInfoBtn.type = "button";
appearanceInfoBtn.textContent = "i";
appearanceInfoBtn.setAttribute("aria-label", "About custom subtitle appearance");
appearanceLegend.appendChild(appearanceInfoBtn);
appearanceFieldset.appendChild(appearanceLegend);
const appearanceInfoPopover = document.createElement("div");
appearanceInfoPopover.id = "appearance_info_popover";
appearanceInfoPopover.textContent = "These settings apply in windowed playback and player-container fullscreen. When the video element itself enters fullscreen, the browser or system controls the subtitle appearance. The time offset and Simplified-to-Traditional conversion always apply.";
appearanceInfoPopover.style.display = "none";
appearanceFieldset.appendChild(appearanceInfoPopover);
const appearanceGrid = document.createElement("div");
appearanceGrid.id = "appearance_grid";
appearanceGrid.appendChild(position_offset_line);
appearanceGrid.appendChild(subtitle_font_size_line);
appearanceGrid.appendChild(subtitle_font_line);
appearanceGrid.appendChild(subtitle_font_color_line);
appearanceGrid.appendChild(subtitle_background_color_line);
appearanceFieldset.appendChild(appearanceGrid);
tab_page_settings.appendChild(appearanceFieldset);

function toggleAppearanceInfo(){
    appearanceInfoPopover.style.display =
        appearanceInfoPopover.style.display === "none" ? "block" : "none";
}
appearanceInfoBtn.addEventListener("click", function(e){
    e.stopPropagation();
    toggleAppearanceInfo();
});
document.addEventListener("click", function(){
    if (appearanceInfoPopover.style.display !== "none") {
        appearanceInfoPopover.style.display = "none";
    }
});

// The menu lives in a shadow root, so keyboard events retarget to #shadow_host and
// site players mistake them for page shortcuts (video controls instead of typing).
// Stop menu keyboard events in the capture phase so the site never sees them, while
// keeping normal text editing (no preventDefault).
["keydown", "keypress", "keyup"].forEach(function(type){
    window.addEventListener(type, function(e){
        if (typeof e.composedPath !== "function" ||
            e.composedPath().indexOf(menu) === -1) return;
        if (type === "keydown" && e.key === "Escape") {
            if (appearanceInfoPopover.style.display !== "none") {
                appearanceInfoPopover.style.display = "none";
            } else if (!resetConfirmation.hidden) {
                resetConfirmation.hidden = true;
            } else {
                const openDetails = menu.querySelector("details[open]");
                if (openDetails) openDetails.open = false;
                else menu.style.display = "none";
            }
            e.preventDefault();
        }
        e.stopImmediatePropagation();
    }, true);
});

// Add Simplified/Traditional Chinese conversion status display
var converter_status_line = document.createElement("div");
converter_status_line.className = "status_row";
converter_status_line.id = "converter_status_line";

var converter_status_span = document.createElement("span");
converter_status_span.id = "converter_status";
converter_status_span.textContent = "Initializing...";
converter_status_span.style.color = "#9a5b00";
converter_status_line.appendChild(converter_status_span);

// Add manual reload button
var reload_converter_button = document.createElement("button");
reload_converter_button.id = "reload_converter";
reload_converter_button.textContent = "Reload Converter";
converter_status_line.appendChild(reload_converter_button);

// Add donate button
var donate_button = document.createElement("button");
donate_button.id = "donate_button";
donate_button.textContent = "Donate";
donate_button.style.marginLeft = "auto";
donate_button.addEventListener("click", function() {
    window.open("https://github.com/sponsors/tsz7250", "_blank");
});
converter_status_line.appendChild(donate_button);

tab_page_settings.appendChild(converter_status_line);

function create_settings_group(title){
    const group = document.createElement("fieldset");
    group.className = "settings_group";
    const groupLegend = document.createElement("legend");
    groupLegend.textContent = title;
    group.appendChild(groupLegend);
    return group;
}

const videoSection = document.createElement("section");
videoSection.className = "panel_section";
videoSection.appendChild(line);
videoSection.appendChild(video_elements_list);

legend.textContent = "Load subtitles";
subtitle_file_fieldset.className = "panel_section";

const playbackSection = document.createElement("section");
playbackSection.className = "panel_section";
const playbackHeading = document.createElement("h2");
playbackHeading.textContent = "Playback";
playbackSection.appendChild(playbackHeading);
playbackSection.appendChild(settingsGrid);
playbackSection.appendChild(showSubsLine);
tab_page_main.replaceChildren(videoSection, subtitle_file_fieldset, playbackSection);

const resetAppearanceButton = document.createElement("button");
resetAppearanceButton.type = "button";
resetAppearanceButton.id = "reset_appearance";
resetAppearanceButton.className = "quiet_button";
resetAppearanceButton.textContent = "Reset to defaults";
appearanceFieldset.appendChild(resetAppearanceButton);

const resetConfirmation = document.createElement("div");
resetConfirmation.id = "reset_appearance_confirmation";
resetConfirmation.className = "inline_confirmation";
resetConfirmation.hidden = true;
const resetText = document.createElement("span");
resetText.textContent = "Reset all subtitle appearance settings?";
const cancelResetButton = document.createElement("button");
cancelResetButton.type = "button";
cancelResetButton.textContent = "Cancel";
const confirmResetButton = document.createElement("button");
confirmResetButton.type = "button";
confirmResetButton.className = "danger_button";
confirmResetButton.textContent = "Reset";
resetConfirmation.append(resetText, cancelResetButton, confirmResetButton);
appearanceFieldset.appendChild(resetConfirmation);

const conversionRow = document.createElement("div");
conversionRow.className = "conversion_row";
conversionRow.append(s2t_line, converter_status_line);

const servicesSection = create_settings_group("Subtitle services");
servicesSection.id = "subtitle_services";
keys_status_elem.setAttribute("aria-live", "polite");
const servicesKeys = document.createElement("div");
servicesKeys.className = "services_keys";
servicesKeys.append(os_key_line, assrt_key_line);
servicesSection.append(conversionRow, servicesKeys, keys_line);

const settingsFooter = document.createElement("div");
settingsFooter.className = "settings_footer";
settingsFooter.append(donate_button);

const settingsLayout = document.createElement("div");
settingsLayout.className = "settings_layout";
settingsLayout.append(appearanceFieldset, servicesSection, settingsFooter);

tab_page_settings.replaceChildren(settingsLayout);

shadow.appendChild(menu);

var style = document.createElement("style");
style.textContent = `
#addsubtitle_menu *{
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px;
    line-height: normal !important;
    box-sizing: border-box !important;
}

/* Added: Progress bar styles */
.loading-progress {
    margin-top: 10px;
    padding: 10px;
    background-color: #f0f0f0;
    border-radius: 5px;
    border: 1px solid #ccc;
}

.loading-message {
    font-size: 12px;
    color: #333;
    margin-bottom: 8px;
}

.loading-bar {
    width: 100%;
    height: 20px;
    background-color: #e0e0e0;
    border-radius: 10px;
    overflow: hidden;
    position: relative;
}

.loading-fill {
    height: 100%;
    background: linear-gradient(90deg, #4CAF50, #45a049);
    border-radius: 10px;
    transition: width 0.3s ease;
    position: relative;
}

.loading-fill::after {
    content: '';
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent);
    animation: loading-shimmer 1.5s infinite;
}

@keyframes loading-shimmer {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(100%); }
}

button {
    cursor: pointer;
    background-color: #f0f0f0;
    border: 1px solid #ccc;
    border-radius: 4px;
    color: #333;
    padding: 4px 8px;
    transition: all 0.2s ease;
}

button:hover {
    background-color: #e0e0e0;
    border-color: #bbb;
}

button:active {
    background-color: #d0d0d0;
    transform: translateY(1px);
}

.line {
    margin-top: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
}

#addsubtitle_menu {
    z-index: 1000000;
    position: fixed;
    right: 14px;
    bottom: 14px;
    width: 580px;
    max-height: min(80vh, 600px);
    overflow-y: auto;
    border: none;
    border-radius: 8px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    padding: 16px;
    background-color: white;
    color: #333;
    font-family: system-ui, -apple-system, sans-serif;
}

#settings_grid,
#appearance_grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 20px;
    margin-top: 12px;
}

.grid-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 0 !important;
    align-items: flex-start !important;
}

input[type="file"] {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    width: 100%;
    min-width: 0;
    padding: 4px 0;
}

input:not([type="file"]) {
    border: 1px solid #ccc;
    border-radius: 4px;
    height: 30px;
    width: 100%;
    padding: 0 8px;
    box-sizing: border-box !important;
}

input[type="checkbox"] {
    width: auto;
    height: auto;
    padding: 0;
    accent-color: #4CAF50;
}

/* Native checkbox kept for semantics; only the painted control becomes a switch */
input[type="checkbox"].switch {
    appearance: none;
    -webkit-appearance: none;
    position: relative;
    flex: 0 0 auto;
    width: 36px;
    height: 20px;
    padding: 0;
    margin: 0;
    border: 1px solid #bbb;
    border-radius: 999px;
    background-color: #ccc;
    cursor: pointer;
    transition: background-color 0.2s ease, border-color 0.2s ease;
}

input[type="checkbox"].switch::before {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background-color: #fff;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
    transition: transform 0.2s ease;
}

input[type="checkbox"].switch:checked {
    background-color: #4CAF50;
    border-color: #4CAF50;
}

input[type="checkbox"].switch:checked::before {
    transform: translateX(16px);
}

input[type="checkbox"].switch:focus-visible {
    outline: 2px solid #4CAF50;
    outline-offset: 2px;
}

#video_elements_list {
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid #eee;
    max-height: 200px;
    overflow-y: auto;
}

.video_list_item {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid transparent;
    border-radius: 4px;
    margin-top: 4px;
    padding: 6px 8px;
    cursor: pointer;
    background-color: #f9f9f9;
    transition: background-color 0.2s;
}

.video_list_item:hover {
    background-color: #eee;
}

/* sits inside .loading-progress, which already supplies padding and border */
.subtitle-chooser {
    margin-top: 0;
}

.subtitle-chooser-title {
    font-size: 12px;
    color: #333;
    margin-bottom: 8px;
    font-weight: bold;
}

.subtitle-chooser-list {
    max-height: 200px;
    overflow-y: auto;
}

.subtitle-chooser-row {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid transparent;
    border-radius: 4px;
    margin-top: 4px;
    padding: 6px 8px;
    cursor: pointer;
    background-color: #f9f9f9;
    transition: background-color 0.2s;
}

.subtitle-chooser-row:hover {
    background-color: #eee;
}

.subtitle-chooser-actions {
    margin-top: 10px;
    display: flex;
    gap: 8px;
}

#video_elements_list .selected_video_list {
    background-color: #e8f5e9;
    border: 1px solid #4CAF50;
    color: #2e7d32;
}

#video_elements_list .hover_video_list {
    border: 1px solid #2196F3;
}

#close_button {
    position: absolute;
    top: 16px;
    right: 16px;
    background: transparent;
    border: none;
    padding: 4px;
    color: #999;
    border-radius: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    width: auto;
    height: auto;
}

#close_button:hover {
    color: #333;
    background-color: #f0f0f0;
}

#no_videos {
    border: 1px dashed #ccc;
    border-radius: 4px;
    padding: 12px;
    color: #666;
    text-align: center;
    background-color: #fafafa;
}

#upload_error_message {
    color: #d32f2f;
    margin-top: 4px;
    flex: 1 1 0;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

#goto_search {
    white-space: nowrap;
    flex-shrink: 0;
}

fieldset {
    border: 1px solid #eee;
    border-radius: 6px;
    padding: 8px 12px;
    margin-top: 12px;
    min-inline-size: 0;
    min-width: 0;
}

legend {
    color: #555;
    font-weight: 600;
    padding: 0 4px;
}

#search_block {
    border: 1px solid #eee;
    border-radius: 6px;
    padding: 8px 12px;
    margin-top: 12px;
    position: relative;
    display: flex;
    flex-direction: column;
    height: calc(100% - 12px);
    min-height: 0;
}

/* centered progress overlay; the page itself stays visible but inert */
#search_progress_container {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgba(255, 255, 255, 0.78);
}

#search_progress_container:empty {
    display: none;
}

#search_progress_container .loading-progress {
    width: min(320px, 100%);
    margin: 0;
    box-shadow: 0 8px 22px rgba(16, 36, 25, 0.18);
}

#tab_bar {
    display: flex;
    gap: 2px;
    border-bottom: 1px solid #eee;
}

#tab_bar button {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    padding: 6px 12px;
    color: #666;
}

#tab_bar button:hover {
    background-color: #f5f5f5;
}

#tab_bar button.active {
    color: #333;
    font-weight: 600;
    border-bottom-color: #4CAF50;
}

.tab_page {
    margin-top: 12px;
    overflow-y: auto;
}

.tab_page.search_page {
    position: relative;
    overflow: hidden;
}

#appearance_fieldset {
    position: relative;
}

#appearance_info_btn {
    width: 18px;
    height: 18px;
    min-width: 18px;
    padding: 0;
    margin-left: 4px;
    border-radius: 50%;
    font-size: 11px;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: middle;
}

#appearance_info_popover {
    position: absolute;
    top: 24px;
    left: 8px;
    right: 8px;
    background-color: #fffbe6;
    border: 1px solid #e6d90a;
    border-radius: 6px;
    padding: 8px 10px;
    z-index: 10;
    color: #333;
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
}

#search_results {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    margin-top: 10px;
}

.search_result_item {
    overflow: hidden;
    border: 1px solid transparent;
    border-radius: 4px;
    margin-top: 4px;
    padding: 6px 8px;
    cursor: pointer;
    background-color: #f9f9f9;
    transition: background-color 0.2s;
}

.search_result_item:hover {
    background-color: #eee;
}

.search_result_item.selected_result {
    background-color: #e8f5e9;
    border-color: #4CAF50;
    color: #2e7d32;
}

.result_title_line {
    display: flex;
    align-items: center;
    gap: 6px;
}

.result_title_text {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.result_cached_icon {
    flex: 0 0 auto;
}

.result_meta {
    display: block;
    font-size: 11px;
    color: #888;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.search_result_item.selected_result .result_meta {
    color: #2e7d32;
}

.detected_hint {
    color: #999;
    font-size: 11px;
    display: block;
    margin-top: 4px;
}

#search_status {
    display: block;
    margin-top: 6px;
    flex: 0 0 auto;
}

#search_status:empty,
#search_pager:empty,
#search_results_nav:empty {
    display: none;
}

.search_empty_box {
    border: 1px dashed #ccc;
    border-radius: 4px;
    padding: 8px;
    color: #666;
    text-align: center;
    background-color: #fafafa;
}

#search_results_nav {
    margin-top: 8px;
    flex: 0 0 auto;
}

/* the Search page's lists take the leftover height; the results box scrolls */
.search_page .subtitle-chooser-list {
    max-height: none;
}

/* clickable path: search results and archive picker share these classes */
.subtitle_path {
    display: flex;
    align-items: baseline;
    font-size: 11px;
    min-width: 0;
}

/* [reason] truncate each segment instead of the whole row, so the level the user
   is on (last segment) is never the part that gets cut off */
.subtitle_path a,
.subtitle_path > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.subtitle_path a {
    color: #1976d2;
    text-decoration: none;
}

.subtitle_path a:hover {
    text-decoration: underline;
}

.subtitle_path .search_path_sep {
    color: #aaa;
    margin: 0 4px;
    flex-shrink: 0;
}

.subtitle_path .search_path_label {
    color: #666;
}

.subtitle_path .search_path_current {
    color: #333;
    font-weight: bold;
    flex-shrink: 0;
}

.subtitle-chooser .subtitle_path {
    margin-bottom: 6px;
}

#search_pager {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
    flex: 0 0 auto;
}

#search_pager button {
    min-width: 24px;
    padding: 2px 6px;
    font-size: 11px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background-color: #fff;
    cursor: pointer;
}

#search_pager button.active_page {
    background-color: #1976d2;
    border-color: #1976d2;
    color: #fff;
}

#search_pager button:disabled {
    opacity: 0.4;
    cursor: default;
}

/* Refined extension panel */
#addsubtitle_menu {
    --panel-canvas: #ffffff;
    --panel-surface: #f6f8f7;
    --panel-surface-strong: #edf3ef;
    --panel-border: #d5ddd8;
    --panel-text: #1d2923;
    --panel-muted: #52645a;
    --panel-accent: #18794e;
    --panel-accent-hover: #11663f;
    --panel-accent-soft: #e7f4ec;
    --panel-danger: #b42318;
    --panel-danger-soft: #fef3f2;
    --panel-warning: #9a5b00;
    --panel-focus: #146c43;
    right: 12px;
    bottom: 12px;
    box-sizing: border-box !important;
    width: min(580px, calc(100vw - 24px));
    max-height: min(80vh, 600px);
    overflow: hidden;
    border: 1px solid var(--panel-border);
    border-radius: 12px;
    box-shadow: 0 10px 30px rgba(16, 36, 25, 0.2);
    padding: 0 14px 12px;
    background: var(--panel-canvas);
    color: var(--panel-text);
}

#addsubtitle_menu *,
#addsubtitle_menu *::before,
#addsubtitle_menu *::after {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 12px;
    line-height: 1.35 !important;
}

#addsubtitle_menu ::selection {
    color: #fff;
    background: var(--panel-accent);
}

#addsubtitle_menu button:where(:not(.search_result_item, .subtitle-chooser-row)),
#addsubtitle_menu input,
#addsubtitle_menu select {
    color: var(--panel-text);
}

#addsubtitle_menu button:where(:not(.search_result_item, .subtitle-chooser-row)) {
    min-height: 30px;
    border-color: #b9c5be;
    border-radius: 6px;
    background: #fff;
    padding: 4px 10px;
    transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
}

#addsubtitle_menu button:where(:not(.search_result_item, .subtitle-chooser-row)):hover {
    border-color: #8da096;
    background: var(--panel-surface);
}

#addsubtitle_menu button:active {
    transform: none;
}

#addsubtitle_menu button:focus-visible,
#addsubtitle_menu input:focus-visible,
#addsubtitle_menu select:focus-visible,
#addsubtitle_menu summary:focus-visible,
#addsubtitle_menu [tabindex]:focus-visible {
    outline: 3px solid rgba(24, 121, 78, 0.28);
    outline-offset: 2px;
}

#addsubtitle_menu input:not([type="file"]):not([type="checkbox"]):not([type="color"]):not([type="range"]),
#addsubtitle_menu select {
    width: 100%;
    height: 28px;
    border: 1px solid #b9c5be;
    border-radius: 6px;
    background: #fff;
    padding: 0 8px;
}

#addsubtitle_menu input::placeholder {
    color: #667a6f;
    opacity: 1;
}

#tab_bar {
    position: relative;
    z-index: 2;
    min-height: 38px;
    align-items: end;
    gap: 4px;
    padding-right: 38px;
    background: var(--panel-canvas);
    border-bottom-color: var(--panel-border);
}

#tab_bar button {
    min-height: 34px;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    background: transparent;
    padding: 6px 10px;
    color: var(--panel-muted);
}

#tab_bar button:hover {
    background: var(--panel-surface);
}

#tab_bar button.active {
    color: var(--panel-accent);
    border-bottom-color: var(--panel-accent);
}

#close_button {
    z-index: 3;
    top: 3px;
    right: 10px;
    width: 32px;
    height: 32px;
    color: var(--panel-muted);
}

.tab_page {
    margin-top: 0;
    padding-top: 8px;
    overscroll-behavior: contain;
    scrollbar-color: #9aaba1 transparent;
    scrollbar-width: thin;
}

.panel_section,
.settings_group {
    margin: 0;
    padding: 0 0 8px;
    border: 0;
}

.panel_section + .panel_section,
.panel_section + fieldset.panel_section,
.settings_group + .settings_group {
    border-top: 1px solid var(--panel-border);
    padding-top: 8px;
}

.panel_section h2,
.section_heading h2,
.settings_group legend {
    margin: 0;
    padding: 0;
    color: var(--panel-text);
    font-size: 13px;
    font-weight: 700;
}

.section_heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 0;
}

.section_heading button {
    min-height: 26px;
    padding: 3px 8px;
}

.field {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 3px;
    min-width: 0;
    margin-top: 8px;
}

.field label,
.filter_row label {
    color: var(--panel-muted);
    font-size: 11px !important;
    font-weight: 600;
}

.toggle_row,
.status_row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
}

.toggle_row label {
    flex: 1 1 auto;
    font-weight: 600;
}

#settings_grid,
#appearance_grid {
    gap: 8px 12px;
    margin-top: 8px;
}

#video_elements_list {
    max-height: 116px;
    margin-top: 8px;
    padding-top: 0;
    border-top: 0;
}

.video_list_item,
.subtitle-chooser-row,
.search_result_item {
    width: 100%;
    min-height: 34px;
    margin-top: 4px;
    border: 1px solid transparent;
    border-radius: 7px;
    background: var(--panel-surface);
    color: var(--panel-text);
    padding: 5px 8px;
    text-align: left;
    transition: color 0.15s ease, background-color 0.15s ease, border-color 0.15s ease;
}

.video_list_item:hover,
.subtitle-chooser-row:hover,
.search_result_item:hover {
    border-color: #aebdb4;
    background: var(--panel-surface-strong);
}

#video_elements_list .selected_video_list,
.search_result_item.selected_result {
    border-color: var(--panel-accent);
    background: var(--panel-accent-soft);
    color: #0f5b39;
}

.video_item_title {
    display: block;
    font-weight: 650;
}

.video_item_meta,
.result_meta,
.detected_hint {
    display: block;
    color: var(--panel-muted);
    font-size: 11px !important;
}

fieldset.panel_section {
    min-inline-size: 0;
}

fieldset.panel_section > legend {
    padding: 0;
    color: var(--panel-text);
    font-weight: 700;
}

#subtitle_upload_button,
#search_button {
    border-color: var(--panel-accent);
    background: var(--panel-accent);
    color: #fff;
    font-weight: 650;
}

#subtitle_upload_button:hover,
#search_button:hover {
    border-color: var(--panel-accent-hover);
    background: var(--panel-accent-hover);
}

#upload_error_message,
.field_error {
    color: var(--panel-danger);
}

#upload_error_message {
    white-space: normal;
}

#upload_error_message.source_status {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

.field_error {
    min-height: 0;
    font-size: 12px !important;
}

.loading-progress {
    margin-top: 8px;
    padding: 8px;
    border-color: var(--panel-border);
    border-radius: 7px;
    background: var(--panel-surface);
}

.loading-message {
    color: var(--panel-text);
    font-size: 11px !important;
}

.loading-bar {
    height: 5px;
    border-radius: 999px;
    background: #dbe4de;
}

.loading-fill {
    width: 0;
    border-radius: 999px;
    background: var(--panel-accent);
    transition: width 0.2s ease;
}

.loading-fill::after {
    display: none;
}

/* unknown duration: slide a fixed fill instead of showing a frozen 0% bar */
.loading-bar.indeterminate .loading-fill {
    width: 40%;
    transition: none;
    animation: loading-indeterminate 1.2s ease-in-out infinite;
}

@keyframes loading-indeterminate {
    from { transform: translateX(-110%); }
    to { transform: translateX(260%); }
}

.search_input_row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 8px;
    margin-top: 8px;
}

.filter_row {
    display: grid;
    grid-template-columns: auto minmax(110px, 1fr) auto minmax(100px, 0.8fr);
    align-items: center;
    gap: 4px 8px;
    margin-top: 8px;
}

#search_block {
    height: calc(100% - 2px);
    margin-top: 0;
    border: 0;
    padding: 0;
}

#search_results {
    margin-top: 6px;
}

.result_title_text {
    font-weight: 650;
}

.result_badges {
    display: flex;
    flex: 0 0 auto;
    gap: 5px;
}

#search_pager {
    align-items: center;
    justify-content: center;
    gap: 8px;
}

#search_pager .page_status {
    color: var(--panel-muted);
    font-variant-numeric: tabular-nums;
    font-size: 11px !important;
}

#appearance_info_popover {
    top: 26px;
    border-color: #d9b35e;
    background: #fff8e8;
    color: #553600;
}

#appearance_info_btn {
    width: 20px;
    height: 20px;
    min-width: 20px;
    min-height: 20px !important;
    padding: 0;
}

.color_controls {
    display: grid;
    grid-template-columns: 36px minmax(70px, 1fr) 38px;
    align-items: center;
    gap: 6px;
}

#addsubtitle_menu input[type="color"] {
    width: 36px;
    height: 28px;
    border: 1px solid #b9c5be;
    border-radius: 6px;
    background: #fff;
    padding: 2px;
}

#addsubtitle_menu input[type="range"] {
    width: 100%;
    accent-color: var(--panel-accent);
}

.color_controls output {
    color: var(--panel-muted);
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-size: 11px !important;
}

.advanced_color {
    margin-top: 1px;
}

.advanced_color summary {
    color: var(--panel-muted);
    cursor: pointer;
    font-size: 11px !important;
}

.advanced_color input {
    margin-top: 4px;
}

.quiet_button {
    margin-top: 8px;
}

.inline_confirmation {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    border: 1px solid #f0b4ae;
    border-radius: 7px;
    background: var(--panel-danger-soft);
    padding: 6px 8px;
}

.inline_confirmation[hidden] {
    display: none;
}

.inline_confirmation span {
    flex: 1 1 auto;
}

.inline_hint {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
    border: 1px solid #d9b35e;
    border-radius: 7px;
    background: #fff8e8;
    color: #553600;
    padding: 6px 8px;
}

.inline_hint[hidden] {
    display: none;
}

.inline_hint span {
    flex: 1 1 auto;
}

.inline_hint button {
    flex: 0 0 auto;
}

.danger_button {
    border-color: var(--panel-danger) !important;
    background: var(--panel-danger) !important;
    color: #fff !important;
}

.settings_layout {
    display: flex;
    flex-direction: column;
    min-height: 100%;
}

#subtitle_services .line {
    margin-top: 8px;
}

.settings_footer {
    display: flex;
    justify-content: flex-end;
    margin-top: auto;
    padding-top: 8px;
}

#addsubtitle_menu #donate_button {
    flex: 0 0 auto;
    margin-left: 0 !important;
    border-color: #a86400;
    background: #b96f00;
    color: #fff;
    font-weight: 700;
}

#addsubtitle_menu #donate_button:hover {
    border-color: #8e5100;
    background: #965700;
}

#no_videos,
.search_empty_box {
    border-color: #aebdb4;
    border-radius: 7px;
    background: var(--panel-surface);
    color: var(--panel-muted);
    text-align: left;
}

#no_videos p {
    margin: 5px 0;
}

#no_videos ul {
    margin: 0;
    padding-left: 20px;
}

#no_videos li + li {
    margin-top: 4px;
}

#addsubtitle_menu input[type="checkbox"].switch {
    width: 36px;
    height: 20px;
    border-color: #8fa098;
    background: #a9b5ae;
}

#addsubtitle_menu input[type="checkbox"].switch::before {
    width: 14px;
    height: 14px;
}

#addsubtitle_menu input[type="checkbox"].switch:checked {
    border-color: var(--panel-accent);
    background: var(--panel-accent);
}

#addsubtitle_menu input[type="checkbox"].switch:checked::before {
    transform: translateX(16px);
}

#addsubtitle_menu input[type="checkbox"].switch:focus-visible {
    outline-color: rgba(24, 121, 78, 0.35);
}

.hover_video_element {
    outline: 3px solid #18794e !important;
    outline-offset: -3px !important;
}

/* three fields on the first row, the two color fields on the second */
#appearance_grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
}

#appearance_grid > :nth-child(-n+3) {
    grid-column: span 2;
}

#appearance_grid > :nth-child(n+4) {
    grid-column: span 3;
}

.conversion_row,
.services_keys {
    display: grid;
    gap: 6px 12px;
    margin-top: 6px;
}

.conversion_row {
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: 4px 8px;
}

.services_keys {
    grid-template-columns: 1fr 1fr;
}

.conversion_row .toggle_row,
.conversion_row .status_row,
.services_keys .field {
    margin-top: 0;
}

.secret_input_row {
    position: relative;
}

.secret_input_row input {
    padding-right: 36px !important;
}

#addsubtitle_menu .secret_visibility_button {
    position: absolute;
    top: 50%;
    right: 2px;
    display: grid;
    place-items: center;
    width: 28px;
    height: 26px;
    min-height: 0;
    border: 0;
    background: transparent;
    color: var(--panel-muted);
    padding: 4px;
    transform: translateY(-50%);
}

#addsubtitle_menu .secret_visibility_button:hover,
#addsubtitle_menu .secret_visibility_button:active {
    border: 0;
    background: transparent;
    color: var(--panel-text);
    transform: translateY(-50%);
}

#addsubtitle_menu .secret_visibility_button:focus-visible {
    outline: 2px solid var(--panel-accent);
    outline-offset: -2px;
}

#addsubtitle_menu .secret_visibility_button svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
}

.conversion_row .toggle_row label {
    flex: 0 0 auto;
}

.conversion_row .status_row {
    justify-content: flex-end;
    gap: 6px;
    white-space: nowrap;
}

.conversion_row .status_row button {
    min-height: 26px;
    padding: 2px 6px;
}

#keys_status {
    color: var(--panel-muted);
}

@media (max-width: 520px) {
    #addsubtitle_menu {
        right: 8px;
        bottom: 8px;
        width: calc(100vw - 16px);
        padding-right: 12px;
        padding-left: 12px;
    }

    #settings_grid,
    #appearance_grid,
    .services_keys {
        grid-template-columns: 1fr;
    }

    #appearance_grid > * {
        grid-column: auto;
    }

    .conversion_row {
        grid-template-columns: 1fr;
    }

    .conversion_row .status_row {
        justify-content: flex-start;
    }

    .filter_row {
        grid-template-columns: 1fr;
    }

    .filter_row label {
        margin-top: 4px;
    }

    .inline_confirmation {
        align-items: stretch;
        flex-direction: column;
    }
}

@media (prefers-reduced-motion: reduce) {
    #addsubtitle_menu *,
    #addsubtitle_menu *::before,
    #addsubtitle_menu *::after {
        scroll-behavior: auto !important;
        transition-duration: 0.01ms !important;
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
    }

    /* keep the loading bar visible without motion */
    #addsubtitle_menu .loading-bar.indeterminate .loading-fill {
        animation: none !important;
        transform: none;
        width: 35%;
    }
}
`;
shadow.appendChild(style);

// Style applied → measure Main page and equalize the other tabs
requestAnimationFrame(sync_tab_heights);

var globalStyle = document.createElement("style");
globalStyle.textContent = `
.hover_video_element{
    outline: 3px solid #18794e !important;
    outline-offset: -3px;
}
#subtitle_element{
    text-align: center;
    pointer-events: none;
}
.subtitle_line{
    display: inline-block;
    text-align: center;
    z-index: 99999;
}`;
document.getElementsByTagName("head")[0].appendChild(globalStyle);

function update_video_elements_list(){
    var video_elements = document.getElementsByTagName("video");
    var video_elements_list = shadow_root.getElementById("video_elements_list");
    // Clear video elements list
    while (video_elements_list.firstChild) {
        video_elements_list.removeChild(video_elements_list.firstChild);
    }
    if(video_elements.length == 0){
        // Use safer DOM method instead of innerHTML
        const noVideosDiv = document.createElement("div");
        noVideosDiv.id = "no_videos";
        const emptyTitle = document.createElement("strong");
        emptyTitle.textContent = "No video elements found.";
        const emptyHelp = document.createElement("p");
        emptyHelp.textContent = "The video may be inside a separate frame:";
        const emptySteps = document.createElement("ul");
        const firefoxStep = document.createElement("li");
        firefoxStep.textContent = "Firefox: Shift + right-click the video, then choose This Frame → Open Frame in New Tab.";
        const chromeStep = document.createElement("li");
        chromeStep.textContent = "Chrome: right-click the video, then choose Open This Frame in New Tab.";
        emptySteps.append(firefoxStep, chromeStep);
        noVideosDiv.append(emptyTitle, emptyHelp, emptySteps);
        
        video_elements_list.appendChild(noVideosDiv);
        sync_tab_heights();
        return;
    }
    for(var i = 0; i < video_elements.length; i++){
        var video_list_item = document.createElement("button");
        video_list_item.type = "button";
        video_list_item.className = "video_list_item";
        const source = video_elements[i].currentSrc || video_elements[i].src || "";
        let host = "Embedded media";
        try {
            if (source) host = new URL(source, location.href).hostname || "Embedded media";
        } catch (_error) {}
        const videoTitle = document.createElement("span");
        videoTitle.className = "video_item_title";
        videoTitle.textContent = "Video " + (i + 1);
        const videoMeta = document.createElement("span");
        videoMeta.className = "video_item_meta";
        const dimensions = video_elements[i].videoWidth && video_elements[i].videoHeight
            ? video_elements[i].videoWidth + " × " + video_elements[i].videoHeight
            : "Size not available";
        videoMeta.textContent = host + " · " + dimensions;
        video_list_item.title = source;
        video_list_item.append(videoTitle, videoMeta);
        (function(){
            var current_video_element = video_elements[i];
            video_list_item.addEventListener("mouseenter", function(){
                this.classList.add("hover_video_list");
                current_video_element.classList.add("hover_video_element");
            });
            video_list_item.addEventListener("mouseleave", function(){
                this.classList.remove("hover_video_list");
                current_video_element.classList.remove("hover_video_element");
            });
            video_list_item.addEventListener("click", function(){
                // a lone video must stay selected; there is nothing to switch to
                if (video_elements.length === 1 && the_video_element === current_video_element) return;
                const previousTrack = extTrack;
                var list = shadow_root.querySelectorAll(".video_list_item");
                for(var i = 0; i < list.length; i++){
                    list[i].classList.remove("selected_video_list");
                }
                if(the_video_element == current_video_element){
                    the_video_element = null;
                    // Clear subtitle content
                    while (subtitle_element.firstChild) {
                        subtitle_element.removeChild(subtitle_element.firstChild);
                    }
                }
                else{
                    the_video_element = current_video_element;
                    this.classList.add("selected_video_list");
                }
                if (previousTrack) previousTrack.mode = "disabled";
                extTrack = null;
                extTrackCuesDirty = true;
                applySubtitleVisibility();
            });
        }());
        if (the_video_element === video_elements[i]) {
            video_list_item.classList.add("selected_video_list");
        }
        video_elements_list.append(video_list_item);
    }
    if (video_elements.length === 1 && !the_video_element) {
        video_elements_list.firstElementChild.click();
    }
    sync_tab_heights();
}

// Improved: Use modern variable declaration and initialization
let subtitle_offset = parseFloat(shadow_root.getElementById("subtitle_offset_input").value);
let subtitle_offset_top = parseFloat(shadow_root.getElementById("subtitle_offset_top_input").value);

let subtitles = [];
let the_video_element = null;

let subtitle_font = shadow_root.getElementById("subtitle_font").value;
let subtitle_font_size = shadow_root.getElementById("subtitle_font_size").value;
let subtitle_font_color = shadow_root.getElementById("subtitle_font_color").value;
let subtitle_background_color = shadow_root.getElementById("subtitle_background_color").value;

// Added: Performance optimization - Subtitle cache management
class SubtitleCache {
    constructor(maxSize = 10) {
        this.cache = new Map();
        this.maxSize = maxSize;
        this.accessOrder = [];
    }
    
    set(key, value) {
        if (this.cache.has(key)) {
            // Update access order
            this.accessOrder = this.accessOrder.filter(k => k !== key);
        } else if (this.cache.size >= this.maxSize) {
            // Remove oldest item
            const oldest = this.accessOrder.shift();
            this.cache.delete(oldest);
        }
        
        this.cache.set(key, value);
        this.accessOrder.push(key);
    }
    
    get(key) {
        if (this.cache.has(key)) {
            // Update access order
            this.accessOrder = this.accessOrder.filter(k => k !== key);
            this.accessOrder.push(key);
            return this.cache.get(key);
        }
        return null;
    }
    
    has(key) {
        return this.cache.has(key);
    }
    
    clear() {
        this.cache.clear();
        this.accessOrder = [];
    }
}

const subtitleCache = new SubtitleCache();

// Added: Network request retry mechanism
class NetworkRetry {
    static async fetchWithRetry(url, options = {}, maxRetries = 3) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const response = await fetch(url, options);
                if (response.ok) {
                    return response;
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            } catch (error) {
                lastError = error;
                console.warn(`Request failed (attempt ${attempt}/${maxRetries}):`, error.message);
                
                if (attempt < maxRetries) {
                    // Exponential backoff strategy
                    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        
        throw new SubtitleError(
            `Network request failed after ${maxRetries} retries: ${lastError.message}`,
            'NETWORK_ERROR',
            { url, attempts: maxRetries, lastError }
        );
    }
}

// Chinese conversion system - OpenCC-JS bundled from npm
class ChineseConverter {
    constructor() {
        this.initialized = false;
        this.openccLoaded = false;
        this.converter = null;
        this.enabled = true;
        this.setupOpenCC();
    }

    setupOpenCC() {
        try {
            // Create Simplified to Traditional Chinese converter using correct API
            this.converter = Converter({ from: 'cn', to: 'tw' });
            // Test the converter
            const testResult = this.converter('测试');

            // Check if conversion is working
            this.openccLoaded = testResult !== '测试';

            this.initialized = true;
        } catch (error) {
            this.openccLoaded = false;
            this.initialized = true;
        }
    }
    
    convert(text) {
        if (!text) return text;
        
        // Skip conversion when the S2T toggle in Settings is off
        if (!this.enabled) return text;
        
        // Only convert when OpenCC is available, otherwise keep original text
        if (this.openccLoaded && this.converter) {
            try {
                return this.converter(text);
            } catch (error) {
                console.warn('OpenCC conversion failed, keeping original text:', error);
                return text;
            }
        }
        
        // Return original text directly when OpenCC is not available
        return text;
    }
    
    // Check converter status
    getStatus() {
        return {
            initialized: this.initialized,
            openccLoaded: this.openccLoaded,
            hasConverter: !!this.converter,
            enabled: this.enabled
        };
    }
}

// Create global converter instance
let chineseConverter = new ChineseConverter();



function xss(input){
    input = input.replace(/\&/g, "&amp;");
    input = input.replace(/\</g, "&lt;");
    input = input.replace(/\>/g, "&gt;");
    input = input.replace(/\"/g, "&quot;");
    input = input.replace(/\'/g, "&#x27;");
    input = input.replace(/\//g, "&#x2F;");
    return input;
}

function allow_tags(input, tags){
    // First perform Simplified-Traditional conversion, direct conversion without conditional judgment
    input = chineseConverter.convert(input);
    
    // Only process allowed tags, safer approach
    for(var i = 0; i < tags.length; i++){
        // Simple tags, like <b>
        var regex = new RegExp("&lt;"+tags[i]+"&gt;", "g");
        input = input.replace(regex, "<"+tags[i]+">");
        
        // End tags, like </b>
        regex = new RegExp("&lt;&#x2F;"+tags[i]+"&gt;", "g");
        input = input.replace(regex, "</"+tags[i]+">");
        
        // Tags with attributes handling - but we will ignore all attributes, only keep pure tags
        // For example <b style="..."> becomes <b>
        regex = new RegExp("&lt;"+tags[i]+"\\s+[^&]*&gt;", "g");
        input = input.replace(regex, "<"+tags[i]+">");
    }
    return input;
}

// Explicitly define allowed safe HTML tags
var allowed_html_tags = ["b", "i", "u", "br"];

setInterval(function(){
    if (!the_video_element) return;
    maybeRebindVideo();
    if (!the_video_element) return;
    reconcileFullscreenTrack();
    if (subtitle_element.style.display === "none") return;
    if(subtitles.length == 0) return;
    var t = the_video_element.currentTime;
    var active = [];
    for(var i = 0; i < subtitles.length; i++){
        if(subtitles[i].begin+subtitle_offset <= t && subtitles[i].end+subtitle_offset >= t){
            active.push(subtitles[i]);
        }
    }
    while (subtitle_element.firstChild) {
        subtitle_element.removeChild(subtitle_element.firstChild);
    }
    for(var i = 0; i < active.length; i++){
        for(var j = 0; j < active[i].text.length; j++){
            var subtitle_line = document.createElement("div");
            var sanitizedText = allow_tags(xss(active[i].text[j]), allowed_html_tags);
            var tempDiv = document.createElement("div");
            tempDiv.textContent = "";
            const parser = new DOMParser();
            const doc = parser.parseFromString("<div>" + sanitizedText + "</div>", "text/html");
            Array.from(doc.body.firstChild.childNodes).forEach(node => {
                tempDiv.appendChild(node.cloneNode(true));
            });
            while (tempDiv.firstChild) {
                subtitle_line.appendChild(tempDiv.firstChild);
            }
            subtitle_line.className = "subtitle_line";
            subtitle_line.style.cssText = "display:inline-block;text-align:center;font-family: "+subtitle_font+
                ";font-size: "+subtitle_font_size+
                "px;color:"+subtitle_font_color+
                ";background-color:"+subtitle_background_color+";";
            subtitle_element.appendChild(subtitle_line);
            subtitle_element.appendChild(document.createElement("br"));
        }
    }
    subtitle_pos();
}, 100);

// ======= External TextTrack bridge (site-native fullscreen) =======
// The site's own fullscreen puts the player in the browser top layer, where our
// DOM subtitle overlay cannot render. Cues on a TextTrack render together with
// the video, so the site's native control bar (quality, speed, audio) stays usable.
const EXT_TRACK_LABEL = "External Subtitles";
let extTrack = null; // TextTrack bound to the currently selected video
let extTrackCuesDirty = true;

function showTrackError(error){
    console.error("External TextTrack error:", error);
    if (errorMessage) {
        errorMessage.textContent = "Fullscreen subtitles unavailable: " + error.message;
        errorMessage.classList.remove("source_status");
        errorMessage.style.color = "#b42318";
        errorMessage.title = "";
    }
}

function ensureExternalTrack(){
    if (!the_video_element) return null;
    if (typeof the_video_element.addTextTrack !== "function") {
        showTrackError(new SubtitleError("selected video does not support TextTrack", "UNSUPPORTED_FORMAT"));
        return null;
    }
    if (extTrack && extTrack._boundVideo === the_video_element) return extTrack;
    // reuse an existing extension track on this video (TextTracks cannot be removed)
    for (let i = 0; i < the_video_element.textTracks.length; i++){
        const t = the_video_element.textTracks[i];
        if (t.label === EXT_TRACK_LABEL && t.kind === "subtitles") {
            extTrack = t;
            extTrack._boundVideo = the_video_element;
            extTrackCuesDirty = true;
            if (!t._extHooked) {
                t._extHooked = true;
                t.addEventListener("modechange", onExternalTrackModeChange);
            }
            return extTrack;
        }
    }
    try {
        extTrack = the_video_element.addTextTrack("subtitles", EXT_TRACK_LABEL, "");
        extTrack._boundVideo = the_video_element;
        extTrackCuesDirty = true;
        extTrack.mode = "disabled";
        extTrack._extHooked = true;
        extTrack.addEventListener("modechange", onExternalTrackModeChange);
    } catch (error) {
        showTrackError(error);
        extTrack = null;
    }
    return extTrack;
}

// Reuse the windowed sanitizer so S2T conversion and basic tags match both renderers
function buildCueText(textLines){
    return textLines.map(function(lineText){
        return allow_tags(xss(lineText), allowed_html_tags).replace(/<br\s*\/?>/gi, "\n");
    }).join("\n");
}

function syncExternalCues(track = extTrack){
    if (!track) return;
    try {
        if (typeof VTTCue !== "function") {
            throw new SubtitleError("this browser does not support VTTCue", "UNSUPPORTED_FORMAT");
        }
        if (track.mode === "disabled") track.mode = "hidden"; // cues are only readable then
        if (track.cues) {
            for (let i = track.cues.length - 1; i >= 0; i--) track.removeCue(track.cues[i]);
        }
        let added = 0;
        let failed = 0;
        let firstCueError = null;
        for (let i = 0; i < subtitles.length; i++){
            const sub = subtitles[i];
            const times = getCueTimes(sub.begin, sub.end, subtitle_offset);
            if (!times) continue;
            try {
                track.addCue(new VTTCue(times.startTime, times.endTime, buildCueText(sub.text)));
                added++;
            } catch (cueError) {
                failed++;
                if (!firstCueError) firstCueError = cueError;
            }
        }
        extTrackCuesDirty = false;
        const firstErrorMessage = firstCueError &&
            (firstCueError.message || String(firstCueError));
        const message = getCueSyncError(
            subtitles.length,
            added,
            failed,
            firstErrorMessage
        );
        if (message) {
            showTrackError(new SubtitleError(message, "PARSE_ERROR"));
        }
    } catch (error) {
        showTrackError(error);
    }
}

function getSubtitleRenderer(){
    return determineSubtitleRenderer(document.fullscreenElement, the_video_element);
}

function mountSubtitleElement(renderer){
    let parent = document.body;
    const fsEl = document.fullscreenElement;
    if (renderer === "fullscreen-dom" && fsEl &&
        fsEl !== document.documentElement && fsEl !== document.body) {
        parent = fsEl;
    }
    if (parent && subtitle_element.parentNode !== parent) {
        parent.appendChild(subtitle_element);
    }
}

function computeDesiredExternalMode(){
    const wantShown = shouldShowExternalSubtitles(
        showExternalCheckbox && showExternalCheckbox.checked,
        subtitles.length,
        the_video_element
    );
    if (!wantShown) return "disabled";
    return getSubtitleRenderer() === "text-track" ? "showing" : "hidden";
}

// Single source of truth: which renderer (DOM overlay vs TextTrack) is active
function applySubtitleVisibility(){
    const wantShown = shouldShowExternalSubtitles(
        showExternalCheckbox && showExternalCheckbox.checked,
        subtitles.length,
        the_video_element
    );
    const renderer = getSubtitleRenderer();
    const useDom = wantShown && renderer !== "text-track";

    mountSubtitleElement(renderer);

    let track = extTrack;
    if (wantShown && renderer === "text-track") {
        track = ensureExternalTrack();
        if (track && extTrackCuesDirty) syncExternalCues(track);
    }
    if (track) {
        const desired = computeDesiredExternalMode();
        track.mode = desired;
    }

    subtitle_element.style.display = useDom ? "" : "none";
    if (useDom) subtitle_pos();
}

function reconcileFullscreenTrack(){
    if (getSubtitleRenderer() !== "text-track" ||
        !showExternalCheckbox.checked || subtitles.length === 0) return;
    const track = ensureExternalTrack();
    if (track) {
        if (extTrackCuesDirty) syncExternalCues(track);
        if (track.mode !== "showing") track.mode = "showing";
    }
}

// The extension checkbox is authoritative; undo player-driven mode changes.
function onExternalTrackModeChange(event){
    if (!extTrack || event.currentTarget !== extTrack) return;
    if (extTrack.mode === computeDesiredExternalMode()) return; // echo of our own change
    requestAnimationFrame(applySubtitleVisibility);
}

// Auto-rebind when the site replaces the <video> element (e.g. quality switch);
// only when exactly one video is visible, otherwise the user reselects manually
function maybeRebindVideo(){
    if (!the_video_element) return;
    const isVisible = function(v){
        return v.isConnected && v.offsetWidth > 0 && v.offsetHeight > 0;
    };
    const replacement = findReplacementVideo(
        the_video_element,
        Array.from(document.getElementsByTagName("video")),
        isVisible
    );
    if (replacement) {
        const previousTrack = extTrack;
        extTrack = null;
        extTrackCuesDirty = true;
        if (previousTrack) previousTrack.mode = "disabled";
        the_video_element = replacement;
        applySubtitleVisibility();
    }
}

function onSubtitlesLoaded(){
    if (showExternalCheckbox) showExternalCheckbox.checked = true;
    extTrackCuesDirty = true;
    if (extTrack) syncExternalCues(extTrack);
    applySubtitleVisibility();
}

function get_offset(e){
    var top = 0;
    var left = 0;
    do {
        top += e.offsetTop || 0;
        left += e.offsetLeft || 0;
        e = e.offsetParent;
    } while(e);
    return [top, left];
}

function subtitle_pos(){
    if (!the_video_element) return;
    var subtitle_height = subtitle_element.getBoundingClientRect().height;
    const renderer = getSubtitleRenderer();
    const videoRect = the_video_element.getBoundingClientRect();
    const viewportMode = renderer === "fullscreen-dom" ||
        (renderer === "window-dom" &&
            videoRect.width >= window.innerWidth * 0.85 &&
            videoRect.height >= window.innerHeight * 0.75);

    if (viewportMode) {
        subtitle_element.style.position = "fixed";
        subtitle_element.style.width = videoRect.width+"px";
        subtitle_element.style.top = (videoRect.bottom+subtitle_offset_top-subtitle_height)+"px";
        subtitle_element.style.left = videoRect.left+"px";
        subtitle_element.style.zIndex = "2147483647";
        return;
    }

    var sub_pos_top = the_video_element.offsetHeight+get_offset(the_video_element)[0]+subtitle_offset_top-subtitle_height;
    var sub_pos_left = get_offset(the_video_element)[1];
    subtitle_element.style.position = "absolute";
    subtitle_element.style.width = the_video_element.offsetWidth+"px";
    subtitle_element.style.top = sub_pos_top+"px";
    subtitle_element.style.left = sub_pos_left+"px";
    subtitle_element.style.zIndex = "99999";
}

function time_parse(t){
    var split = t.split(":");
    var hours = split[0]*60*60;
    var minutes = split[1]*60;
    var seconds = parseFloat(t.split(":")[2].replace(",", "."));
    return hours+minutes+seconds;
}

function parse_ass_subtitles(subs) {
    const parsedSubtitles = [];
    
    // Split by lines
    var lines = subs.split(/\r?\n/);
    var inEvents = false;
    var dialogueFormat = [];
    
    // Iterate through each line
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        
        // Skip empty lines
        if (line === '') continue;
        
        // Check if entering [Events] section
        if (line === '[Events]') {
            inEvents = true;
            continue;
        }
        
        // If in [Events] section
        if (inEvents) {
            // Get format line
            if (line.startsWith('Format:')) {
                // Parse format definition
                var formatParts = line.substring(7).split(',').map(part => part.trim());
                dialogueFormat = formatParts;
                continue;
            }
            
            // Parse dialogue line
            if (line.startsWith('Dialogue:')) {
                var dialogueParts = [];
                var currentPart = '';
                var inQuotes = false;
                var braceLevel = 0;
                
                // Split dialogue line, handling text content that may contain commas
                for (var j = 10; j < line.length; j++) {
                    var char = line[j];
                    
                    // Handle brace nesting
                    if (char === '{') {
                        braceLevel++;
                        inQuotes = true;
                    } else if (char === '}' && braceLevel > 0) {
                        braceLevel--;
                        if (braceLevel === 0) {
                            inQuotes = false;
                        }
                    }
                    
                    // Only split when not in quotes and character is comma
                    if (char === ',' && !inQuotes) {
                        dialogueParts.push(currentPart);
                        currentPart = '';
                    } else {
                        currentPart += char;
                    }
                }
                // Add last part
                if (currentPart) {
                    dialogueParts.push(currentPart);
                }
                
                // Find Start, End and Text indices in format
                var startIdx = dialogueFormat.indexOf('Start');
                var endIdx = dialogueFormat.indexOf('End');
                var textIdx = dialogueFormat.indexOf('Text');
                
                if (startIdx !== -1 && endIdx !== -1 && textIdx !== -1 && dialogueParts.length > Math.max(startIdx, endIdx, textIdx)) {
                    // Get start time, end time and text
                    var startTime = dialogueParts[startIdx].trim();
                    var endTime = dialogueParts[endIdx].trim();
                    var text = dialogueParts[textIdx].trim();
                    
                    // Clean ASS specific format codes
                    text = cleanAssFormatting(text);
                    
                    // Handle line break symbols \N in ASS, convert to array items
                    var textLines = processAssLineBreaks(text);
                    
                    // Convert to seconds
                    var startSec = ass_time_parse(startTime);
                    var endSec = ass_time_parse(endTime);
                    
                    // Add to subtitle array
                    parsedSubtitles.push({
                        begin: startSec,
                        end: endSec,
                        text: textLines
                    });
                }
            }
        }
    }
    
    // Sort subtitles by time order
    parsedSubtitles.sort(function(a, b) {
        return a.begin - b.begin;
    });
    return parsedSubtitles;
}

// Clean ASS format markers
function cleanAssFormatting(text) {
    // Handle nested style markers
    // To handle possible complex situations, use temporary markers for replacement first
    
    // Handle bold
    text = text.replace(/{[^}]*\\b1[^}]*}/g, function(match) {
        return match.includes('\\b0') ? '' : '<b>';
    });
    text = text.replace(/{[^}]*\\b0[^}]*}/g, '</b>');
    
    // Handle italic
    text = text.replace(/{[^}]*\\i1[^}]*}/g, function(match) {
        return match.includes('\\i0') ? '' : '<i>';
    });
    text = text.replace(/{[^}]*\\i0[^}]*}/g, '</i>');
    
    // Handle underline
    text = text.replace(/{[^}]*\\u1[^}]*}/g, function(match) {
        return match.includes('\\u0') ? '' : '<u>';
    });
    text = text.replace(/{[^}]*\\u0[^}]*}/g, '</u>');
    
    // Handle some special ASS escape sequences
    text = text.replace(/\\h/g, ' '); // Hard space
    text = text.replace(/\\N|\\n/g, '\\N'); // Normalize line breaks
    
    // Handle special symbols in ASS
    text = text.replace(/\\s/g, ' '); // Space
    text = text.replace(/\\N/g, '\\N'); // Keep line breaks
    
    // Handle other possible escape characters and control sequences
    text = text.replace(/\\t\([^)]*\)/g, ''); // Remove transform effects
    text = text.replace(/\\[a-zA-Z]+\d*\([^)]*\)/g, ''); // Remove function styles
    text = text.replace(/\\[A-Za-z]\d+/g, ''); // Remove other control characters
    
    // Remove all remaining format markers
    text = text.replace(/{[^}]*}/g, '');
    
    // Perform Simplified-Traditional conversion on cleaned text, direct conversion without conditional judgment
    text = chineseConverter.convert(text);
    
    return text;
}

// Handle ASS line breaks
function processAssLineBreaks(text) {
    var textLines = [];
    
    // Normalize and split line breaks
    if (text.includes('\\N')) {
        var parts = text.split('\\N');
        for (var i = 0; i < parts.length; i++) {
            var line = parts[i].trim();
            if (line !== '') {
                textLines.push(line);
            }
        }
    } else {
        textLines.push(text);
    }
    
    // Ensure no empty lines
    textLines = textLines.filter(function(line) {
        return line.trim() !== '';
    });
    
    // If no valid lines, add a blank line
    if (textLines.length === 0) {
        textLines.push('');
    }
    
    return textLines;
}

// Parse ASS time format (h:mm:ss.cc) to seconds
function ass_time_parse(t) {
    var parts = t.split(':');
    if (parts.length < 3) {
        // Handle possible format issues, ensure at least three parts
        console.error("Invalid ASS time format:", t);
        return 0;
    }
    
    var hours = parseFloat(parts[0]) * 3600;
    var minutes = parseFloat(parts[1]) * 60;
    var seconds = 0;
    
    // Handle seconds and milliseconds part
    var secParts = parts[2].split('.');
    seconds = parseFloat(secParts[0]);
    if (secParts.length > 1) {
        // Convert decimal part to seconds decimal
        seconds += parseFloat('0.' + secParts[1]);
    }
    
    return hours + minutes + seconds;
}

// Improved: Modernized subtitle parsing function with enhanced error handling and validation
async function parse_subtitles(subs, format = 'auto') {
    try {
        // Clear existing subtitles
        subtitles.length = 0;
        
        // Check cache - use safe encoding for non-ASCII characters
        let cacheKey;
        try {
            cacheKey = encodeURIComponent(subs.substring(0, 1000)).substring(0, 100); // Use first 1000 characters as cache key, encoded safely
        } catch (error) {
            // Fallback: use a hash of the content length and first few ASCII characters
            cacheKey = 'fallback_' + subs.length + '_' + subs.substring(0, 50).replace(/[^\x00-\x7F]/g, "");
            console.warn('Cache key generation fallback used due to encoding issue:', error);
        }
        if (subtitleCache.has(cacheKey)) {
            const cached = subtitleCache.get(cacheKey);
            subtitles.push(...cached);
            onSubtitlesLoaded();
            console.log('Using cached subtitle data');
            return;
        }
        
        // Auto-detect format
        if (format === 'auto') {
            format = detectSubtitleFormat(subs);
        }
        
        // Validate content
        FileValidator.validateContent(subs, format);
        
        let parsedSubtitles = [];
        
        // Choose parser based on format
        switch(format) {
            case 'ass':
            case 'ssa':
                parsedSubtitles = await parseAssSubtitles(subs);
                break;
            case 'vtt':
                parsedSubtitles = await parseVttSubtitles(subs);
                break;
            case 'srt':
            default:
                parsedSubtitles = await parseSrtSubtitles(subs);
                break;
        }
        
        // Validate parsing results
        validateParsedSubtitles(parsedSubtitles);
        
        // Sort subtitles
        parsedSubtitles.sort((a, b) => a.begin - b.begin);
        
        // Store to global variable and cache
        subtitles.push(...parsedSubtitles);
        subtitleCache.set(cacheKey, parsedSubtitles);
        
        console.log(`Successfully parsed ${subtitles.length} subtitles (${format.toUpperCase()} format)`);
        onSubtitlesLoaded();
        
    } catch (error) {
        if (error instanceof SubtitleError) {
            throw error;
        }
        throw new SubtitleError(
            `Subtitle parsing failed: ${error.message}`,
            'PARSE_ERROR',
            { originalError: error }
        );
    }
}

// New: Format detection function
function detectSubtitleFormat(content) {
    const trimmed = content.trim();
    
    if (trimmed.includes('[Script Info]') && trimmed.includes('[Events]')) {
        return trimmed.includes('Format: Layer') ? 'ass' : 'ssa';
    }
    
    if (trimmed.startsWith('WEBVTT')) {
        return 'vtt';
    }
    
    // Check if it's SRT format (contains timestamp format)
    if (/^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/m.test(trimmed)) {
        return 'srt';
    }
    
    // Default to SRT
    return 'srt';
}

// Improved SRT parser
async function parseSrtSubtitles(subs) {
    const parsedSubtitles = [];
    subs = subs.replace(/\r/g, "");
    const blocks = subs.split("\n\n");

    for(let i = 0; i < blocks.length; i++){
        const lines = blocks[i].trim().split("\n");
        if(lines.length < 3) continue;
        
        // Find timeline index
        let timeLineIndex = -1;
        for(let j = 0; j < Math.min(2, lines.length); j++) {
            if(lines[j].includes(" --> ")) {
                timeLineIndex = j;
                break;
            }
        }
        
        if(timeLineIndex === -1) continue;
        
        try {
            const timeParts = lines[timeLineIndex].split(" --> ");
            if(timeParts.length !== 2) continue;
            
            const beginTime = time_parse(timeParts[0].trim());
            const endTime = time_parse(timeParts[1].trim());
            
            // Validate timeline
            if(isNaN(beginTime) || isNaN(endTime) || beginTime >= endTime) {
                console.warn(`Skip invalid timeline: ${lines[timeLineIndex]}`);
                continue;
            }
            
            // Collect text content
            const textLines = [];
            for(let j = timeLineIndex + 1; j < lines.length; j++){
                if(lines[j].trim()) {
                    textLines.push(lines[j].trim());
                }
            }
            
            if(textLines.length > 0) {
                parsedSubtitles.push({
                    begin: beginTime,
                    end: endTime,
                    text: textLines
                });
            }
        } catch (error) {
            console.warn(`Failed to parse subtitle block (block ${i+1}):`, error.message);
        }
    }
    
    return parsedSubtitles;
}

// New: VTT parser
async function parseVttSubtitles(subs) {
    const parsedSubtitles = [];
    const lines = subs.replace(/\r/g, "").split("\n");
    
    let i = 0;
    // Skip WEBVTT header
    while(i < lines.length && !lines[i].includes("-->")) {
        i++;
    }
    
    while(i < lines.length) {
        // Find timeline row
        while(i < lines.length && !lines[i].includes("-->")) {
            i++;
        }
        
        if(i >= lines.length) break;
        
        try {
            const timeLine = lines[i];
            const timeParts = timeLine.split(" --> ");
            if(timeParts.length !== 2) {
                i++;
                continue;
            }
            
            const beginTime = time_parse(timeParts[0].trim());
            const endTime = time_parse(timeParts[1].split(' ')[0].trim()); // Remove VTT style markers
            
            if(isNaN(beginTime) || isNaN(endTime) || beginTime >= endTime) {
                i++;
                continue;
            }
            
            // Collect text
            i++;
            const textLines = [];
            while(i < lines.length && lines[i].trim() !== "") {
                if(lines[i].trim()) {
                    textLines.push(lines[i].trim());
                }
                i++;
            }
            
            if(textLines.length > 0) {
                parsedSubtitles.push({
                    begin: beginTime,
                    end: endTime,
                    text: textLines
                });
            }
            
        } catch (error) {
            console.warn(`VTT parsing error:`, error.message);
            i++;
        }
    }
    
    return parsedSubtitles;
}

// Rename existing function
async function parseAssSubtitles(subs) {
    return parse_ass_subtitles(subs);
}

// New: Subtitle validation function
function validateParsedSubtitles(parsedSubtitles) {
    if (!Array.isArray(parsedSubtitles)) {
        throw new SubtitleError('Parse result is not an array', 'INVALID_PARSE_RESULT');
    }
    
    if (parsedSubtitles.length === 0) {
        throw new SubtitleError('No valid subtitle entries found', 'NO_SUBTITLES_FOUND');
    }
    
    // Check overlaps and invalid times
    let overlapCount = 0;
    let invalidTimeCount = 0;
    
    for (let i = 0; i < parsedSubtitles.length; i++) {
        const subtitle = parsedSubtitles[i];
        
        // Check time validity
        if (typeof subtitle.begin !== 'number' || typeof subtitle.end !== 'number' ||
            isNaN(subtitle.begin) || isNaN(subtitle.end) ||
            subtitle.begin < 0 || subtitle.end <= subtitle.begin) {
            invalidTimeCount++;
            continue;
        }
        
        // Check overlap with next subtitle
        if (i < parsedSubtitles.length - 1) {
            const nextSubtitle = parsedSubtitles[i + 1];
            if (subtitle.end > nextSubtitle.begin) {
                overlapCount++;
            }
        }
    }
    
    if (invalidTimeCount > 0) {
        console.warn(`Found ${invalidTimeCount} subtitles with invalid timelines`);
    }
    
    if (overlapCount > 0) {
        console.warn(`Found ${overlapCount} overlapping subtitles`);
    }
    
    // If most subtitles have problems, throw error
    if (invalidTimeCount > parsedSubtitles.length * 0.5) {
        throw new SubtitleError(
            `Subtitle quality too low: ${invalidTimeCount}/${parsedSubtitles.length} subtitles have timeline problems`,
            'POOR_QUALITY_SUBTITLES'
        );
    }
}

update_video_elements_list();
shadow_root.getElementById("refresh_video_list").addEventListener("click", function(){
    update_video_elements_list();
});

// Improved: Modern upload handling with error handling, retry mechanism and progress display
shadow_root.getElementById("subtitle_upload_button").addEventListener("click", async function(event){
    event.preventDefault();
    event.stopPropagation();

    // Re-acquire shadow root to be safe
    const host = document.getElementById("shadow_host");
    const root = host ? host.shadowRoot : shadow_root;

    const subtitle_file_input = root.getElementById("subtitle_file_input");
    const subtitle_url_input = root.getElementById("subtitle_url_input");
    const error_message_element = root.getElementById("upload_error_message");
    const retry_button = root.getElementById("retry_button");
    const progress_container = root.getElementById("upload_progress_container");
    
    if (!error_message_element) {
        console.error("Error message element not found");
        return;
    }
    
    // Reset error messages and retry button
    error_message_element.textContent = "";
    error_message_element.classList.remove("source_status");
    error_message_element.title = "";
    retry_button.style.display = "none";
    
    // Create progress indicator
    const progressIndicator = new ProgressIndicator(progress_container);
    
    try {
        let fileName = "";
        
        if(subtitle_url_input && subtitle_url_input.value.length > 0){
            await handleUrlUpload(subtitle_url_input.value, progressIndicator);
            fileName = subtitle_url_input.value.split('/').pop() || subtitle_url_input.value;
            subtitle_url_input.value = ""; // Clear URL input after success
        } else if (subtitle_file_input && subtitle_file_input.files.length > 0) {
            const selectedFile = subtitle_file_input.files[0];
            await handleFileUpload(selectedFile, progressIndicator);
            fileName = selectedFile.name;
            // Don't clear file input - keep showing the loaded file name
        } else {
            throw new SubtitleError("Please select a file or enter a URL", "NO_INPUT");
        }
        
        progressIndicator.hide();
        
        // Show subtitle source (shared status line)
        set_subtitle_source(fileName);
        
    } catch (error) {
        progressIndicator.hide();
        handleUploadError(error, error_message_element, retry_button);
        // Keep file input value when error occurs, so user can see what file was selected
    }
});

urlInput.addEventListener("keydown", function(event){
    if (event.key !== "Enter") return;
    event.preventDefault();
    uploadButton.click();
});

// New: Handle URL upload
async function handleUrlUpload(url, progressIndicator) {
    try {
        progressIndicator.show('Loading subtitles from URL...');
        progressIndicator.updateProgress(10, 'Downloading...');
        
        const response = await NetworkRetry.fetchWithRetry(url);
        const blob = await response.blob();
        
        progressIndicator.updateProgress(50, 'Parsing file type...');
        
        const lowerUrl = url.toLowerCase().split('?')[0];
        const urlExt = lowerUrl.split('.').pop();
        const urlName = decodeURIComponent(url.split('?')[0].split('/').pop() || url);
        const archiveMimes = ['application/zip', 'application/x-7z-compressed', 'application/vnd.rar', 'application/x-rar-compressed'];
        const isZip = blob.type === "application/zip" || urlExt === 'zip';
        const isArchive = isZip || FileValidator.ARCHIVE_FORMATS.includes(urlExt) || archiveMimes.includes(blob.type);
        
        if (isZip) {
            await handleZipFile(await blob_to_base64(blob), progressIndicator, { name: urlName });
        } else if (isArchive) {
            await handleArchiveFile(blob, progressIndicator, { name: urlName });
        } else {
            progressIndicator.updateProgress(70, 'Reading subtitle content...');
            const text = await blob.text();
            
            progressIndicator.updateProgress(90, 'Parsing subtitles...');
            await parse_subtitles(text);
        }
        
        progressIndicator.updateProgress(100, 'Loading complete!');
        
    } catch (error) {
        throw new SubtitleError(
            `URL loading failed: ${error.message}`,
            'URL_LOAD_ERROR',
            { url, originalError: error }
        );
    }
}

// New: Handle file upload
async function handleFileUpload(file, progressIndicator) {
    try {
        // Validate file
        const fileInfo = FileValidator.validateFile(file);
        
        progressIndicator.show(`Loading ${file.name}...`);
        progressIndicator.updateProgress(20, 'Validating file...');
        
        // Handle large files
        if (fileInfo.isLarge) {
            progressIndicator.updateProgress(30, 'Processing large file, please wait...');
            isLargeFile = true;
        }
        
        if (fileInfo.isArchive) {
            progressIndicator.updateProgress(50, 'Extracting files...');
            if (fileInfo.format === 'zip') {
                await handleZipFile(await blob_to_base64(file), progressIndicator, { name: file.name });
            } else {
                await handleArchiveFile(file, progressIndicator, { name: file.name });
            }
            progressIndicator.updateProgress(100, 'Loading complete!');
            return;
        }
        
        progressIndicator.updateProgress(50, 'Reading file content...');
        
        const text = await readFileAsText(file, (percent) => {
            progressIndicator.updateProgress(50 + percent * 0.3, 'Reading...');
        });
        
        progressIndicator.updateProgress(80, 'Parsing subtitles...');
        await parse_subtitles(text, fileInfo.format);
        
        progressIndicator.updateProgress(100, 'Loading complete!');
        
    } catch (error) {
        throw error; // Re-throw for higher level handling
    }
}

// ===== Archive subtitle picker (episode list -> version list) =====
// [reason] SubHD packs are multi-episode/multi-language; auto-picking the first
// subtitle loads the wrong one. The host decides where the picker renders: the
// progress box for manual uploads, or the search result area for packs that were
// downloaded from a search result (there the path is the only way out).
function append_chooser_row(list, options){
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'subtitle-chooser-row';
    row.textContent = options.text;
    if (options.title) row.title = options.title;
    row.addEventListener('click', options.on_click);
    list.appendChild(row);
    return row;
}

function create_picker(host){
    const archive = archivePathLabel(host.name);
    // a click on any level above the archive leaves the picker, so the promise
    // always settles even when the navigation starts it off
    const base = buildPickerBaseSegments(host.base_segments, host.on_leave);
    let groups = [];
    let episodes_scroll = 0;

    function showEpisodes(){
        host.set_status('');
        render_path(host.nav, base.concat([{ label: archive.label, title: archive.title }]));
        host.list.textContent = '';
        groups.forEach(function(g){
            append_chooser_row(host.list, {
                text: g.label,
                title: g.items.map(function(it){ return it.path; }).join('\n'),
                on_click: function(){ pickEpisode(g); }
            });
        });
        host.list.scrollTop = episodes_scroll;
    }

    function showVersions(g){
        host.set_status('');
        render_path(host.nav, base.concat([
            { label: archive.label, title: archive.title, on_click: groups.length > 1 ? showEpisodes : null },
            { label: g.label }
        ]));
        episodes_scroll = host.list.scrollTop;
        host.list.textContent = '';
        g.items.forEach(function(it){
            append_chooser_row(host.list, {
                text: it.short + '  ·  ' + it.ext.toUpperCase(),
                title: it.path,
                on_click: function(){ host.on_pick(it); }
            });
        });
    }

    function pickEpisode(g){
        if (g.items.length === 1) {
            host.on_pick(g.items[0]);
            return;
        }
        showVersions(g);
    }

    return {
        show: function(candidates){
            // candidates: [{ path, ext, getText }]
            groups = groupByEpisode(candidates);
            host.on_open();
            if (groups.length === 1) {
                // one episode (or only 其他): skip straight to the version list
                pickEpisode(groups[0]);
                return;
            }
            showEpisodes();
        },
        setBusy: function(){ host.on_busy(); },
        // parsing failed: bring the same list back so the user can pick another
        resume: function(error){
            host.on_open();
            host.set_status((error && error.message ? error.message : 'Load failed') + ' — pick another file:');
        }
    };
}

// Manual uploads keep the picker in the progress box; the bar/message step aside
// while choosing and come back during reading/parsing
function mount_inline_picker(progress, name, on_pick, on_cancel){
    const container = document.createElement('div');
    container.className = 'subtitle-chooser';
    progress.progressElement.appendChild(container);
    const bar = progress.progressElement.querySelector('.loading-bar');
    const message = progress.progressElement.querySelector('.loading-message');

    const path = document.createElement('div');
    path.className = 'subtitle_path';
    container.appendChild(path);
    const status = document.createElement('div');
    status.className = 'subtitle-chooser-title';
    status.style.display = 'none';
    container.appendChild(status);
    const list = document.createElement('div');
    list.className = 'subtitle-chooser-list';
    container.appendChild(list);
    const footer = document.createElement('div');
    footer.className = 'subtitle-chooser-actions';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    footer.appendChild(cancelBtn);
    container.appendChild(footer);

    function set_picker_mode(picking){
        container.style.display = picking ? '' : 'none';
        if (bar) bar.style.display = picking ? 'none' : '';
        if (message) message.style.display = picking ? 'none' : '';
    }

    cancelBtn.addEventListener('click', function(){
        container.remove();
        set_picker_mode(false);
        on_cancel();
    });

    return create_picker({
        nav: path,
        list: list,
        name: name,
        on_pick: on_pick,
        on_open: function(){ set_picker_mode(true); },
        on_busy: function(){ set_picker_mode(false); },
        on_leave: null,
        set_status: function(text){
            status.textContent = text;
            status.style.display = text ? '' : 'none';
        }
    });
}

// New: Handle ZIP files
function blob_to_base64(blob){
    return blob.arrayBuffer().then(function(buffer){
        const bytes = new Uint8Array(buffer);
        const chunk = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
        }
        return btoa(binary);
    });
}

async function handleZipFile(base64, progressIndicator, archiveOptions = {}) {
    try {
        progressIndicator.updateProgress(30, 'Extracting files...');

        const zip = new JSZip();
        // [reason] hand jszip the base64 string and let it decode itself — its type check
        // uses instanceof and rejects cross-realm ArrayBuffers from Blob.arrayBuffer
        const zipContent = await zip.loadAsync(base64, { base64: true });

        progressIndicator.updateProgress(50, 'Searching for subtitle files...');

        const files = Object.entries(zipContent.files);
        const candidates = [];
        for (const [filename, file] of files) {
            if (file.dir) continue;
            const extension = filename.split(".").pop().toLowerCase();
            if (SUBTITLE_FORMATS.includes(extension)) {
                candidates.push({
                    path: filename,
                    ext: extension,
                    getText: function(){ return file.async("string"); }
                });
            }
        }

        if (!candidates.length) {
            throw new SubtitleError(
                `No supported subtitle formats found in ZIP file (${SUBTITLE_FORMATS.join(', ')}; SUP is not supported)`,
                'NO_SUBTITLE_IN_ZIP'
            );
        }

        await load_archive_candidate(candidates, progressIndicator, archiveOptions);
    } catch (error) {
        if (error instanceof SubtitleError) throw error;
        throw new SubtitleError(
            `ZIP file processing failed: ${error.message}`,
            'ZIP_PROCESSING_ERROR',
            { originalError: error }
        );
    }
}

// Shared by zip/7z/rar handlers: one candidate -> load directly; many -> picker
function load_archive_candidate(candidates, progressIndicator, archiveOptions){
    archiveOptions = archiveOptions || {};
    return new Promise(function(resolve, reject){
        if (candidates.length === 1) {
            load_one(candidates[0]).then(resolve, reject);
            return;
        }
        if (archiveOptions.mode === 'results') {
            // [reason] search-downloaded packs pick their file in the same area the
            // subtitles are listed in; save the view so leaving restores it
            const saved = captureSearchView(searchState);
            let settled = false;
            let closed = false;
            const leave = function(){
                if (closed) return;
                closed = true;
                searchState.archivePicker = null;
                restoreSearchView(searchState, saved);
                render_search_results(saved.results, saved.page);
                update_cached_icons();
                // already loaded a file: only the view changes, nothing to cancel
                if (settled) return;
                set_search_status('No subtitle loaded.', '');
                reject(new SubtitleError('No subtitle loaded.', 'SUBTITLE_CHOICE_CANCELLED'));
            };
            const picker = create_picker({
                nav: search_results_nav,
                list: search_results,
                name: archiveOptions.name,
                // [reason] without a parent level the picker would have no way out
                // (results mode has no Cancel), so fall back to one
                base_segments: saved.path.length ? saved.path : [{ label: 'Search results' }],
                on_pick: function(item){
                    progressIndicator.show('Reading ' + item.path + '...');
                    runArchiveSelection(item, progressIndicator, load_one).then(function(){
                        settled = true;
                        leave();
                        resolve();
                    }, function(error){
                        console.error('Subtitle load failed:', error);
                        picker.resume(error);
                    });
                },
                on_leave: leave,
                on_open: function(){},
                on_busy: function(){},
                set_status: function(text){ set_search_status(text, text ? 'red' : ''); }
            });
            searchState.archivePicker = { cancel: leave };
            search_pager.textContent = '';
            progressIndicator.hide();
            picker.show(candidates);
            return;
        }
        const chooser = mount_inline_picker(progressIndicator, archiveOptions.name, function(item){
            chooser.setBusy();
            load_one(item).then(resolve, function(error){
                // keep the chooser open so the user can pick another file
                console.error('Subtitle load failed:', error);
                chooser.resume(error);
            });
        }, function(){
            reject(new SubtitleError('Cancelled — no subtitle loaded.', 'SUBTITLE_CHOICE_CANCELLED'));
        });
        chooser.show(candidates);
    });

    async function load_one(item){
        progressIndicator.updateProgress(70, 'Reading ' + item.path + '...');
        const text = await item.getText();
        progressIndicator.updateProgress(90, 'Parsing subtitles...');
        await parse_subtitles(text);
    }
}

// New: Handle RAR/7z archives via libarchive.js (WASM in a worker)
let archive_initialized = false;

function ensure_archive_ready(){
    if (archive_initialized) return;
    const workerUrl = chrome.runtime.getURL('libarchive/worker-bundle.js');
    const wasmUrl = chrome.runtime.getURL('libarchive/libarchive.wasm');
    // [reason] content scripts cannot construct workers from extension URLs (cross-origin),
    // so bootstrap through a blob module worker that imports the extension worker bundle;
    // the bundle is patched at build time to read the wasm location from __libarchiveWasmUrl
    const bootstrap = `self.__libarchiveWasmUrl=${JSON.stringify(wasmUrl)};import ${JSON.stringify(workerUrl)};`;
    Archive.init({
        getWorker: function(){
            return new Worker(
                URL.createObjectURL(new Blob([bootstrap], { type: 'text/javascript' })),
                { type: 'module' }
            );
        }
    });
    archive_initialized = true;
}

function base64_to_blob(base64){
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: 'application/octet-stream' });
}

function collect_subtitle_files_in_tree(node, prefix, out){
    if (node instanceof File) {
        const extension = node.name.split('.').pop().toLowerCase();
        if (SUBTITLE_FORMATS.includes(extension)) {
            out.push({
                path: prefix ? prefix + '/' + node.name : node.name,
                ext: extension,
                getText: function(){ return node.text(); }
            });
        }
        return;
    }
    for (const key of Object.keys(node)) {
        collect_subtitle_files_in_tree(node[key], prefix ? prefix + '/' + key : key, out);
    }
}

async function handleArchiveFile(blob, progressIndicator, archiveOptions = {}) {
    try {
        ensure_archive_ready();
        
        progressIndicator.updateProgress(40, 'Opening archive...');
        const archive = await Archive.open(blob);
        
        const encrypted = await archive.hasEncryptedData();
        if (encrypted === true) {
            throw new SubtitleError(
                'Encrypted archives are not supported — use an unencrypted archive.',
                'ENCRYPTED_ARCHIVE'
            );
        }
        
        progressIndicator.updateProgress(55, 'Extracting files...');
        const files = await archive.extractFiles();
        
        progressIndicator.updateProgress(75, 'Searching for subtitle files...');
        const candidates = [];
        collect_subtitle_files_in_tree(files, '', candidates);

        if (!candidates.length) {
            throw new SubtitleError(
                `No supported subtitle formats found in archive (${SUBTITLE_FORMATS.join(', ')}; SUP is not supported)`,
                'NO_SUBTITLE_IN_ARCHIVE'
            );
        }

        await load_archive_candidate(candidates, progressIndicator, archiveOptions);

    } catch (error) {
        if (error instanceof SubtitleError) throw error;
        throw new SubtitleError(
            `Archive processing failed: ${error.message}`,
            'ARCHIVE_PROCESSING_ERROR',
            { originalError: error }
        );
    }
}

// New: Improved file reading functionality
function readFileAsText(file, progressCallback) {
    return new Promise((resolve, reject) => {
        const file_reader = new FileReader();
        
        file_reader.onload = function(event){
            resolve(event.target.result);
        };
        
        file_reader.onerror = function(event){
            const errorMessage = event.target.error ? event.target.error.message : 'Unknown file reading error';
            reject(new SubtitleError(
                `File reading failed: ${errorMessage}. Please ensure the file is not corrupted and contains valid subtitle content.`,
                'FILE_READ_ERROR'
            ));
        };
        
        // Progress tracking (effective for large files)
        file_reader.onprogress = function(event) {
            if (event.lengthComputable && progressCallback) {
                const percent = (event.loaded / event.total) * 100;
                progressCallback(percent);
            }
        };
        
        // Read as text with UTF-8 encoding (default)
        file_reader.readAsText(file);
    });
}

// New: Error handling function
function handleUploadError(error, errorElement, retryButton) {
    console.error('Subtitle upload error:', error);
    
    let errorMessage = 'Unknown error';
    let showRetry = false;
    
    if (error instanceof SubtitleError) {
        errorMessage = error.message;
        
        // Some error types can be retried
        if (['NETWORK_ERROR', 'ZIP_PROCESSING_ERROR', 'ARCHIVE_PROCESSING_ERROR', 'FILE_READ_ERROR'].includes(error.type)) {
            showRetry = true;
        }
    } else {
        errorMessage = `Loading failed: ${error.message}`;
        showRetry = true;
    }
    
    errorElement.textContent = errorMessage;
    errorElement.classList.remove("source_status");
    errorElement.style.color = "#b42318";
    errorElement.title = "";
    
    if (showRetry) {
        retryButton.style.display = "inline-block";
    }
}

// New: Retry button event handling
shadow_root.getElementById("retry_button").addEventListener("click", function(){
    // Trigger upload button click event
    shadow_root.getElementById("subtitle_upload_button").click();
});

shadow_root.getElementById("subtitle_offset_input").addEventListener("input", function(){
    subtitle_offset = parseFloat(shadow_root.getElementById("subtitle_offset_input").value);
});

// keep the TextTrack cue times in sync once the committed offset changes
shadow_root.getElementById("subtitle_offset_input").addEventListener("change", function(){
    subtitle_offset = parseFloat(shadow_root.getElementById("subtitle_offset_input").value);
    extTrackCuesDirty = true;
    if (extTrack) syncExternalCues(extTrack);
    applySubtitleVisibility();
});

const DEFAULT_SUBTITLE_APPEARANCE = {
    position: -100,
    fontSize: 26,
    font: "Arial",
    textColor: "rgba(255, 255, 255, 1)",
    backgroundColor: "rgba(0, 0, 0, 0.7)"
};

function currentAppearance(){
    return {
        position: subtitle_offset_top,
        fontSize: Number(subtitle_font_size),
        font: subtitle_font,
        textColor: subtitle_font_color,
        backgroundColor: subtitle_background_color
    };
}

function saveAppearance(){
    chrome.storage.local.set({ subtitle_appearance: currentAppearance() });
}

function setFontControl(value){
    const known = Array.from(subtitle_font_input.options).some(function(option){
        return option.value === value && option.value !== "custom";
    });
    subtitle_font_input.value = known ? value : "custom";
    custom_font_input.style.display = known ? "none" : "";
    custom_font_input.value = known ? "" : value;
    subtitle_font = value;
}

function syncColorControl(control, value){
    const parsed = parseSubtitleColor(value);
    if (!parsed) return null;
    control.picker.value = parsed.hex;
    control.alpha.value = String(Math.round(parsed.alpha * 100));
    control.alphaValue.textContent = control.alpha.value + "%";
    control.text.value = parsed.rgba;
    control.error.textContent = "";
    control.text.removeAttribute("aria-invalid");
    return parsed.rgba;
}

function colorFromControl(control){
    const parsed = parseSubtitleColor(control.picker.value);
    const alpha = Number(control.alpha.value) / 100;
    const red = parseInt(parsed.hex.slice(1, 3), 16);
    const green = parseInt(parsed.hex.slice(3, 5), 16);
    const blue = parseInt(parsed.hex.slice(5, 7), 16);
    return parseSubtitleColor(`rgba(${red}, ${green}, ${blue}, ${alpha})`).rgba;
}

function setControlColor(control, target){
    const value = colorFromControl(control);
    control.alphaValue.textContent = control.alpha.value + "%";
    control.text.value = value;
    if (target === "text") subtitle_font_color = value;
    else subtitle_background_color = value;
}

function bindColorControl(control, target){
    control.picker.addEventListener("input", function(){
        setControlColor(control, target);
    });
    control.picker.addEventListener("change", saveAppearance);
    control.alpha.addEventListener("input", function(){
        setControlColor(control, target);
    });
    control.alpha.addEventListener("change", saveAppearance);
    control.text.addEventListener("change", function(){
        const parsed = syncColorControl(control, control.text.value);
        if (!parsed) {
            control.error.textContent = "Use HEX, RGB, or RGBA.";
            control.text.setAttribute("aria-invalid", "true");
            return;
        }
        if (target === "text") subtitle_font_color = parsed;
        else subtitle_background_color = parsed;
        saveAppearance();
    });
}

function applyAppearance(appearance, persist){
    const next = Object.assign({}, DEFAULT_SUBTITLE_APPEARANCE, appearance || {});
    const position = Number(next.position);
    const fontSize = Number(next.fontSize);
    subtitle_offset_top = Number.isFinite(position) ? position : DEFAULT_SUBTITLE_APPEARANCE.position;
    subtitle_font_size = Number.isFinite(fontSize) && fontSize > 0
        ? String(fontSize)
        : String(DEFAULT_SUBTITLE_APPEARANCE.fontSize);
    subtitle_offset_top_input.value = String(subtitle_offset_top);
    subtitle_font_size_input.value = subtitle_font_size;
    setFontControl(String(next.font || DEFAULT_SUBTITLE_APPEARANCE.font));
    subtitle_font_color = syncColorControl(fontColorControl, next.textColor) ||
        syncColorControl(fontColorControl, DEFAULT_SUBTITLE_APPEARANCE.textColor);
    subtitle_background_color = syncColorControl(backgroundColorControl, next.backgroundColor) ||
        syncColorControl(backgroundColorControl, DEFAULT_SUBTITLE_APPEARANCE.backgroundColor);
    if (persist) saveAppearance();
}

subtitle_offset_top_input.addEventListener("input", function(){
    const value = Number(this.value);
    if (Number.isFinite(value)) subtitle_offset_top = value;
});
subtitle_offset_top_input.addEventListener("change", saveAppearance);

subtitle_font_size_input.addEventListener("input", function(){
    const value = Number(this.value);
    if (Number.isFinite(value) && value > 0) subtitle_font_size = String(value);
});
subtitle_font_size_input.addEventListener("change", saveAppearance);

subtitle_font_input.addEventListener("change", function(){
    custom_font_input.style.display = this.value === "custom" ? "" : "none";
    if (this.value === "custom") {
        custom_font_input.focus();
        return;
    }
    subtitle_font = this.value;
    saveAppearance();
});

custom_font_input.addEventListener("input", function(){
    if (this.value.trim()) subtitle_font = this.value.trim();
});
custom_font_input.addEventListener("change", saveAppearance);

bindColorControl(fontColorControl, "text");
bindColorControl(backgroundColorControl, "background");

chrome.storage.local.get(["subtitle_appearance"], function(stored){
    applyAppearance(stored.subtitle_appearance, false);
});

resetAppearanceButton.addEventListener("click", function(){
    resetConfirmation.hidden = false;
    cancelResetButton.focus();
});
cancelResetButton.addEventListener("click", function(){
    resetConfirmation.hidden = true;
    resetAppearanceButton.focus();
});
confirmResetButton.addEventListener("click", function(){
    applyAppearance(DEFAULT_SUBTITLE_APPEARANCE, true);
    resetConfirmation.hidden = true;
    resetAppearanceButton.focus();
});

shadow_root.getElementById("s2t_enabled").addEventListener("change", function(){
    chineseConverter.enabled = this.checked;
    chrome.storage.local.set({ s2t_enabled: this.checked });
    extTrackCuesDirty = true;
    if (extTrack) syncExternalCues(extTrack);
    applySubtitleVisibility();
    updateConverterStatus();
});

shadow_root.getElementById("close_button").addEventListener("click", function(){
    menu.style.display = "none";
});

// Add converter status update functionality
function updateConverterStatus() {
    const statusElement = shadow_root.getElementById("converter_status");
    if (!statusElement) return;
    try {
        if (chineseConverter && chineseConverter.enabled === false) {
            statusElement.textContent = "S2T Disabled";
            statusElement.style.color = "#52645a";
            return;
        }
        if (chineseConverter.openccLoaded && chineseConverter.converter) {
            statusElement.textContent = "OpenCC Ready";
            statusElement.style.color = "#146c43";
            return;
        }
        statusElement.textContent = "FAILED: OpenCC Not Available";
        statusElement.style.color = "#b42318";
    } catch (_e) {
        statusElement.textContent = "FAILED: Status Check Error";
        statusElement.style.color = "#b42318";
    }
}

// Simplified reload: ask background to reinject, then refresh status
shadow_root.getElementById("reload_converter").addEventListener("click", function(){
    const statusElement = shadow_root.getElementById("converter_status");
    statusElement.textContent = "Reloading...";
    statusElement.style.color = "#9a5b00";
    if (typeof chrome !== 'undefined' && chrome.runtime) {
        new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ action: 'reinject_opencc' }, response => {
                const error = chrome.runtime.lastError;
                if (error) reject(new Error(error.message));
                else resolve(response);
            });
        })
            .then(() => setTimeout(updateConverterStatus, 1200))
            .catch(() => {
                statusElement.textContent = "Reload Failed";
                statusElement.style.color = "#b42318";
            });
    } else {
        statusElement.textContent = "Reload Failed";
        statusElement.style.color = "#b42318";
    }
});

// Periodically update converter status
setInterval(updateConverterStatus, 2000);

// Initial update
setTimeout(updateConverterStatus, 500);

// Renderer switching for the site's own fullscreen: our DOM overlay cannot render
// above the fullscreen top layer, so subtitles move onto a TextTrack (rendered
// together with the video, keeping the site's native control bar fully usable).
// Re-apply one frame later: some players flip track modes during their own
// fullscreen setup, after this event fires.
document.addEventListener("fullscreenchange", function(){
    applySubtitleVisibility();
    requestAnimationFrame(applySubtitleVisibility);
});

// ======= Online subtitle search logic =======

// mirror list lives in subhd_config.js so background permissions/DNR stay in sync
let subhdBaseCache = null;
const ASSRT_BASE = "https://api.assrt.net";
const OS_API_BASE = "https://api.opensubtitles.com";
const OS_LANG_CODES = { 'zh-hans':'zh-cn', 'zh-hant':'zh-tw' };

const SEARCH_PAGE_SIZE = 30;
const searchState = createSearchState();
let last_search = null;

function clean_page_title(raw){
    if (!raw) return '';
    const title = raw.trim();
    if (!title) return '';
    // cut common "Movie Name | Site Name"-style suffixes, keep the first segment
    const first = title.split(/\s*[|\-–—·»«:]\s*/)[0].trim();
    if (first.length >= 2) return first;
    return title;
}

function detect_video_name(){
    try {
        const titleEl = document.querySelector("head > title");
        let name = clean_page_title(titleEl ? titleEl.textContent : '');
        if (!name) {
            const og = document.querySelector('meta[property="og:title"], meta[property="twitter:title"], meta[name="og:title"]');
            name = clean_page_title(og ? og.getAttribute('content') : '');
        }
        if (!name) {
            const h1 = document.querySelector("h1");
            name = clean_page_title(h1 ? h1.textContent : '');
        }
        return name;
    } catch (_error) {
        return '';
    }
}

function bg_send_message(request){
    return new Promise(function(resolve, reject){
        try {
            chrome.runtime.sendMessage(request, function(resp){
                const err = chrome.runtime.lastError;
                if (err) {
                    reject(new SubtitleError('Background fetch failed: ' + err.message, 'NETWORK_ERROR'));
                } else if (!resp) {
                    reject(new SubtitleError('No response from background script', 'NETWORK_ERROR'));
                } else {
                    resolve(resp);
                }
            });
        } catch (error) {
            reject(new SubtitleError('Background fetch failed: ' + error.message, 'NETWORK_ERROR'));
        }
    });
}

async function bg_fetch_text(request){
    const resp = await bg_send_message(Object.assign({ action: 'sub_fetch_text' }, request));
    if (resp.error) throw new SubtitleError('Network fetch failed: ' + resp.error, 'NETWORK_ERROR');
    return resp;
}

async function bg_fetch_file(request){
    const resp = await bg_send_message(Object.assign({ action: 'sub_fetch_file' }, request));
    if (resp.error) throw new SubtitleError('Network fetch failed: ' + resp.error, 'NETWORK_ERROR');
    return resp;
}

function local_storage_keys(){
    return new Promise(function(resolve){
        chrome.storage.local.get(['os_api_key', 'assrt_token'], resolve);
    });
}

// Persistent display of the loaded subtitle source (doubles as the upload status line)
function set_subtitle_source(text){
    if (!errorMessage) return;
    errorMessage.textContent = text ? `Source: ${text}` : "";
    errorMessage.classList.toggle("source_status", Boolean(text));
    errorMessage.style.color = text ? "#146c43" : "";
    errorMessage.title = text || "";
}

function set_search_status(text, color){
    search_status_elem.textContent = text;
    const tones = {
        green: "#146c43",
        red: "#b42318",
        orange: "#9a5b00",
        gray: "#52645a"
    };
    search_status_elem.style.color = tones[color] || color || '';
}

// loose language filter for scrape providers listing tags like 简/繁/双语
function scrape_lang_ok(text, language){
    if (language === 'all') return true;
    if (language === 'zh-hans') return /简|CHS|双语|雙語|中[文字]/i.test(text);
    if (language === 'zh-hant') return /繁|CHT|双语|雙語|中[文字]/i.test(text);
    if (language === 'en') return /英[字文语]|English|双语|雙語/i.test(text);
    return true;
}

// client-side guard; OpenSubtitles labels languages like en, zh-cn, zh-tw, pt-BR
function os_lang_ok(attrLanguage, language){
    if (language === 'all') return true;
    const code = String(attrLanguage || '').toLowerCase();
    if (language === 'zh-hans') return /^zh-(cn|sg|hans)/.test(code);
    if (language === 'zh-hant') return /^zh-(tw|hk|mo|hant)/.test(code);
    return code === language || code.indexOf(language + '-') === 0;
}

function parse_json_or_throw(text, provider){
    try {
        return JSON.parse(text);
    } catch (_error) {
        throw new SubtitleError(provider + ' returned invalid JSON', 'PARSE_ERROR');
    }
}

async function search_opensubtitles(query, language){
    const keys = await local_storage_keys();
    if (!keys.os_api_key) {
        throw new SubtitleError('OpenSubtitles API key missing — open Settings, save it, then retry.', 'API_KEY_MISSING');
    }
    const fetch_page = async function(with_lang){
        const params = new URLSearchParams();
        params.set('query', query);
        params.set('page', '1');
        if (with_lang && language !== 'all') {
            // API expects 2-letter codes (zh variants: zh-cn/zh-tw)
            params.set('languages', OS_LANG_CODES[language] || language);
        }
        const resp = await bg_fetch_text({
            url: OS_API_BASE + '/api/v1/subtitles?' + params.toString(),
            headers: { 'Api-Key': keys.os_api_key, 'Accept': 'application/json' }
        });
        const json = parse_json_or_throw(resp.text, 'OpenSubtitles');
        if (!resp.ok) {
            throw new SubtitleError('OpenSubtitles search failed: ' + (json.message || ('HTTP ' + resp.status)), 'NETWORK_ERROR');
        }
        return json.data || [];
    };
    let data = await fetch_page(true);
    // language code rejected server-side returns empty; retry unfiltered and rely on os_lang_ok
    if (data.length === 0 && language !== 'all') {
        data = await fetch_page(false);
    }
    return data
        .filter(function(item){ return item.attributes && item.attributes.files && item.attributes.files.length > 0; })
        .filter(function(item){ return os_lang_ok(item.attributes.language, language); })
        .map(function(item){
            const attr = item.attributes;
            const title = attr.release || attr.title || attr.movie_title || attr.long_title || 'Unknown';
            const meta = [attr.language, (attr.download_count || 0) + ' downloads'].filter(Boolean).join(' · ');
            return { title: title, meta: meta, pay: { kind: 'os', file_id: attr.files[0].file_id } };
        })
        .slice(0, 30);
}

// assrt exposes structured lang flags (langchs/langcht/langeng/langdou); prefer them over desc text
function assrt_lang_ok(sub, language){
    if (language === 'all') return true;
    const list = sub.lang && sub.lang.langlist;
    if (!list) return true; // rows without lang info are kept rather than wrongly dropped
    if (language === 'zh-hans') return !!(list.langchs || list.langdou);
    if (language === 'zh-hant') return !!list.langcht;
    if (language === 'en') return !!(list.langeng || list.langdou);
    return true;
}

async function search_assrt(query, language){
    const keys = await local_storage_keys();
    if (!keys.assrt_token) {
        throw new SubtitleError('Shooter token missing — open Settings, save it, then retry.', 'API_KEY_MISSING');
    }
    const resp = await bg_fetch_text({
        url: ASSRT_BASE + '/v1/sub/search?token=' + encodeURIComponent(keys.assrt_token) + '&q=' + encodeURIComponent(query) + '&cnt=20',
        headers: { 'Accept': 'application/json' }
    });
    const json = parse_json_or_throw(resp.text, 'assrt');
    if (!resp.ok || json.status !== 0) {
        throw new SubtitleError('assrt search failed: ' + (json.status_msg || json.error || ('HTTP ' + resp.status)), 'NETWORK_ERROR');
    }
    const subs = (json.sub && json.sub.subs) || [];
    return subs.map(function(sub){
        const title = sub.native_name || sub.name || ('#' + sub.id);
        const langText = sub.lang && typeof sub.lang === 'object'
            ? Object.values(sub.lang).filter(function(v){ return typeof v === 'string'; }).join(' / ')
            : '';
        const meta = [langText, sub.subtype].filter(Boolean).join(' · ');
        const result = { title: title, meta: meta, pay: { kind: 'assrt', id: sub.id } };
        return assrt_lang_ok(sub, language) ? result : null;
    }).filter(Boolean).slice(0, 30);
}

// [reason] mirrors get walled/blocked independently; try each until one answers, remember the winner for this session
async function subhd_fetch_text(path){
    const candidates = subhdBaseCache ? [subhdBaseCache] : [];
    for (const m of SUBHD_MIRRORS) {
        if (m !== subhdBaseCache) candidates.push(m);
    }
    const attempts = [];
    for (const base of candidates) {
        let resp;
        try {
            resp = await bg_fetch_text({ url: base + path });
        } catch (error) {
            attempts.push({ base, error: (error && error.message) || 'unknown error' });
            continue; // NetworkError from this mirror — try the next one
        }
        if (!resp.ok) {
            attempts.push({ base, error: 'HTTP ' + resp.status });
            continue; // 403/5xx — same site is up somewhere else, try next mirror
        }
        subhdBaseCache = base;
        return { response: resp, base };
    }
    // [reason] keep domain and reason together so a single line shows whether every
    // mirror failed the same way (environment) or differently (per-mirror)
    const summary = attempts.map(function(a){ return a.base + ': ' + a.error; }).join(' / ');
    throw new SubtitleError('SubHD search failed — ' + summary, 'NETWORK_ERROR');
}

// [reason] both SubHD layouts render one subtitle per row; the download count lives
// next to the .bi-download icon on search pages but in the right-hand column of /d/ pages
function subhd_downloads(container){
    if (!container) return 0;
    const icon = container.querySelector('.bi-download');
    if (icon && icon.nextElementSibling) {
        return parseInt(icon.nextElementSibling.textContent, 10) || 0;
    }
    const cell = container.querySelector('.text-end.text-secondary');
    return cell ? (parseInt(cell.textContent, 10) || 0) : 0;
}

function subhd_row_result(container, code, title, language, base){
    if (!container || !title) return null;
    const context = ((container.textContent) || '').slice(0, 800);
    // [reason] SubHD marks languages as <span class="p-1 fw-bold">简体</span>;
    // reading those tags avoids matching language words inside the release title
    const langTags = Array.from(new Set(
        Array.from(container.querySelectorAll('span.p-1.fw-bold'))
            .map(function(span){ return (span.textContent || '').trim(); })
            .filter(Boolean)
    ));
    // fallback: a markup change hides every tag, so keep the loose text check
    const langOk = langTags.length
        ? subhdLanguageMatch(langTags, language)
        : scrape_lang_ok(context, language);
    if (!langOk) return null;
    // [reason] SubHD lists each format as <span class="p-1 text-secondary">ASS</span>;
    // SUP (image subtitles) cannot be parsed, so drop results that offer only SUP
    const formatTokens = Array.from(container.querySelectorAll('span.text-secondary'))
        .map(function(span){ return (span.textContent || '').trim().toUpperCase(); })
        .filter(function(text){ return /^(SRT|ASS|SSA|VTT|SUP)$/.test(text); });
    if (!hasUsableSubtitleFormat(formatTokens)) return null;
    const langLabels = (langTags.length
        ? langTags
        : Array.from(new Set(context.match(/简体|繁体|英语|双语/g) || [])))
        .map(subhdLanguageLabel);
    const metaParts = Array.from(new Set(langLabels)).concat(formatTokens);
    const downloads = subhd_downloads(container);
    if (downloads) metaParts.push('⬇ ' + downloads);
    return {
        title: title,
        meta: metaParts.length ? metaParts.join(' · ') : 'SubHD',
        downloads: downloads,
        pay: { kind: 'subhd', id: code, item: base + '/a/' + code }
    };
}

// distinct /d/<id> titles a search page links, most-mentioned first
function subhd_candidates(doc, query){
    const counts = {};
    const titles = {};
    const order = [];
    Array.from(doc.querySelectorAll('div.bg-white.shadow-sm.rounded-3.mb-4')).forEach(function(card){
        const dAnchor = card.querySelector('a[href^="/d/"]');
        const match = dAnchor && (dAnchor.getAttribute('href') || '').match(/\/d\/(\d+)/);
        if (!match) return;
        const id = match[1];
        if (!counts[id]) {
            counts[id] = 0;
            order.push(id);
            // [reason] /d/ poster links have no text; the bold /a/ is the work title,
            // while later /a/ links are release names. Poster alt is a safe fallback.
            const titleAnchor = card.querySelector('.float-start.f16.fw-bold a[href^="/a/"]');
            const poster = dAnchor.querySelector('img[alt]');
            const text = titleAnchor ? (titleAnchor.textContent || '').trim() : '';
            const alt = poster ? (poster.getAttribute('alt') || '').trim() : '';
            const title = subhdTitleForQuery(text, alt, query);
            if (title) titles[id] = title;
        }
        counts[id] += 1;
    });
    return order
        .map(function(id){ return { id: id, title: titles[id] || ('SubHD #' + id), count: counts[id] }; })
        .sort(function(a, b){ return b.count - a.count; })
        .slice(0, 5);
}

function subhd_search_rows(doc, language, base){
    const anchors = Array.from(doc.querySelectorAll('a[href^="/a/"]'));
    // [reason] each result row links the same /a/<code> twice (movie name + edition line);
    // keep the longest anchor text per code so the release/edition line wins
    const byCode = {};
    for (const anchor of anchors) {
        const idMatch = (anchor.getAttribute('href') || '').match(/\/a\/([A-Za-z0-9]+)/);
        if (!idMatch) continue;
        const code = idMatch[1];
        const text = (anchor.textContent || '').trim();
        if (!byCode[code] || text.length > byCode[code].text.length) {
            byCode[code] = { anchor: anchor, text: text };
        }
    }
    const results = [];
    for (const code in byCode) {
        const entry = byCode[code];
        // [reason] scope to a single result row: `table` would cover every row, so a
        // SUP-only result would inherit a neighbour's ASS tag and survive filtering
        const container = entry.anchor.closest('.bg-white, tr, li, .row') || entry.anchor.closest('div') || entry.anchor;
        const result = subhd_row_result(container, code, entry.text, language, base);
        if (result) results.push(result);
    }
    results.sort(function(a, b){ return b.downloads - a.downloads; });
    return results.slice(0, SEARCH_PAGE_SIZE);
}

// /d/ pages list every subtitle of one title (one season), grouped by 第 N 集
function subhd_detail_rows(doc, language, base){
    const results = [];
    const seen = {};
    let episode = '';
    const nodes = doc.querySelectorAll('.rounded-3.mb-5 .px-3.py-1, .rounded-3.mb-5 .row.pt-2.mb-2');
    for (const node of nodes) {
        const text = (node.textContent || '').trim();
        if (!node.classList.contains('row')) {
            // [reason] section headers are 第 N 集 and, on some titles, 合集; any header
            // sets the label so pack rows stop inheriting the previous episode
            if (text) episode = text;
            continue;
        }
        const anchor = node.querySelector('a[href^="/a/"]');
        const codeMatch = anchor ? (anchor.getAttribute('href') || '').match(/\/a\/([A-Za-z0-9]+)/) : null;
        if (!codeMatch || seen[codeMatch[1]]) continue;
        const title = (anchor.textContent || '').trim();
        const result = subhd_row_result(node, codeMatch[1], title, language, base);
        if (!result) continue;
        result.episode = episode;
        seen[codeMatch[1]] = true;
        results.push(result);
    }
    return results;
}

async function subhd_load_detail(id, language){
    const { response: resp, base } = await subhd_fetch_text('/d/' + id);
    const doc = new DOMParser().parseFromString(resp.text, 'text/html');
    const results = subhd_detail_rows(doc, language, base);
    // [reason] empty means the layout moved; let the caller fall back to search rows
    if (!results.length) throw new SubtitleError('SubHD detail page had no usable subtitles.', 'PARSE_ERROR');
    return results;
}

async function search_subhd(query, language){
    const { response: resp, base } = await subhd_fetch_text('/search/' + encodeURIComponent(query));
    const doc = new DOMParser().parseFromString(resp.text, 'text/html');
    const candidates = subhd_candidates(doc, query);
    // [reason] one title = no ambiguity; several = let the user pick, because search
    // cards mix seasons and unrelated titles (e.g. Breaking Bad → 4 seasons + a film)
    if (candidates.length === 1) {
        try {
            return { candidates: candidates, results: await subhd_load_detail(candidates[0].id, language), detail: true };
        } catch (_error) {
            // fall through to the first search page
        }
    }
    return { candidates: candidates, results: subhd_search_rows(doc, language, base), detail: false };
}


function run_search(provider, query, language){
    switch (provider) {
        case 'opensubtitles': return search_opensubtitles(query, language);
        case 'assrt': return search_assrt(query, language);
        case 'subhd': return search_subhd(query, language);
        default: throw new SubtitleError('Unknown provider: ' + provider, 'GENERAL');
    }
}

async function download_opensubtitles(pay){
    const keys = await local_storage_keys();
    if (!keys.os_api_key) {
        throw new SubtitleError('OpenSubtitles API key missing.', 'API_KEY_MISSING');
    }
    const dlResp = await bg_fetch_text({
        url: OS_API_BASE + '/api/v1/download?file_id=' + encodeURIComponent(pay.file_id),
        method: 'POST',
        headers: { 'Api-Key': keys.os_api_key, 'Accept': 'application/json' }
    });
    const dl = parse_json_or_throw(dlResp.text, 'OpenSubtitles');
    if (!dlResp.ok || !dl.link) {
        throw new SubtitleError('OpenSubtitles download failed: ' + (dl.message || dl.error || ('HTTP ' + dlResp.status)), 'NETWORK_ERROR');
    }
    const fileResp = await bg_fetch_file({ url: dl.link });
    if (!fileResp.ok) {
        throw new SubtitleError('OpenSubtitles file download failed (HTTP ' + fileResp.status + ')', 'NETWORK_ERROR');
    }
    return { base64: fileResp.base64, mime: fileResp.mime };
}

async function download_assrt(pay){
    const keys = await local_storage_keys();
    if (!keys.assrt_token) {
        throw new SubtitleError('assrt token missing.', 'API_KEY_MISSING');
    }
    const detailResp = await bg_fetch_text({
        url: ASSRT_BASE + '/v1/sub/detail?token=' + encodeURIComponent(keys.assrt_token) + '&id=' + encodeURIComponent(pay.id) + '&filelist=1',
        headers: { 'Accept': 'application/json' }
    });
    const json = parse_json_or_throw(detailResp.text, 'assrt');
    if (!detailResp.ok || json.status !== 0) {
        throw new SubtitleError('assrt detail failed: ' + (json.status_msg || ('HTTP ' + detailResp.status)), 'NETWORK_ERROR');
    }
    const first = json.sub && json.sub.subs && json.sub.subs[0];
    const filelist = (first && first.filelist) || [];
    let chosen = null;
    for (const file of filelist) {
        const name = file.name || file.url || '';
        const ext = name.split('.').pop().toLowerCase();
        if (file.url && SUBTITLE_FORMATS.indexOf(ext) !== -1) {
            chosen = file;
            break;
        }
    }
    if (!chosen) chosen = filelist.find(function(file){ return file.url; }) || null;
    // the onthefly single-file endpoint has been refusing downloads (HTTP 493,
    // "服务器抽风"); fall back to the whole-pack download URL when it does
    let fileResp = null;
    if (chosen) {
        fileResp = await bg_fetch_file({ url: chosen.url });
        if (!fileResp.ok) {
            fileResp = null;
        }
    }
    if (!fileResp && first && first.url) {
        fileResp = await bg_fetch_file({ url: first.url });
    }
    if (!fileResp || !fileResp.ok) {
        throw new SubtitleError('assrt file download failed' + (fileResp ? ' (HTTP ' + fileResp.status + ')' : '') + ' — try another provider.', 'NETWORK_ERROR');
    }
    return { base64: fileResp.base64, mime: fileResp.mime };
}

async function download_subhd(pay){
    // [reason] /api/sub/down requires a Cloudflare Turnstile token minted on SubHD's
    // real /down/<sid> page; the whole handshake therefore runs in a background tab
    // (see subhdPageDownload in background_script.js)
    const page = await bg_send_message({ action: 'subhd_page_download', item: pay.item });
    if (page && page.ok && page.base64) {
        return { base64: page.base64, mime: page.mime };
    }
    throw new SubtitleError('SubHD download failed: ' + ((page && page.error) || 'no response') + ' — try another provider.', 'SUBHD_BLOCKED');
}

function download_result(pay){
    switch (pay.kind) {
        case 'os': return download_opensubtitles(pay);
        case 'assrt': return download_assrt(pay);
        case 'subhd': return download_subhd(pay);
        default: throw new SubtitleError('Unknown result type: ' + pay.kind, 'GENERAL');
    }
}

function base64_head_bytes(base64, count){
    try {
        const binary = atob(base64.slice(0, Math.ceil(count / 3) * 4));
        const bytes = [];
        for (let i = 0; i < binary.length && bytes.length < count; i++) {
            bytes.push(binary.charCodeAt(i));
        }
        return bytes;
    } catch (_error) {
        return [];
    }
}

function base64_to_utf8_text(base64){
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder('utf-8').decode(bytes);
}

async function apply_result_file(file, progressIndicator, archiveOptions){
    progressIndicator.updateProgress(30, 'Checking file type...');
    const head = base64_head_bytes(file.base64, 6);
    if (head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21) {
        // Rar!
        await handleArchiveFile(base64_to_blob(file.base64), progressIndicator, archiveOptions);
    } else if (head[0] === 0x37 && head[1] === 0x7A && head[2] === 0xBC && head[3] === 0xAF && head[4] === 0x27 && head[5] === 0x1C) {
        // 7z: 37 7A BC AF 27 1C
        await handleArchiveFile(base64_to_blob(file.base64), progressIndicator, archiveOptions);
    } else if (head[0] === 0x50 && head[1] === 0x4B) {
        await handleZipFile(file.base64, progressIndicator, archiveOptions);
    } else {
        progressIndicator.updateProgress(70, 'Parsing subtitles...');
        await parse_subtitles(base64_to_utf8_text(file.base64));
    }
    progressIndicator.updateProgress(100, 'Loaded!');
}

function create_cached_icon(){
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Cached');
    svg.setAttribute('class', 'result_cached_icon');
    const title = document.createElementNS(NS, 'title');
    title.textContent = 'Cached';
    svg.appendChild(title);
    [
        'M2.5 5.5h11v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z',
        'M2.5 5.5l1.5-2.5h8l1.5 2.5',
        'M5.5 9l1.7 1.7L10.8 7'
    ].forEach(function(d){
        const path = document.createElementNS(NS, 'path');
        path.setAttribute('d', d);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#1976d2');
        path.setAttribute('stroke-width', '1.4');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
    });
    set_cached_icon_visible(svg, false);
    return svg;
}

function set_cached_icon_visible(icon, visible){
    icon.style.display = visible ? '' : 'none';
    icon.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function update_cached_icons(){
    const key = searchState.downloadCache && searchState.downloadCache.key;
    const rows = search_results.querySelectorAll(".search_result_item");
    rows.forEach(function(row){
        const icon = row.querySelector(".result_cached_icon");
        if (!icon) return;
        const result = searchState.results[Number(row.dataset.index)];
        set_cached_icon_visible(icon, Boolean(key && result && getDownloadCacheKey(result.pay) === key));
    });
}

// Clickable path above a list: every segment but the last jumps back a level
function render_path(container, segments){
    container.textContent = '';
    segments.forEach(function(segment, index){
        const last = index === segments.length - 1;
        if (index) {
            const sep = document.createElement("span");
            sep.className = "search_path_sep";
            sep.textContent = '›';
            container.appendChild(sep);
        }
        if (!last && segment.on_click) {
            const link = document.createElement("a");
            link.href = '#';
            link.textContent = segment.label;
            if (segment.title) link.title = segment.title;
            link.addEventListener('click', function(event){
                event.preventDefault();
                segment.on_click();
            });
            container.appendChild(link);
            return;
        }
        const label = document.createElement("span");
        label.className = last ? 'search_path_current' : 'search_path_label';
        label.textContent = segment.label;
        if (segment.title) label.title = segment.title;
        container.appendChild(label);
    });
}

function render_search_path(){
    render_path(search_results_nav, searchState.path);
}

// group rows by their 第 N 集 label; 合集 first, unlabeled rows go last
function subhd_episode_groups(rows){
    const groups = [];
    const byLabel = {};
    rows.forEach(function(row){
        const key = row.episode || '';
        if (!byLabel[key]) {
            byLabel[key] = { label: row.episode || '未分集', key: key, rows: [] };
            groups.push(byLabel[key]);
        }
        byLabel[key].rows.push(row);
    });
    groups.sort(function(a, b){
        const ka = subhdEpisodeSortKey(a.label);
        const kb = subhdEpisodeSortKey(b.label);
        if (ka === kb) return 0;
        return ka < kb ? -1 : 1;
    });
    return groups;
}

// "All episodes" view: episodes ascending, page order kept inside each group
function subhd_all_rows(rows, query){
    const list = [];
    subhd_episode_groups(rows).forEach(function(group){
        group.rows.forEach(function(row){
            list.push(Object.assign({}, row, {
                title: row.episode ? subhdLabel(row.episode, query) + ' · ' + row.title : row.title
            }));
        });
    });
    return list;
}

function render_search_pager(total){
    search_pager.textContent = '';
    const pages = Math.ceil(total / SEARCH_PAGE_SIZE);
    if (pages < 2) return;
    function page_button(label, target, disabled){
        const btn = document.createElement("button");
        btn.type = 'button';
        btn.textContent = label;
        if (disabled) {
            btn.disabled = true;
        } else {
            btn.addEventListener('click', function(){ render_search_results(searchState.results, target); });
        }
        search_pager.appendChild(btn);
    }
    page_button('Previous', searchState.page - 1, searchState.page <= 1);
    const status = document.createElement("span");
    status.className = "page_status";
    status.textContent = searchState.page + " / " + pages;
    status.setAttribute("aria-live", "polite");
    search_pager.appendChild(status);
    page_button('Next', searchState.page + 1, searchState.page >= pages);
}

function clear_search_results(){
    while (search_results.firstChild) {
        search_results.removeChild(search_results.firstChild);
    }
}

function render_search_results(results, page){
    searchState.results = results;
    const paged = getPagedResults(results, page, SEARCH_PAGE_SIZE);
    searchState.page = paged.page;
    clear_search_results();
    render_search_path();
    if (results.length === 0) {
        search_pager.textContent = '';
        const emptyBox = document.createElement("div");
        emptyBox.className = "search_empty_box";
        emptyBox.textContent = "No subtitles found.";
        search_results.appendChild(emptyBox);
        return;
    }
    const start = (searchState.page - 1) * SEARCH_PAGE_SIZE;
    paged.items.forEach(function(result, offset){
        const idx = start + offset;
        const row = document.createElement("button");
        row.type = "button";
        row.className = "search_result_item";
        row.dataset.index = String(idx);

        const titleLine = document.createElement("span");
        titleLine.className = "result_title_line";
        const titleText = document.createElement("span");
        titleText.className = "result_title_text";
        titleText.textContent = result.title;
        titleLine.appendChild(titleText);
        const badges = document.createElement("span");
        badges.className = "result_badges";
        const cachedIcon = create_cached_icon();
        set_cached_icon_visible(cachedIcon, Boolean(searchState.downloadCache && getDownloadCacheKey(result.pay) === searchState.downloadCache.key));
        badges.appendChild(cachedIcon);
        const isLoaded = Boolean(searchState.loadedKey && getDownloadCacheKey(result.pay) === searchState.loadedKey);
        titleLine.appendChild(badges);
        row.classList.toggle("selected_result", isLoaded);
        if (isLoaded) row.setAttribute("aria-current", "true");
        row.appendChild(titleLine);

        const metaLine = document.createElement("span");
        metaLine.className = "result_meta";
        metaLine.textContent = result.meta || '';
        row.appendChild(metaLine);

        row.addEventListener("click", function(){
            load_search_result(idx, row);
        });
        search_results.appendChild(row);
    });
    render_search_pager(results.length);
}

// SubHD matched more than one title: show them instead of guessing
function render_subhd_candidates(candidates){
    searchState.subhd.candidates = candidates;
    searchState.subhd.selected = null;
    searchState.subhd.rows = [];
    searchState.view = { kind: 'candidates' };
    searchState.results = [];
    searchState.page = 1;
    searchState.path = [{ label: 'SubHD', on_click: candidates.length > 1 ? function(){ render_subhd_candidates(candidates); } : null }];
    clear_search_results();
    search_pager.textContent = '';
    render_search_path();

    const wrap = document.createElement("div");
    wrap.className = "subtitle-chooser";
    const header = document.createElement("div");
    header.className = "subtitle-chooser-title";
    header.textContent = 'SubHD matched several titles — pick one:';
    wrap.appendChild(header);
    const list = document.createElement("div");
    list.className = "subtitle-chooser-list";
    candidates.forEach(function(candidate){
        append_chooser_row(list, {
            text: candidate.title + '  ·  ' + candidate.count + (candidate.count === 1 ? ' result' : ' results'),
            title: candidate.title,
            on_click: function(){ load_subhd_candidate(candidate); }
        });
    });
    wrap.appendChild(list);
    search_results.appendChild(wrap);
}

function enter_subhd_title(candidate, rows){
    searchState.subhd.selected = candidate;
    searchState.subhd.rows = rows;
    if (hasSubhdEpisodeLayer(rows)) {
        render_subhd_episodes(candidate, rows);
    } else {
        render_subhd_episode(candidate, null);
    }
}

function render_subhd_path(candidate, episode){
    searchState.path = [
        {
            label: 'SubHD',
            on_click: searchState.subhd.candidates.length > 1
                ? function(){ render_subhd_candidates(searchState.subhd.candidates); }
                : null
        },
        {
            label: candidate.title,
            on_click: hasSubhdEpisodeLayer(searchState.subhd.rows)
                ? function(){ render_subhd_episodes(candidate, searchState.subhd.rows); }
                : null
        }
    ];
    if (episode !== undefined) {
        const query = searchState.subhd.query;
        const all_label = subhdLabel(
            hasSubhdEpisodeLayer(searchState.subhd.rows) ? '全部集數' : '全部字幕',
            query
        );
        searchState.path.push({ label: episode === null ? all_label : subhdLabel(episode || '未分集', query) });
    }
}

function render_subhd_episodes(candidate, rows){
    searchState.subhd.selected = candidate;
    searchState.subhd.rows = rows;
    searchState.view = { kind: 'episodes' };
    searchState.results = [];
    searchState.page = 1;
    render_subhd_path(candidate);
    clear_search_results();
    search_pager.textContent = '';
    render_search_path();

    const wrap = document.createElement("div");
    wrap.className = "subtitle-chooser";
    const list = document.createElement("div");
    list.className = "subtitle-chooser-list";
    function add_row(text, target){
        append_chooser_row(list, {
            text: text,
            on_click: function(){ render_subhd_episode(candidate, target); }
        });
    }
    const query = searchState.subhd.query;
    add_row(subhdLabel('全部集數', query) + ' · ' + subhdCountText(rows.length, query), null);
    subhd_episode_groups(rows).forEach(function(group){
        add_row(subhdLabel(group.label, query) + ' · ' + subhdCountText(group.rows.length, query), group.key);
    });
    wrap.appendChild(list);
    search_results.appendChild(wrap);
    set_search_status('', '');
}

// episode === null shows every row (episodes ascending); else one episode key
function render_subhd_episode(candidate, episode){
    const rows = searchState.subhd.rows;
    const is_all = episode === null;
    const list = is_all
        ? subhd_all_rows(rows, searchState.subhd.query)
        : rows.filter(function(row){ return (row.episode || '') === episode; });
    searchState.subhd.selected = candidate;
    searchState.view = { kind: is_all ? 'all' : 'episode', episode: is_all ? null : episode };
    render_subhd_path(candidate, episode);
    render_search_results(list, 1);
    set_search_status('', '');
}

async function load_subhd_candidate(candidate){
    if (searchState.loading) return;
    searchState.loading = true;
    searchState.subhd.selected = candidate;
    const progress = new ProgressIndicator(search_progress_container, search_block);
    progress.show('Loading ' + candidate.title + '...');
    try {
        const results = await subhd_load_detail(candidate.id, search_language.value);
        enter_subhd_title(candidate, results);
    } catch (error) {
        console.error('SubHD title page failed:', error);
        searchState.subhd.selected = null;
        searchState.subhd.rows = [];
        searchState.view = { kind: 'search_rows' };
        searchState.path = [
            {
                label: 'SubHD',
                on_click: searchState.subhd.candidates.length > 1
                    ? function(){ render_subhd_candidates(searchState.subhd.candidates); }
                    : null
            },
            { label: candidate.title }
        ];
        render_search_results(searchState.subhd.fallback);
        set_search_status('SubHD title page failed — showing search page results instead.', 'red');
    } finally {
        progress.hide();
        searchState.loading = false;
    }
}

function mark_search_result_selected(row){
    const rows = search_results.querySelectorAll(".search_result_item");
    for (const other of rows) {
        other.classList.remove("selected_result");
        other.removeAttribute("aria-current");
    }
    if (row) {
        row.classList.add("selected_result");
        row.setAttribute("aria-current", "true");
    }
}

async function load_search_result(idx, row){
    if (searchState.loading) return;
    const result = searchState.results[idx];
    if (!result) return;
    if (!the_video_element) {
        set_search_status('Please select one of the videos above first.', 'red');
        return;
    }
    set_search_status('', '');
    searchState.loading = true;
    const progress = new ProgressIndicator(search_progress_container, search_block);
    progress.show('Downloading ' + result.pay.kind + ' subtitle...');
    try {
        const key = getDownloadCacheKey(result.pay);
        let file;
        if (key && searchState.downloadCache && searchState.downloadCache.key === key) {
            file = searchState.downloadCache.file;
        } else {
            file = await download_result(result.pay);
            if (key) {
                // [reason] caches the downloaded bytes, not a parsed subtitle: a parse
                // failure is fixed by picking another file, not by re-downloading
                searchState.downloadCache = { key: key, file: file };
                update_cached_icons();
            }
        }
        await apply_result_file(file, progress, { name: result.title, mode: 'results' });
        searchState.loadedKey = getDownloadCacheKey(result.pay);
        if (row && row.isConnected) {
            mark_search_result_selected(row);
        } else {
            render_search_results(searchState.results, searchState.page);
        }
        set_subtitle_source(result.title);
    } catch (error) {
        // a cancelled picker has already reported itself; keep it out of the red path
        if (!error || error.type !== 'SUBTITLE_CHOICE_CANCELLED') {
            console.error('Online subtitle load failed:', error);
            set_search_status(error.message || 'Load failed', 'red');
        }
    } finally {
        progress.hide();
        searchState.loading = false;
    }
}

let serviceKeys = {};
function update_search_key_hint(){
    const missingOpenSubtitles = search_provider.value === "opensubtitles" && !serviceKeys.os_api_key;
    const missingAssrt = search_provider.value === "assrt" && !serviceKeys.assrt_token;
    search_key_hint.hidden = !(missingOpenSubtitles || missingAssrt);
    search_key_hint_text.textContent = missingOpenSubtitles
        ? "OpenSubtitles needs an API key before you can search."
        : missingAssrt
            ? "Shooter needs an assrt token before you can search."
            : "";
}

search_key_settings_button.addEventListener("click", function(){
    activate_tab("settings");
    requestAnimationFrame(function(){
        servicesSection.scrollIntoView({ block: "nearest" });
        os_api_key_input.focus();
    });
});

// Provider change: rebuild language options (each provider only lists languages it can filter)
search_provider.addEventListener("change", function(){
    rebuild_search_language();
    chrome.storage.local.set({
        search_provider: search_provider.value,
        search_language: search_language.value
    });
    update_search_key_hint();
});
rebuild_search_language();

// [reason] SubHD rows are filtered by language at fetch time, so refetch the open
// title instead of leaving stale episode counts under a new language selection
search_language.addEventListener("change", async function(){
    chrome.storage.local.set({
        search_provider: search_provider.value,
        search_language: search_language.value
    });
    const candidate = searchState.subhd.selected;
    if (search_provider.value !== 'subhd' || !candidate || !searchState.subhd.rows.length) return;
    if (searchState.loading) return;
    const view = searchState.view;
    searchState.loading = true;
    const progress = new ProgressIndicator(search_progress_container, search_block);
    progress.show('Loading ' + candidate.title + '...');
    try {
        const rows = await subhd_load_detail(candidate.id, search_language.value);
        enter_subhd_title(candidate, rows);
        if (view && view.kind === 'all') {
            render_subhd_episode(candidate, null);
        } else if (view && view.kind === 'episode' && view.episode
            && rows.some(function(row){ return row.episode === view.episode; })) {
            render_subhd_episode(candidate, view.episode);
        }
    } catch (error) {
        console.error('SubHD language refresh failed:', error);
        set_search_status('SubHD refresh failed — search again to apply the language.', 'red');
    } finally {
        progress.hide();
        searchState.loading = false;
    }
});

// Search
shadow_root.getElementById("search_button").addEventListener("click", async function(event){
    event.preventDefault();
    event.stopPropagation();

    const query = search_query_input.value.trim();
    if (!query) {
        set_search_status('Enter a search term first.', 'red');
        return;
    }
    const provider = search_provider.value;
    const language = search_language.value;
    if ((provider === "opensubtitles" && !serviceKeys.os_api_key) ||
        (provider === "assrt" && !serviceKeys.assrt_token)) {
        update_search_key_hint();
        set_search_status("Add the required service key in Settings, then try again.", "red");
        return;
    }

    // [reason] the archive picker takes over the results area; a new search ends it
    if (searchState.archivePicker) {
        const picker = searchState.archivePicker;
        searchState.archivePicker = null;
        picker.cancel();
    }

    set_search_status('', '');
    const progress = new ProgressIndicator(search_progress_container, search_block);
    progress.show('Searching ' + search_provider.options[search_provider.selectedIndex].text + '...');
    search_button.disabled = true;
    const previous_search = last_search;
    const prior_view = searchState.view;
    const prior_candidate = searchState.subhd.selected;
    try {
        const response = await run_search(provider, query, language);
        const results = Array.isArray(response) ? response : (response.results || []);
        resetSubhdState(searchState, {
            query: query,
            candidates: Array.isArray(response) ? [] : (response.candidates || []),
            fallback: results
        });
        last_search = { provider: provider, query: query, language: language };
        // [reason] a language-only re-search keeps the same titles, so reopen the
        // title/episode the user was on instead of dropping to the picker
        const restore_candidate = isLanguageOnlyChange(previous_search, last_search)
            ? findSearchCandidate(searchState.subhd.candidates, prior_candidate)
            : null;
        if (restore_candidate) {
            const rows = response && response.detail && searchState.subhd.candidates.length === 1
                ? results
                : await subhd_load_detail(restore_candidate.id, language);
            enter_subhd_title(restore_candidate, rows);
            if (prior_view && prior_view.kind === 'all') {
                render_subhd_episode(restore_candidate, null);
            } else if (prior_view && prior_view.kind === 'episode' && prior_view.episode !== null && prior_view.episode !== undefined
                && rows.some(function(row){ return (row.episode || '') === prior_view.episode; })) {
                render_subhd_episode(restore_candidate, prior_view.episode);
            }
        } else if (response && response.detail && searchState.subhd.candidates.length === 1) {
            // single match: skip the title list and open its episodes
            enter_subhd_title(searchState.subhd.candidates[0], results);
        } else if (searchState.subhd.candidates.length > 1) {
            // [reason] search pages mix several titles/seasons; let the user pick rather
            // than guessing, then load only that title's /d/ page
            render_subhd_candidates(searchState.subhd.candidates);
            set_search_status('', '');
        } else {
            searchState.view = { kind: 'search_rows' };
            searchState.path = [{ label: search_provider.options[search_provider.selectedIndex].text }];
            render_search_results(results);
            set_search_status('', '');
        }
    } catch (error) {
        console.error('Online search failed:', error);
        resetSubhdState(searchState);
        searchState.view = { kind: 'search_rows' };
        searchState.path = [{ label: search_provider.options[search_provider.selectedIndex].text }];
        render_search_results([]);
        set_search_status(error.message || 'Search failed', 'red');
    } finally {
        progress.hide();
        search_button.disabled = false;
    }
});

// API keys storage
function update_keys_status(stored){
    const parts = [];
    parts.push('OpenSubtitles: ' + (stored.os_api_key ? 'set' : 'not set'));
    parts.push('assrt: ' + (stored.assrt_token ? 'set' : 'not set'));
    keys_status_elem.textContent = parts.join(' · ');
    keys_status_elem.style.color = '';
}

chrome.storage.local.get([
    'os_api_key',
    'assrt_token',
    'search_provider',
    'search_language'
], function(stored){
    serviceKeys = stored;
    if (stored.os_api_key) os_api_key_input.value = stored.os_api_key;
    if (stored.assrt_token) assrt_token_input.value = stored.assrt_token;
    if (stored.search_provider && SEARCH_LANGS[stored.search_provider]) {
        search_provider.value = stored.search_provider;
        rebuild_search_language();
    }
    if (stored.search_language &&
        Array.from(search_language.options).some(option => option.value === stored.search_language)) {
        search_language.value = stored.search_language;
    }
    update_keys_status(stored);
    update_search_key_hint();
});

// Restore S2T toggle state (default on when unset)
chrome.storage.local.get(['s2t_enabled'], function(stored){
    if (typeof stored.s2t_enabled === 'boolean') {
        chineseConverter.enabled = stored.s2t_enabled;
        s2t_enabled_checkbox.checked = stored.s2t_enabled;
        updateConverterStatus();
    }
});

shadow_root.getElementById("save_keys").addEventListener("click", function(){
    const osKey = os_api_key_input.value.trim();
    const assrtToken = assrt_token_input.value.trim();
    chrome.storage.local.set({ os_api_key: osKey, assrt_token: assrtToken }, function(){
        serviceKeys = { os_api_key: osKey, assrt_token: assrtToken };
        update_keys_status(serviceKeys);
        keys_status_elem.textContent += ' (saved)';
        keys_status_elem.style.color = '#18794e';
        update_search_key_hint();
    });
});

// Prefill search query from page title chain
(function prefill_search_query(){
    const name = detect_video_name();
    if (name) {
        search_query_input.value = name;
        search_hint.textContent = 'Detected from page title: ' + name;
    } else {
        search_hint.textContent = 'Video name not detected, enter search keywords manually.';
    }
})();

})();
