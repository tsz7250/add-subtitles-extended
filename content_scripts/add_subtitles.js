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
        if (!this.SUPPORTED_FORMATS.includes(extension)) {
            throw new SubtitleError(
                `Unsupported file format: .${extension}. Supported formats: ${this.SUPPORTED_FORMATS.join(', ')}`,
                'UNSUPPORTED_FORMAT'
            );
        }
        
        return {
            isLarge: file.size > LARGE_FILE_THRESHOLD,
            format: extension,
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
closeButton.textContent = "Close";
menu.appendChild(closeButton);

const line = document.createElement("div");
line.className = "line";

const textNode = document.createTextNode("List of video elements: ");
line.appendChild(textNode);

const refreshButton = document.createElement("button");
refreshButton.id = "refresh_video_list";
refreshButton.textContent = "Refresh List";
line.appendChild(refreshButton);

menu.appendChild(line);

const video_elements_list = document.createElement("div");
video_elements_list.id = "video_elements_list";
menu.appendChild(video_elements_list);

const make_video_fullscreen = document.createElement("div");
make_video_fullscreen.className = "line";

const make_video_fullscreen_button = document.createElement("button");
make_video_fullscreen_button.id = "make_video_fullscreen";
make_video_fullscreen_button.textContent = "Make video fullscreen";
make_video_fullscreen.appendChild(make_video_fullscreen_button);

menu.appendChild(make_video_fullscreen);

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
fileInput.accept = ".srt,.vtt,.ass,.ssa";
fileInput.id = "subtitle_file_input";
fileInput.autocomplete = "off";
uploadFileLine.appendChild(fileInput);

subtitle_file_fieldset.appendChild(uploadFileLine);

// Create second line: URL input
const urlLine = document.createElement("div");
urlLine.className = "line";
urlLine.appendChild(document.createTextNode("Or from URL (zip supported): "));

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

const errorMessage = document.createElement("span");
errorMessage.id = "upload_error_message";
buttonLine.appendChild(errorMessage);

subtitle_file_fieldset.appendChild(buttonLine);

// Create progress container
const progressContainer = document.createElement("div");
progressContainer.id = "upload_progress_container";
subtitle_file_fieldset.appendChild(progressContainer);

menu.appendChild(subtitle_file_fieldset);

var subtitle_offset_line = document.createElement("div");
subtitle_offset_line.className = "line";
subtitle_offset_line.appendChild(document.createTextNode("Time offset: "));

var subtitle_offset_input = document.createElement("input");
subtitle_offset_input.type = "number";
subtitle_offset_input.step = "0.01";
subtitle_offset_input.id = "subtitle_offset_input";
subtitle_offset_input.value = "0";
subtitle_offset_line.appendChild(subtitle_offset_input);
subtitle_offset_line.appendChild(document.createTextNode(" seconds"));

var position_offset_line = document.createElement("div");
position_offset_line.className = "line";
position_offset_line.appendChild(document.createTextNode("Position offset: "));

var subtitle_offset_top_input = document.createElement("input");
subtitle_offset_top_input.type = "number";
subtitle_offset_top_input.id = "subtitle_offset_top_input";
subtitle_offset_top_input.value = "-100";
position_offset_line.appendChild(subtitle_offset_top_input);
position_offset_line.appendChild(document.createTextNode(" px"));

var subtitle_font_size_line = document.createElement("div");
subtitle_font_size_line.className = "line";
subtitle_font_size_line.appendChild(document.createTextNode("Font size: "));

var subtitle_font_size_input = document.createElement("input");
subtitle_font_size_input.type = "number";
subtitle_font_size_input.id = "subtitle_font_size";
subtitle_font_size_input.value = "26";
subtitle_font_size_line.appendChild(subtitle_font_size_input);
subtitle_font_size_line.appendChild(document.createTextNode(" px"));

var subtitle_font_line = document.createElement("div");
subtitle_font_line.className = "line";
subtitle_font_line.appendChild(document.createTextNode("Font: "));

var subtitle_font_input = document.createElement("input");
subtitle_font_input.type = "text";
subtitle_font_input.id = "subtitle_font";
subtitle_font_input.value = "Arial";
subtitle_font_line.appendChild(subtitle_font_input);

var subtitle_font_color_line = document.createElement("div");
subtitle_font_color_line.className = "line";
subtitle_font_color_line.appendChild(document.createTextNode("Font color: "));

var subtitle_font_color_input = document.createElement("input");
subtitle_font_color_input.type = "text";
subtitle_font_color_input.id = "subtitle_font_color";
subtitle_font_color_input.value = "rgba(255, 255, 255, 1)";
subtitle_font_color_line.appendChild(subtitle_font_color_input);

var subtitle_background_color_line = document.createElement("div");
subtitle_background_color_line.className = "line";
subtitle_background_color_line.appendChild(document.createTextNode("Background color: "));

var subtitle_background_color_input = document.createElement("input");
subtitle_background_color_input.type = "text";
subtitle_background_color_input.id = "subtitle_background_color";
subtitle_background_color_input.value = "rgba(0, 0, 0, 0.7)";
subtitle_background_color_line.appendChild(subtitle_background_color_input);

menu.appendChild(subtitle_offset_line);
menu.appendChild(position_offset_line);
menu.appendChild(subtitle_font_size_line);
menu.appendChild(subtitle_font_line);
menu.appendChild(subtitle_font_color_line);
menu.appendChild(subtitle_background_color_line);

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

menu.appendChild(converter_status_line);

shadow.appendChild(menu);

var style = document.createElement("style");
style.textContent = `
#addsubtitle_menu *{
    font-family: monospace;
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
button{
    cursor: pointer;
}
.line{
    margin-top: 9px;
}
#addsubtitle_menu{
    z-index: 1000000;
    position: fixed;
    right: 14px;
    bottom: 14px;
    width: 430px;
    border: 1px solid black;
    padding-left: 14px;
    padding-right: 16px;
    padding-top: 6px;
    padding-bottom: 12px;
    background-color: white;
    color: black;
}
button{
    background-color: white;
    border: 1px solid black;
    color: black;
    padding: 2px;
}
button:hover{
    background-color: #f0f0f0;
}
button:active{
    background-color: #ddd;
}
input[type="file"]{
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    width: 100%;
}
input:not([type="file"]){
    border: 1px solid black;
    height: 18px;
    width: 200px;
}
#video_elements_list{
    margin-top: 8px;
    padding-top: 8px;
}
.video_list_item{
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    border: 1px solid black;
    margin-top: -1px;
    padding: 3px;
    cursor: pointer;
}
#video_elements_list .selected_video_list, #video_elements_list .hover_video_list{
    border: 2px solid red;
}
#close_button{
    position: absolute;
    top: 12px;
    right: 15px;
}
#no_videos{
    border: 1px solid black;
    padding: 5px;
}
#upload_error_message{
    color: red;
}
`;
shadow.appendChild(style);

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
        
        const frameText = document.createTextNode("If your video is inside and iframe, press shift+right click on it then \"This Frame\" > \"Open Frame in New Tab\"");
        noVideosDiv.appendChild(frameText);
        
        video_elements_list.appendChild(noVideosDiv);
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
            });
        }());
        video_elements_list.append(video_list_item);
    }
}

