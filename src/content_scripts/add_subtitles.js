import JSZip from 'jszip';
import { Archive } from 'libarchive.js';
import { Converter } from 'opencc-js/cn2t';
const {
    shouldShowExternalSubtitles,
    determineSubtitleRenderer,
    getCueTimes,
    findReplacementVideo,
    getCueSyncError
} = require('../subtitle_logic');

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
    static SUPPORTED_FORMATS = ['srt', 'vtt', 'ass', 'ssa'];
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
    constructor(container) {
        this.container = container;
        this.progressElement = null;
    }
    
    show(message = 'Loading...') {
        if (this.progressElement) {
            this.hide();
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
        loadingBar.className = 'loading-bar';
        
        // Create progress bar fill element
        const loadingFill = document.createElement('div');
        loadingFill.className = 'loading-fill';
        loadingFill.style.width = '0%';
        loadingBar.appendChild(loadingFill);
        
        this.progressElement.appendChild(loadingBar);
        
        this.container.appendChild(this.progressElement);
    }
    
    updateProgress(percent, message) {
        if (!this.progressElement) return;
        
        const fill = this.progressElement.querySelector('.loading-fill');
        const messageEl = this.progressElement.querySelector('.loading-message');
        
        if (fill) fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;
        if (message && messageEl) messageEl.textContent = message;
    }
    
    hide() {
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
    }
    requestAnimationFrame(sync_tab_heights);
}
const tab_bar = document.createElement("div");
tab_bar.id = "tab_bar";
menu.appendChild(tab_bar);
[["main", "Main"], ["search", "Search"], ["settings", "Settings"]].forEach(function(pair){
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = pair[1];
    btn.addEventListener("click", function(){ activate_tab(pair[0]); });
    tab_buttons[pair[0]] = btn;
    tab_bar.appendChild(btn);

    const page = document.createElement("div");
    page.className = "tab_page";
    tab_pages[pair[0]] = page;
    menu.appendChild(page);
});
activate_tab("main");

const tab_page_main = tab_pages.main;
const tab_page_search = tab_pages.search;
const tab_page_settings = tab_pages.settings;