// Improved: Use modern variable declaration and initialization
let subtitle_offset = parseFloat(shadow_root.getElementById("subtitle_offset_input").value);
let subtitle_offset_top = parseFloat(shadow_root.getElementById("subtitle_offset_top_input").value);

let subtitles = [];
let the_video_element = null;
let video_fullscreen = false; // Add fullscreen state variable

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

// Chinese conversion system - Local OpenCC-JS solution
class ChineseConverter {
    constructor() {
        this.initialized = false;
        this.openccLoaded = false;
        this.converter = null;
        this.initOpenCC();
    }
    
    async initOpenCC() {
        try {
            if (typeof window.OpenCC !== 'undefined' && window.OpenCC.Converter) {
                this.setupOpenCC();
                return;
            }
            await this.waitForOpenCC();
            this.setupOpenCC();
        } catch (_error) {
            this.initialized = true;
        }
    }
    
    waitForOpenCC() {
        return new Promise((resolve, reject) => {
            // If already loaded, return directly
            if (typeof window.OpenCC !== 'undefined' && window.OpenCC.Converter) {
                resolve();
                return;
            }
            
            let attempts = 0;
            const maxAttempts = 100; // 10 seconds with 100ms intervals (reduced from 15s)
            
            // Set check interval
            const checkInterval = setInterval(() => {
                attempts++;
                if (typeof window.OpenCC !== 'undefined' && window.OpenCC.Converter) {
                    clearInterval(checkInterval);
                    clearTimeout(timeout);
                    resolve();
                } else if (attempts >= maxAttempts) {
                    clearInterval(checkInterval);
                    clearTimeout(timeout);
                    reject(new Error('OpenCC load timeout after ' + (maxAttempts * 100) + 'ms'));
                }
            }, 100);
            
            // Timeout after 10 seconds
            const timeout = setTimeout(() => {
                clearInterval(checkInterval);
                reject(new Error('OpenCC load timeout'));
            }, 10000);
        });
    }
    // Manual reload removed in cleanup
    
    setupOpenCC() {
        try {
            // Check browser compatibility
            if (!window.OpenCC || typeof window.OpenCC.Converter !== 'function') {
                throw new Error('OpenCC.Converter is not a function or not available');
            }
            
            // Create Simplified to Traditional Chinese converter using correct API
            this.converter = window.OpenCC.Converter({ from: 'cn', to: 'tw' });
            // Test the converter
            const testResult = this.converter('测试');
            
            // Check if conversion is working
            if (testResult !== '测试') {
                this.openccLoaded = true;
            } else {
                this.openccLoaded = false;
            }
            
            this.initialized = true;
        } catch (error) {
            this.initialized = true;
        }
    }
    
    convert(text) {
        if (!text) return text;
        
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
            hasConverter: !!this.converter
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
    if(subtitles.length == 0) return;
    var t = the_video_element.currentTime;
    var found = -1;
    for(var i = 0; i < subtitles.length; i++){
        if(subtitles[i].begin+subtitle_offset <= t && subtitles[i].end+subtitle_offset >= t){
            found = i;
            break;
        }
    }
    if(found == -1){
        subtitle_element.textContent = "";
    }
    else{
        // Clear subtitle content
        while (subtitle_element.firstChild) {
            subtitle_element.removeChild(subtitle_element.firstChild);
        }
        for(var i = 0; i < subtitles[found].text.length; i++){
            var subtitle_line = document.createElement("div");
            var sanitizedText = allow_tags(xss(subtitles[found].text[i]), allowed_html_tags);
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
            subtitle_line.style.cssText = "font-family: "+subtitle_font+
                ";font-size: "+subtitle_font_size+
                "px;color:"+subtitle_font_color+
                ";background-color:"+subtitle_background_color+";";
            subtitle_element.appendChild(subtitle_line);
            subtitle_element.appendChild(document.createElement("br"));
        }
    }
    subtitle_pos();
}, 100);

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
    var subtitle_height = subtitle_element.getBoundingClientRect().height;
    if(video_fullscreen){
        var sub_pos_top = the_video_element.getBoundingClientRect().top+
                        the_video_element.offsetHeight+
                        subtitle_offset_top-subtitle_height;
        var sub_pos_left = get_offset(the_video_element)[1];
        subtitle_element.style.position = "fixed";
        subtitle_element.style.width = the_video_element.offsetWidth+"px";
        subtitle_element.style.top = sub_pos_top+"px";
        subtitle_element.style.left = sub_pos_left+"px";
    }
    else{
        var the_video_element_height = the_video_element.offsetHeight;
        var the_video_element_top = get_offset(the_video_element)[0];

        var sub_pos_top = the_video_element_height+the_video_element_top+subtitle_offset_top-subtitle_height;
        var sub_pos_left = get_offset(the_video_element)[1];

        subtitle_element.style.position = "absolute";
        subtitle_element.style.width = the_video_element.offsetWidth+"px";
        subtitle_element.style.top = sub_pos_top+"px";
        subtitle_element.style.left = sub_pos_left+"px";
    }
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
    subtitles.length = 0;
    
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
                    subtitles.push({
                        begin: startSec,
                        end: endSec,
                        text: textLines
                    });
                }
            }
        }
    }
    
    // Sort subtitles by time order
    subtitles.sort(function(a, b) {
        return a.begin - b.begin;
    });
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
    return new Promise((resolve) => {
        parse_ass_subtitles(subs);
        resolve([...subtitles]);  // Return copy
    });
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