// Use the tallest page for all tabs so switching never resizes the panel.
function sync_tab_heights(){
    const pages = Object.values(tab_pages);
    const visiblePage = pages.find(function(page){ return page.style.display !== "none"; });
    const pageWidth = visiblePage ? visiblePage.getBoundingClientRect().width : 0;
    let maxHeight = 0;

    pages.forEach(function(page){
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
        pages.forEach(function(page){
            page.style.height = Math.ceil(maxHeight) + "px";
        });
    }
}

const line = document.createElement("div");
line.className = "line";

const textNode = document.createTextNode("List of video elements: ");
line.appendChild(textNode);

const refreshButton = document.createElement("button");
refreshButton.id = "refresh_video_list";
refreshButton.textContent = "Refresh List";
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
uploadFileLine.className = "line";
uploadFileLine.appendChild(document.createTextNode("Upload file: "));

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.accept = ".srt,.vtt,.ass,.ssa,.zip,.7z,.rar";
fileInput.id = "subtitle_file_input";
fileInput.autocomplete = "off";
uploadFileLine.appendChild(fileInput);

subtitle_file_fieldset.appendChild(uploadFileLine);

// Create second line: URL input
const urlLine = document.createElement("div");
urlLine.className = "line";
urlLine.appendChild(document.createTextNode("Or from URL (zip/7z/rar supported): "));

const urlInput = document.createElement("input");
urlInput.type = "text";
urlInput.id = "subtitle_url_input";
urlInput.autocomplete = "off";
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
search_input_line.className = "line";
search_input_line.appendChild(document.createTextNode("Search: "));

const search_query_input = document.createElement("input");
search_query_input.type = "text";
search_query_input.id = "search_query_input";
search_query_input.autocomplete = "off";
search_query_input.placeholder = "Movie or release name";
search_input_line.appendChild(search_query_input);

const search_button = document.createElement("button");
search_button.id = "search_button";
search_button.textContent = "Search";
search_input_line.appendChild(search_button);

search_block.appendChild(search_input_line);

// Provider + language line
const search_provider_line = document.createElement("div");
search_provider_line.className = "line";
search_provider_line.appendChild(document.createTextNode("Provider: "));

const search_provider = document.createElement("select");
search_provider.id = "search_provider";
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

search_provider_line.appendChild(document.createTextNode(" Language: "));

const search_language = document.createElement("select");
search_language.id = "search_language";
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

// Results list (scrollable)
const search_results = document.createElement("div");
search_results.id = "search_results";
search_block.appendChild(search_results);

// Status message
const search_status_elem = document.createElement("span");
search_status_elem.id = "search_status";
search_block.appendChild(search_status_elem);

// Progress container (reuses .loading-progress styles)
const search_progress_container = document.createElement("div");
search_progress_container.id = "search_progress_container";
search_block.appendChild(search_progress_container);

// API key settings (live in the Settings tab, no collapsible wrapper)
const os_key_line = document.createElement("div");
os_key_line.className = "line";
os_key_line.appendChild(document.createTextNode("OpenSubtitles API key: "));
const os_api_key_input = document.createElement("input");
os_api_key_input.type = "password";
os_api_key_input.id = "os_api_key";
os_api_key_input.autocomplete = "off";
os_key_line.appendChild(os_api_key_input);
tab_page_settings.appendChild(os_key_line);

const assrt_key_line = document.createElement("div");
assrt_key_line.className = "line";
assrt_key_line.appendChild(document.createTextNode("assrt token: "));
const assrt_token_input = document.createElement("input");
assrt_token_input.type = "password";
assrt_token_input.id = "assrt_token";
assrt_token_input.autocomplete = "off";
assrt_key_line.appendChild(assrt_token_input);
tab_page_settings.appendChild(assrt_key_line);

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
s2t_line.className = "line";
s2t_line.appendChild(document.createTextNode("Simplified → Traditional (S2T): "));
var s2t_enabled_checkbox = document.createElement("input");
s2t_enabled_checkbox.type = "checkbox";
s2t_enabled_checkbox.id = "s2t_enabled";
s2t_enabled_checkbox.checked = true;
s2t_line.appendChild(s2t_enabled_checkbox);
tab_page_settings.appendChild(s2t_line);

tab_page_search.appendChild(search_block);

// Create grid container for settings
const settingsGrid = document.createElement("div");
settingsGrid.id = "settings_grid";

var subtitle_offset_line = document.createElement("div");
subtitle_offset_line.className = "line grid-item";
subtitle_offset_line.appendChild(document.createTextNode("Time offset (s): "));

var subtitle_offset_input = document.createElement("input");
subtitle_offset_input.type = "number";
subtitle_offset_input.step = "0.01";
subtitle_offset_input.id = "subtitle_offset_input";
subtitle_offset_input.value = "0";
subtitle_offset_line.appendChild(subtitle_offset_input);

var position_offset_line = document.createElement("div");
position_offset_line.className = "line grid-item";
position_offset_line.appendChild(document.createTextNode("Position offset (px): "));

var subtitle_offset_top_input = document.createElement("input");
subtitle_offset_top_input.type = "number";
subtitle_offset_top_input.id = "subtitle_offset_top_input";
subtitle_offset_top_input.value = "-100";
position_offset_line.appendChild(subtitle_offset_top_input);

var subtitle_font_size_line = document.createElement("div");
subtitle_font_size_line.className = "line grid-item";
subtitle_font_size_line.appendChild(document.createTextNode("Font size (px): "));

var subtitle_font_size_input = document.createElement("input");
subtitle_font_size_input.type = "number";
subtitle_font_size_input.id = "subtitle_font_size";
subtitle_font_size_input.value = "26";
subtitle_font_size_line.appendChild(subtitle_font_size_input);

var subtitle_font_line = document.createElement("div");
subtitle_font_line.className = "line grid-item";
subtitle_font_line.appendChild(document.createTextNode("Font: "));

var subtitle_font_input = document.createElement("input");
subtitle_font_input.type = "text";
subtitle_font_input.id = "subtitle_font";
subtitle_font_input.value = "Arial";
subtitle_font_line.appendChild(subtitle_font_input);

var subtitle_font_color_line = document.createElement("div");
subtitle_font_color_line.className = "line grid-item";
subtitle_font_color_line.appendChild(document.createTextNode("Font color: "));

var subtitle_font_color_input = document.createElement("input");
subtitle_font_color_input.type = "text";
subtitle_font_color_input.id = "subtitle_font_color";
subtitle_font_color_input.value = "rgba(255, 255, 255, 1)";
subtitle_font_color_line.appendChild(subtitle_font_color_input);

var subtitle_background_color_line = document.createElement("div");
subtitle_background_color_line.className = "line grid-item";
subtitle_background_color_line.appendChild(document.createTextNode("Background color: "));

var subtitle_background_color_input = document.createElement("input");
subtitle_background_color_input.type = "text";
subtitle_background_color_input.id = "subtitle_background_color";
subtitle_background_color_input.value = "rgba(0, 0, 0, 0.7)";
subtitle_background_color_line.appendChild(subtitle_background_color_input);

settingsGrid.appendChild(subtitle_offset_line);

tab_page_main.appendChild(settingsGrid);

// Show/hide the external subtitles (DOM overlay in windowed mode, TextTrack in fullscreen)
const showSubsLine = document.createElement("div");
showSubsLine.className = "line";
showSubsLine.appendChild(document.createTextNode("Show external subtitles: "));
var showExternalCheckbox = document.createElement("input");
showExternalCheckbox.type = "checkbox";
showExternalCheckbox.id = "show_external_subtitles";
showExternalCheckbox.checked = true;
showSubsLine.appendChild(showExternalCheckbox);
tab_page_main.appendChild(showSubsLine);
showExternalCheckbox.addEventListener("change", applySubtitleVisibility);

// Low-frequency appearance controls live in Settings so the Main tab stays compact
const appearanceFieldset = document.createElement("fieldset");
appearanceFieldset.id = "appearance_fieldset";
const appearanceLegend = document.createElement("legend");
appearanceLegend.appendChild(document.createTextNode("Custom subtitle appearance "));
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
        if (type === "keydown" && e.key === "Escape" &&
            appearanceInfoPopover.style.display !== "none") {
            appearanceInfoPopover.style.display = "none";
        }
        e.stopImmediatePropagation();
    }, true);
});