function switch_fullscreen_video(){
    if(the_video_element == null) {
        console.warn("Cannot enter fullscreen: no video element selected");
        return;
    }

    console.log("Starting fullscreen mode");
    video_fullscreen = true;
    
    // Save video's original parent element and position info for later restoration
    if (!the_video_element._originalParent) {
        the_video_element._originalParent = the_video_element.parentNode;
        the_video_element._originalStyles = {
            position: the_video_element.style.position,
            top: the_video_element.style.top,
            left: the_video_element.style.left,
            width: the_video_element.style.width,
            height: the_video_element.style.height,
            zIndex: the_video_element.style.zIndex,
            display: the_video_element.style.display || "block"
        };
    }

    // Set video element styles first
    the_video_element.style.position = "fixed";
    the_video_element.style.top = "0px";
    the_video_element.style.left = "0px";
    the_video_element.style.zIndex = "99998";
    the_video_element.style.width = "100%";
    the_video_element.style.height = "100%";
    the_video_element.style.display = "block";
    the_video_element.style.visibility = "visible";
    the_video_element.style.opacity = "1";
    
    // Set subtitle element styles
    document.getElementById("subtitle_element").style.zIndex = "99999";
    document.documentElement.style.overflow = "hidden";
    
    // Create or update black background
    var blackBackground;
    if(!document.getElementById("fullscreen_video_black_background")){
        blackBackground = document.createElement("div");
        blackBackground.id = "fullscreen_video_black_background";
        document.body.append(blackBackground);
    } else {
        blackBackground = document.getElementById("fullscreen_video_black_background");
    }
    
    // Set black background styles, ensure z-index is lower than video
    blackBackground.style.backgroundColor = "black";
    blackBackground.style.margin = "0px";
    blackBackground.style.padding = "0px";
    blackBackground.style.position = "fixed";
    blackBackground.style.top = "0px";
    blackBackground.style.left = "0px";
    blackBackground.style.zIndex = "99997";
    blackBackground.style.width = "100%";
    blackBackground.style.height = "100%";
    
    // Temporarily store reference to original parent element
    var originalParent = the_video_element.parentNode;
    
    // Move video element above black background
    document.body.appendChild(the_video_element);
    
    // Create control interface
    createFullscreenControls();
    
    // Request fullscreen and handle errors
    document.documentElement.requestFullscreen().catch(err => {
        console.error("Fullscreen request failed:", err);
        
        // Create error notification element
        var errorMessage = document.createElement("div");
        errorMessage.id = "fullscreen_error_message";
        errorMessage.style.position = "fixed";
        errorMessage.style.bottom = "10px";
        errorMessage.style.left = "50%";
        errorMessage.style.transform = "translateX(-50%)";
        errorMessage.style.backgroundColor = "rgba(255, 0, 0, 0.8)";
        errorMessage.style.color = "white";
        errorMessage.style.padding = "10px";
        errorMessage.style.borderRadius = "5px";
        errorMessage.style.zIndex = "100000";
        errorMessage.style.fontFamily = "Arial, sans-serif";
        errorMessage.style.fontSize = "14px";
        errorMessage.style.textAlign = "center";
        errorMessage.textContent = "Fullscreen request failed. Please try pressing F11 manually or use browser's fullscreen feature";
        
        document.body.appendChild(errorMessage);
        
        // Remove error notification after 5 seconds
        setTimeout(() => {
            if (document.getElementById("fullscreen_error_message")) {
                document.getElementById("fullscreen_error_message").remove();
            }
        }, 5000);
        
        // Even if fullscreen fails, still try to display video with fixed positioning
        adjustVideoPosition();
    });
    
    // Enable keyboard controls
    enableKeyboardControls();
    
    // Improved safety mechanism: only exit when truly detecting fullscreen failure
    // Extend timeout to 5 minutes, giving users enough time to use
    window._fullscreenTimeout = setTimeout(function() {
        // Check if really stuck in abnormal state
        if (video_fullscreen && !document.fullscreenElement) {
            // If marked as fullscreen but not actually in fullscreen state, there might be a problem
            console.warn("Detected abnormal fullscreen state, automatically restoring normal state");
            restoreVideoState();
        } else if (video_fullscreen && document.fullscreenElement) {
            // If everything is normal, continue monitoring
            console.log("Fullscreen state is normal, continue using");
        }
    }, 300000); // Extended to 5 minutes
}

// Create fullscreen control interface
function createFullscreenControls() {
    // Check if control interface already exists
    if (document.getElementById("fullscreen_controls")) {
        return;
    }
    
    // Create control interface container
    var controls = document.createElement("div");
    controls.id = "fullscreen_controls";
    controls.style.cssText = `
        position: fixed;
        bottom: 0;
        left: 0;
        width: 100%;
        background-color: rgba(0, 0, 0, 0.5);
        padding: 10px;
        z-index: 999999;
        color: white;
        font-family: Arial, sans-serif;
        transition: opacity 0.3s;
        opacity: 0;
    `;
    
    // Create control interface content
    // Use DOM methods instead of innerHTML
    // Create time info area
    const timeInfoDiv = document.createElement("div");
    timeInfoDiv.id = "controls_time_info";
    timeInfoDiv.style.marginRight = "15px";
    timeInfoDiv.textContent = "00:00 / 00:00";
    
    // Create play/pause button
    const playPauseDiv = document.createElement("div");
    playPauseDiv.id = "controls_playpause";
    playPauseDiv.style.cursor = "pointer";
    playPauseDiv.style.margin = "0 10px";
    playPauseDiv.textContent = "⏸️";
    
    // Create volume down button
    const volumeDownDiv = document.createElement("div");
    volumeDownDiv.id = "controls_volume_down";
    volumeDownDiv.style.cursor = "pointer";
    volumeDownDiv.style.margin = "0 5px";
    volumeDownDiv.textContent = "🔉";
    
    // Create volume up button
    const volumeUpDiv = document.createElement("div");
    volumeUpDiv.id = "controls_volume_up";
    volumeUpDiv.style.cursor = "pointer";
    volumeUpDiv.style.margin = "0 5px";
    volumeUpDiv.textContent = "🔊";
    
    // Create backward button
    const backwardDiv = document.createElement("div");
    backwardDiv.id = "controls_backward";
    backwardDiv.style.cursor = "pointer";
    backwardDiv.style.margin = "0 5px";
    backwardDiv.textContent = "⏪";
    
    // Create forward button
    const forwardDiv = document.createElement("div");
    forwardDiv.id = "controls_forward";
    forwardDiv.style.cursor = "pointer";
    forwardDiv.style.margin = "0 5px";
    forwardDiv.textContent = "⏩";
    
    // Create wrapper container
    const flexContainer = document.createElement("div");
    flexContainer.style.display = "flex";
    flexContainer.style.justifyContent = "center";
    flexContainer.style.alignItems = "center";
    flexContainer.style.padding = "5px";
    
    // Add all control elements
    flexContainer.appendChild(timeInfoDiv);
    flexContainer.appendChild(playPauseDiv);
    flexContainer.appendChild(volumeDownDiv);
    flexContainer.appendChild(volumeUpDiv);
    flexContainer.appendChild(backwardDiv);
    flexContainer.appendChild(forwardDiv);
    
    // Add container to control interface
    controls.appendChild(flexContainer);
    
    // Add progress bar container
    const progressContainer = document.createElement("div");
    progressContainer.style.marginTop = "5px";
    progressContainer.style.position = "relative";
    progressContainer.style.height = "5px";
    progressContainer.style.backgroundColor = "rgba(255, 255, 255, 0.3)";
    
    // Add progress bar
    const progressBar = document.createElement("div");
    progressBar.id = "controls_progress";
    progressBar.style.position = "absolute";
    progressBar.style.height = "100%";
    progressBar.style.backgroundColor = "rgba(255, 255, 255, 0.8)";
    progressBar.style.width = "0%";
    
    progressContainer.appendChild(progressBar);
    controls.appendChild(progressContainer);
    
    // Add keyboard hints
    const keyboardHints = document.createElement("div");
    keyboardHints.style.textAlign = "center";
    keyboardHints.style.marginTop = "8px";
    keyboardHints.style.fontSize = "12px";
    keyboardHints.textContent = "Keyboard controls: Space=Play/Pause, ←→=Rewind/Fast forward, ↑↓=Volume+/-, Esc=Exit fullscreen";
    
    controls.appendChild(keyboardHints);
    
    // Add to page
    document.body.appendChild(controls);
    
    // Add control events
    document.getElementById("controls_playpause").addEventListener("click", function() {
        togglePlayPause();
    });
    
    document.getElementById("controls_volume_down").addEventListener("click", function() {
        adjustVolume(-0.1);
    });
    
    document.getElementById("controls_volume_up").addEventListener("click", function() {
        adjustVolume(0.1);
    });
    
    document.getElementById("controls_backward").addEventListener("click", function() {
        skipTime(-10);
    });
    
    document.getElementById("controls_forward").addEventListener("click", function() {
        skipTime(10);
    });
    
    // Auto hide/show control interface
    var timeout;
    document.addEventListener("mousemove", function() {
        var controls = document.getElementById("fullscreen_controls");
        if (controls && video_fullscreen) {
            controls.style.opacity = "1";
            clearTimeout(timeout);
            timeout = setTimeout(function() {
                controls.style.opacity = "0";
            }, 3000);
        }
    });
    
    // Initial update of control bar
    updateControlsUI();
    
    // Periodically update control bar
    setInterval(function() {
        if (video_fullscreen && the_video_element) {
            updateControlsUI();
        }
    }, 1000);
}