// Add Simplified/Traditional Chinese conversion status display
var converter_status_line = document.createElement("div");
converter_status_line.className = "line";
converter_status_line.id = "converter_status_line";
converter_status_line.appendChild(document.createTextNode("Converter Status: "));

var converter_status_span = document.createElement("span");
converter_status_span.id = "converter_status";
converter_status_span.textContent = "Initializing...";
converter_status_span.style.color = "orange";
converter_status_line.appendChild(converter_status_span);

// Add manual reload button
var reload_converter_button = document.createElement("button");
reload_converter_button.id = "reload_converter";
reload_converter_button.textContent = "Reload Converter";
reload_converter_button.style.marginLeft = "10px";
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
    max-height: 180px;
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
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
}

.search_empty_box {
    border: 1px dashed #ccc;
    border-radius: 4px;
    padding: 8px;
    color: #666;
    text-align: center;
    background-color: #fafafa;
}
`;
shadow.appendChild(style);

// Style applied → measure Main page and equalize the other tabs
requestAnimationFrame(sync_tab_heights);

var globalStyle = document.createElement("style");
globalStyle.textContent = `
.hover_video_element{
    border: 4px solid red;
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
        noVideosDiv.textContent = "No video elements found.";
        
        const lineBreak = document.createElement("br");
        noVideosDiv.appendChild(lineBreak);
        
        const firefoxText = document.createTextNode("Firefox: press Shift + right-click on the video, then select \"This Frame\" > \"Open Frame in New Tab\".");
        noVideosDiv.appendChild(firefoxText);

        const browserLineBreak = document.createElement("br");
        noVideosDiv.appendChild(browserLineBreak);

        const chromeText = document.createTextNode("Chrome: right-click on the video, then select \"Open This Frame in New Tab\".");
        noVideosDiv.appendChild(chromeText);
        
        video_elements_list.appendChild(noVideosDiv);
        sync_tab_heights();
        return;
    }
    for(var i = 0; i < video_elements.length; i++){
        var video_list_item = document.createElement("div");
        video_list_item.className = "video_list_item";
        video_list_item.textContent = video_elements[i].currentSrc;
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
        video_elements_list.append(video_list_item);
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
        errorMessage.style.color = "red";
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
        const archiveMimes = ['application/zip', 'application/x-7z-compressed', 'application/vnd.rar', 'application/x-rar-compressed'];
        const isZip = blob.type === "application/zip" || urlExt === 'zip';
        const isArchive = isZip || FileValidator.ARCHIVE_FORMATS.includes(urlExt) || archiveMimes.includes(blob.type);
        
        if (isZip) {
            await handleZipFile(await blob_to_base64(blob), progressIndicator);
        } else if (isArchive) {
            await handleArchiveFile(blob, progressIndicator);
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
                await handleZipFile(await blob_to_base64(file), progressIndicator);
            } else {
                await handleArchiveFile(file, progressIndicator);
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

async function handleZipFile(base64, progressIndicator) {
    try {
        progressIndicator.updateProgress(30, 'Extracting files...');

        const zip = new JSZip();
        // [reason] hand jszip the base64 string and let it decode itself — its type check
        // uses instanceof and rejects cross-realm ArrayBuffers from Blob.arrayBuffer
        const zipContent = await zip.loadAsync(base64, { base64: true });
        
        progressIndicator.updateProgress(50, 'Searching for subtitle files...');
        
        const files = Object.entries(zipContent.files);
        let subtitle_file = null;
        
        // Support more formats
        const supportedExts = ['srt', 'vtt', 'ass', 'ssa'];
        
        for(const [filename, file] of files){
            if(file.dir) continue; // Skip folders
            
            const extension = filename.split(".").pop().toLowerCase();
            if(supportedExts.includes(extension)){
                subtitle_file = file;
                break;
            }
        }
        
        if(!subtitle_file){
            throw new SubtitleError(
                `No supported subtitle formats found in ZIP file (${supportedExts.join(', ')})`,
                'NO_SUBTITLE_IN_ZIP'
            );
        }
        
        progressIndicator.updateProgress(70, `Extracting ${subtitle_file.name}...`);
        const text = await subtitle_file.async("string");
        
        progressIndicator.updateProgress(90, 'Parsing subtitles...');
        await parse_subtitles(text);
        
    } catch (error) {
        throw new SubtitleError(
            `ZIP file processing failed: ${error.message}`,
            'ZIP_PROCESSING_ERROR',
            { originalError: error }
        );
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

function find_subtitle_file_in_tree(node){
    const supportedExts = ['srt', 'vtt', 'ass', 'ssa'];
    if (node instanceof File) {
        const extension = node.name.split('.').pop().toLowerCase();
        return supportedExts.includes(extension) ? node : null;
    }
    for (const key of Object.keys(node)) {
        const found = find_subtitle_file_in_tree(node[key]);
        if (found) return found;
    }
    return null;
}

async function handleArchiveFile(blob, progressIndicator) {
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
        const subtitle_file = find_subtitle_file_in_tree(files);
        
        if (!subtitle_file) {
            throw new SubtitleError(
                'No supported subtitle formats found in archive (srt, vtt, ass, ssa)',
                'NO_SUBTITLE_IN_ARCHIVE'
            );
        }
        
        progressIndicator.updateProgress(90, 'Parsing subtitles...');
        const text = await subtitle_file.text();
        await parse_subtitles(text);
        
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
    errorElement.style.color = "red";
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

shadow_root.getElementById("subtitle_offset_top_input").addEventListener("input", function(){
    subtitle_offset_top = parseFloat(shadow_root.getElementById("subtitle_offset_top_input").value);
});

shadow_root.getElementById("subtitle_font_size").addEventListener("input", function(){
    subtitle_font_size = this.value;
});

shadow_root.getElementById("subtitle_font_color").addEventListener("input", function(){
    subtitle_font_color = this.value;
});

shadow_root.getElementById("subtitle_background_color").addEventListener("input", function(){
    subtitle_background_color = this.value;
});

shadow_root.getElementById("subtitle_font").addEventListener("input", function(){
    subtitle_font = this.value;
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
            statusElement.style.color = "gray";
            return;
        }
        if (chineseConverter.openccLoaded && chineseConverter.converter) {
            statusElement.textContent = "OpenCC Ready";
            statusElement.style.color = "green";
            return;
        }
        statusElement.textContent = "FAILED: OpenCC Not Available";
        statusElement.style.color = "red";
    } catch (_e) {
        statusElement.textContent = "FAILED: Status Check Error";
        statusElement.style.color = "red";
    }
}

// Simplified reload: ask background to reinject, then refresh status
shadow_root.getElementById("reload_converter").addEventListener("click", function(){
    const statusElement = shadow_root.getElementById("converter_status");
    statusElement.textContent = "Reloading...";
    statusElement.style.color = "orange";
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
                statusElement.style.color = "red";
            });
    } else {
        statusElement.textContent = "Reload Failed";
        statusElement.style.color = "red";
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

// shortcut: subhd mirrors drift and get region-blocked (tv/com flagged "possibly walled"); update this when the site moves
const SUBHD_BASE = "https://subhd.me";
const ASSRT_BASE = "https://api.assrt.net";
const OS_API_BASE = "https://api.opensubtitles.com";
const OS_LANG_CODES = { 'zh-hans':'zh-cn', 'zh-hant':'zh-tw' };

let search_results_cache = [];
let search_result_loading = false;

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
    errorMessage.style.color = text ? "green" : "";
    errorMessage.title = text || "";
}

function set_search_status(text, color){
    search_status_elem.textContent = text;
    search_status_elem.style.color = color || '';
}

// loose language filter for scrape providers listing tags like 简/繁/双语
function scrape_lang_ok(text, language){
    if (language === 'all') return true;
    if (language === 'zh-hans') return /简|CHS|双语|雙語|中[文字]/i.test(text);
    if (language === 'zh-hant') return /繁|CHT|中[文字]/i.test(text);
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
        throw new SubtitleError('OpenSubtitles API key missing — expand "API keys" below, save it, then retry.', 'API_KEY_MISSING');
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
        throw new SubtitleError('assrt token missing — expand "API keys" below, save it, then retry.', 'API_KEY_MISSING');
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

async function search_subhd(query, language){
    const resp = await bg_fetch_text({ url: SUBHD_BASE + '/search/' + encodeURIComponent(query) });
    if (!resp.ok) {
        throw new SubtitleError('SubHD search failed (HTTP ' + resp.status + ')', 'NETWORK_ERROR');
    }
    const doc = new DOMParser().parseFromString(resp.text, 'text/html');
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
        if (results.length >= 30) break;
        const entry = byCode[code];
        if (!entry.text) continue;
        const container = entry.anchor.closest('.row, table, li') || entry.anchor.closest('div') || entry.anchor;
        const context = ((container && container.textContent) || '').slice(0, 800);
        if (!scrape_lang_ok(context, language)) continue;
        const metaParts = Array.from(new Set(context.match(/简体|繁体|英语|双语|SRT|ASS/g) || []));
        results.push({
            title: entry.text,
            meta: metaParts.length ? metaParts.join(' · ') : 'SubHD',
            pay: { kind: 'subhd', id: code, item: SUBHD_BASE + '/a/' + code }
        });
    }
    return results;
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
    const supportedExts = ['srt', 'vtt', 'ass', 'ssa'];
    let chosen = null;
    for (const file of filelist) {
        const name = file.name || file.url || '';
        const ext = name.split('.').pop().toLowerCase();
        if (file.url && supportedExts.indexOf(ext) !== -1) {
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

async function apply_result_file(file, progressIndicator){
    progressIndicator.updateProgress(30, 'Checking file type...');
    const head = base64_head_bytes(file.base64, 6);
    if (head[0] === 0x52 && head[1] === 0x61 && head[2] === 0x72 && head[3] === 0x21) {
        // Rar!
        await handleArchiveFile(base64_to_blob(file.base64), progressIndicator);
    } else if (head[0] === 0x37 && head[1] === 0x7A && head[2] === 0xBC && head[3] === 0xAF && head[4] === 0x27 && head[5] === 0x1C) {
        // 7z: 37 7A BC AF 27 1C
        await handleArchiveFile(base64_to_blob(file.base64), progressIndicator);
    } else if (head[0] === 0x50 && head[1] === 0x4B) {
        await handleZipFile(file.base64, progressIndicator);
    } else {
        progressIndicator.updateProgress(70, 'Parsing subtitles...');
        await parse_subtitles(base64_to_utf8_text(file.base64));
    }
    progressIndicator.updateProgress(100, 'Loaded!');
}

function render_search_results(results){
    search_results_cache = results;
    while (search_results.firstChild) {
        search_results.removeChild(search_results.firstChild);
    }
    if (results.length === 0) {
        const emptyBox = document.createElement("div");
        emptyBox.className = "search_empty_box";
        emptyBox.textContent = "No subtitles found.";
        search_results.appendChild(emptyBox);
        return;
    }
    results.forEach(function(result, idx){
        const row = document.createElement("div");
        row.className = "search_result_item";

        const titleLine = document.createElement("span");
        titleLine.className = "result_title_line";
        titleLine.textContent = result.title;
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
}

function mark_search_result_selected(row){
    const rows = search_results.querySelectorAll(".search_result_item");
    for (const other of rows) {
        other.classList.remove("selected_result");
    }
    if (row) {
        row.classList.add("selected_result");
    }
}

async function load_search_result(idx, row){
    if (search_result_loading) return;
    const result = search_results_cache[idx];
    if (!result) return;
    if (!the_video_element) {
        set_search_status('Please select one of the videos above first.', 'red');
        return;
    }
    set_search_status('', '');
    search_result_loading = true;
    const progress = new ProgressIndicator(search_progress_container);
    progress.show('Downloading ' + result.pay.kind + ' subtitle...');
    try {
        const file = await download_result(result.pay);
        await apply_result_file(file, progress);
        mark_search_result_selected(row);
        set_search_status('Loaded: ' + result.title, 'green');
        set_subtitle_source(result.title);
    } catch (error) {
        console.error('Online subtitle load failed:', error);
        set_search_status(error.message || 'Load failed', 'red');
    } finally {
        progress.hide();
        search_result_loading = false;
    }
}

// Provider change: rebuild language options (each provider only lists languages it can filter)
search_provider.addEventListener("change", rebuild_search_language);
rebuild_search_language();

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

    set_search_status('', '');
    const progress = new ProgressIndicator(search_progress_container);
    progress.show('Searching ' + search_provider.options[search_provider.selectedIndex].text + '...');
    search_button.disabled = true;
    try {
        const results = await run_search(provider, query, language);
        render_search_results(results);
        if (results.length > 0) {
            set_search_status('Found ' + results.length + ' results — click one to load.', 'green');
        } else {
            set_search_status('', '');
        }
    } catch (error) {
        console.error('Online search failed:', error);
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

chrome.storage.local.get(['os_api_key', 'assrt_token'], function(stored){
    if (stored.os_api_key) os_api_key_input.value = stored.os_api_key;
    if (stored.assrt_token) assrt_token_input.value = stored.assrt_token;
    update_keys_status(stored);
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
        update_keys_status({ os_api_key: osKey, assrt_token: assrtToken });
        keys_status_elem.textContent += ' (saved)';
        keys_status_elem.style.color = 'green';
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