// Update control interface UI
function updateControlsUI() {
    if (!the_video_element || !video_fullscreen) return;
    
    var timeInfo = document.getElementById("controls_time_info");
    var progress = document.getElementById("controls_progress");
    var playPauseBtn = document.getElementById("controls_playpause");
    
    if (timeInfo && progress && playPauseBtn) {
        // Update time info
        var currentTime = formatTime(the_video_element.currentTime);
        var duration = formatTime(the_video_element.duration);
        timeInfo.textContent = currentTime + " / " + duration;
        
        // Update progress bar
        var progressPercent = (the_video_element.currentTime / the_video_element.duration) * 100;
        progress.style.width = progressPercent + "%";
        
        // Update play/pause button
        playPauseBtn.textContent = the_video_element.paused ? "▶️" : "⏸️";
    }
}

// Format time (seconds -> MM:SS)
function formatTime(seconds) {
    if (isNaN(seconds)) return "00:00";
    
    seconds = Math.floor(seconds);
    var minutes = Math.floor(seconds / 60);
    var remainingSeconds = seconds % 60;
    
    return (minutes < 10 ? "0" : "") + minutes + ":" + 
           (remainingSeconds < 10 ? "0" : "") + remainingSeconds;
}

// Play/pause toggle
function togglePlayPause() {
    if (!the_video_element) return;
    
    if (the_video_element.paused) {
        the_video_element.play();
    } else {
        the_video_element.pause();
    }
    
    updateControlsUI();
}

// Adjust volume
function adjustVolume(delta) {
    if (!the_video_element) return;
    
    var newVolume = Math.max(0, Math.min(1, the_video_element.volume + delta));
    the_video_element.volume = newVolume;
}

// Fast forward/rewind
function skipTime(seconds) {
    if (!the_video_element) return;
    
    the_video_element.currentTime = Math.max(0, 
        Math.min(the_video_element.duration, the_video_element.currentTime + seconds));
    
    updateControlsUI();
}

// Enable keyboard controls
function enableKeyboardControls() {
    // Create and store original keyboard event handler
    if (!window._originalKeydownHandler) {
        window._originalKeydownHandler = document.onkeydown;
    }
    
    // Set new keyboard event handler
    document.onkeydown = function(e) {
        if (video_fullscreen && the_video_element) {
            // Execute corresponding operations based on key presses
            switch (e.key) {
                case " ": // Space key
                    togglePlayPause();
                    e.preventDefault();
                    break;
                case "ArrowLeft": // Left arrow
                    skipTime(-5);
                    e.preventDefault();
                    break;
                case "ArrowRight": // Right arrow
                    skipTime(5);
                    e.preventDefault();
                    break;
                case "ArrowUp": // Up arrow
                    adjustVolume(0.05);
                    e.preventDefault();
                    break;
                case "ArrowDown": // Down arrow
                    adjustVolume(-0.05);
                    e.preventDefault();
                    break;
                case "Escape": // ESC key
                    if (document.fullscreenElement) {
                        document.exitFullscreen().catch(err => {
                            console.error("Exit fullscreen failed:", err);
                        });
                    }
                    e.preventDefault();
                    break;
            }
        } else if (window._originalKeydownHandler) {
            // If not in fullscreen mode, use the original event handler
            return window._originalKeydownHandler.call(document, e);
        }
    };
}

// Restore original keyboard controls
function disableKeyboardControls() {
    // Restore original keyboard event handler
    if (window._originalKeydownHandler) {
        document.onkeydown = window._originalKeydownHandler;
    } else {
        document.onkeydown = null;
    }
}

// New function to restore video element state
function restoreVideoState() {
    console.log("Starting to restore pre-fullscreen state");
    
    // First remove black background to avoid black screen
    var blackBackground = document.getElementById("fullscreen_video_black_background");
    if (blackBackground) {
        blackBackground.remove();
    }
    
    // Remove controls interface
    var controls = document.getElementById("fullscreen_controls");
    if (controls) {
        controls.remove();
    }
    
    // Reset error message (if exists)
    var errorMessage = document.getElementById("fullscreen_error_message");
    if (errorMessage) {
        errorMessage.remove();
    }
    
    // Disable keyboard controls
    disableKeyboardControls();
    
    // Restore video element
    if (the_video_element) {
        // If original style information is saved, use it to restore
        if (the_video_element._originalStyles) {
            // If there's an original parent element, move the video element back to its original position
            if (the_video_element._originalParent && the_video_element.parentNode !== the_video_element._originalParent) {
                the_video_element._originalParent.appendChild(the_video_element);
            }
            
            // First ensure the video element is visible
            the_video_element.style.display = the_video_element._originalStyles.display || "block";
            the_video_element.style.visibility = "visible";
            the_video_element.style.opacity = "1";
            
            // Then restore original styles
            the_video_element.style.position = the_video_element._originalStyles.position;
            the_video_element.style.top = the_video_element._originalStyles.top;
            the_video_element.style.left = the_video_element._originalStyles.left;
            the_video_element.style.width = the_video_element._originalStyles.width;
            the_video_element.style.height = the_video_element._originalStyles.height;
            the_video_element.style.zIndex = the_video_element._originalStyles.zIndex;
            
            // Clear saved original information
            delete the_video_element._originalStyles;
            delete the_video_element._originalParent;
        } else {
            // Use empty string to reset styles (if no original styles saved)
            the_video_element.style.position = "";
            the_video_element.style.top = "";
            the_video_element.style.left = "";
            the_video_element.style.width = "";
            the_video_element.style.height = "";
            the_video_element.style.zIndex = "";
            the_video_element.style.display = "block";
        }
    }
    
    // Reset other styles
    document.documentElement.style.overflow = "";
    document.getElementById("subtitle_element").style.zIndex = "";
    
    console.log("Fullscreen state restored to normal");
    video_fullscreen = false;
    
    // Clear any existing timeout
    if (window._fullscreenTimeout) {
        clearTimeout(window._fullscreenTimeout);
        window._fullscreenTimeout = null;
    }
}

// Helper function to adjust video position when fullscreen fails
function adjustVideoPosition() {
    if (the_video_element == null) return;
    
    // Ensure that even when fullscreen fails, the video can be displayed in fixed positioning mode
    the_video_element.style.position = "fixed";
    the_video_element.style.top = "0px";
    the_video_element.style.left = "0px";
    the_video_element.style.width = "100%";
    the_video_element.style.height = "100%";
    the_video_element.style.zIndex = "99998";
    the_video_element.style.display = "block";
    the_video_element.style.visibility = "visible";
    the_video_element.style.opacity = "1";
}

update_video_elements_list();
shadow_root.getElementById("refresh_video_list").addEventListener("click", function(){
    update_video_elements_list();
});

// Improved: Modern upload handling with error handling, retry mechanism and progress display
shadow_root.getElementById("subtitle_upload_button").addEventListener("click", async function(){
    const subtitle_file_input = shadow_root.getElementById("subtitle_file_input");
    const subtitle_url_input = shadow_root.getElementById("subtitle_url_input");
    const error_message_element = shadow_root.getElementById("upload_error_message");
    const retry_button = shadow_root.getElementById("retry_button");
    const progress_container = shadow_root.getElementById("upload_progress_container");
    
    // Reset error messages and retry button
    error_message_element.textContent = "";
    retry_button.style.display = "none";
    
    // Create progress indicator
    const progressIndicator = new ProgressIndicator(progress_container);
    
    try {
        let fileName = "";
        
        if(subtitle_url_input.value.length > 0){
            await handleUrlUpload(subtitle_url_input.value, progressIndicator);
            fileName = subtitle_url_input.value.split('/').pop() || subtitle_url_input.value;
            subtitle_url_input.value = ""; // Clear URL input after success
        } else {
            const selectedFile = subtitle_file_input.files[0];
            await handleFileUpload(selectedFile, progressIndicator);
            fileName = selectedFile.name;
            // Don't clear file input - keep showing the loaded file name
        }
        
        progressIndicator.hide();
        
        // Show success message with file name
        error_message_element.textContent = `Loaded: ${fileName}`;
        error_message_element.style.color = "green";
        
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
        
        if(blob.type === "application/zip" || url.toLowerCase().endsWith('.zip')){
            await handleZipFile(blob, progressIndicator);
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
async function handleZipFile(blob, progressIndicator) {
    try {
        progressIndicator.updateProgress(30, 'Extracting files...');
        
        const buffer = await blob.arrayBuffer();
        const zip = new JSZip();
        const zipContent = await zip.loadAsync(buffer);
        
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
        if (['NETWORK_ERROR', 'ZIP_PROCESSING_ERROR', 'FILE_READ_ERROR'].includes(error.type)) {
            showRetry = true;
        }
    } else {
        errorMessage = `Loading failed: ${error.message}`;
        showRetry = true;
    }
    
    errorElement.textContent = errorMessage;
    errorElement.style.color = "red";
    
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

shadow_root.getElementById("make_video_fullscreen").addEventListener("click", function(){
    switch_fullscreen_video();
});

shadow_root.getElementById("close_button").addEventListener("click", function(){
    menu.style.display = "none";
});

// Add converter status update functionality
function updateConverterStatus() {
    const statusElement = shadow_root.getElementById("converter_status");
    if (!statusElement) return;
    try {
        if (typeof window.OpenCC !== 'undefined' && typeof window.OpenCC.Converter === 'function') {
            const testConverter = window.OpenCC.Converter({ from: 'cn', to: 'tw' });
            const testResult = testConverter('测试');
            if (testResult !== '测试') {
                statusElement.textContent = "OpenCC Ready";
                statusElement.style.color = "green";
                return;
            }
            statusElement.textContent = "FAILED: OpenCC Not Converting";
            statusElement.style.color = "red";
            return;
        }
        if (typeof window._openccLoadResult !== 'undefined') {
            const code = window._openccLoadResult;
            const ok = (code === 'direct_execute_success' || code === 'direct_success');
            statusElement.textContent = ok ? "OpenCC Ready" : "OpenCC Load Failed";
            statusElement.style.color = ok ? "green" : "red";
        } else {
            statusElement.textContent = "FAILED: OpenCC Not Available";
            statusElement.style.color = "red";
        }
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
    if (typeof browser !== 'undefined' && browser.runtime) {
        browser.runtime.sendMessage({ action: 'reinject_opencc' })
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

// Add smart fullscreen status monitoring
setInterval(function() {
    // Periodically check if fullscreen status is consistent
    if (video_fullscreen) {
        // If we think we're in fullscreen, but actually not in fullscreen state
        if (!document.fullscreenElement) {
            console.log("Detected user has exited fullscreen (possibly pressed ESC key), restoring normal state");
            restoreVideoState();
        }
    }
}, 2000); // Changed to check every 2 seconds, reduced frequency

// Add fullscreen exit event listener
document.addEventListener("fullscreenchange", function() {
    if (!document.fullscreenElement && video_fullscreen) {
        console.log("Fullscreen change event: User exited fullscreen");
        
        // Clear any existing timeout
        if (window._fullscreenTimeout) {
            clearTimeout(window._fullscreenTimeout);
            window._fullscreenTimeout = null;
        }
        
        // Use restore function to handle fullscreen exit
        restoreVideoState();
    }
});

})();