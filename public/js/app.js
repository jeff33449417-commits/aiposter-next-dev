const TOTAL_SECONDS = 15;
const MIN_DURATION_SECONDS = 1;
const PRODUCT_BY_ID = new Map(AI_POSTER_PRODUCTS.map((product) => [product.id, product]));
let selectedProductId = 'p4';
let dynamicMediaId = 0;
let textLayerId = 0;
let mediaLayerId = 0;
let previewPlaybackId = null;
let previewPlaybackStart = 0;
let activeImageEdit = null;
let activeTimelineClip = null;
let appSecurity = { turnstile: { enabled: false, required: false, siteKey: '' } };
let securityConfigPromise = null;
let turnstileScriptPromise = null;
const TURNSTILE_TOKEN_TIMEOUT_MS = 10000;
const EXPORT_FRAME_RATE = 60;
const EXPORT_MAX_LONG_SIDE = 960;
// Export sizing keeps the product's aspect ratio EXACTLY (never distort).
// Lift the short side toward this target for sharper strips, but the long-side
// ceiling wins for extreme ratios (so the short side may end up smaller while
// the aspect stays correct). Below the hard minimum the encoder/decoder fail,
// so such products are refused rather than distorted.
const EXPORT_MIN_SHORT_SIDE = 320;
const EXPORT_MAX_DIMENSION = 4096;
const EXPORT_HARD_MIN_SHORT = 160;
const MAX_VIDEO_UPLOAD_BYTES = 10 * 1024 * 1024;
const PREVIEW_EFFECT_CLASSES = [
    'effect-typewriter',
    'effect-fade-up',
    'effect-mask-reveal',
    'effect-light-sweep',
    'effect-zoom-in',
    'effect-slide-in',
    'effect-rotate-in',
    'effect-fade-out',
    'effect-slide-out',
    'effect-glitch-out',
    'effect-particle',
    'effect-stretch-out',
    'effect-zoom-out',
    'effect-spin-out',
    'effect-wipe-out'
];

function selectedProduct() {
    return PRODUCT_BY_ID.get(selectedProductId) || AI_POSTER_PRODUCTS[0];
}

function screenRatio(product = selectedProduct()) {
    return product.width / Math.max(1, product.height);
}

function fitScreenSize(maxWidth, maxHeight, product = selectedProduct()) {
    const ratio = screenRatio(product);
    if (ratio >= maxWidth / maxHeight) {
        return {
            width: Math.max(1, Math.round(maxWidth)),
            height: Math.max(1, Math.round(maxWidth / ratio))
        };
    }

    return {
        width: Math.max(1, Math.round(maxHeight * ratio)),
        height: Math.max(1, Math.round(maxHeight))
    };
}

function readablePreviewSize(maxWidth, maxHeight, product = selectedProduct(), options = {}) {
    const ratio = screenRatio(product);
    const size = fitScreenSize(maxWidth, maxHeight, product);
    const minWideHeight = options.minWideHeight || 44;
    const maxScrollableWidth = options.maxScrollableWidth || maxWidth;

    if (ratio >= 24 && size.height < minWideHeight) {
        return {
            width: Math.min(Math.round(minWideHeight * ratio), Math.round(maxScrollableWidth)),
            height: minWideHeight
        };
    }

    return size;
}

function exportCanvasSize(product = selectedProduct()) {
    const ratio = screenRatio(product);
    let width = ratio >= 1 ? EXPORT_MAX_LONG_SIDE : EXPORT_MAX_LONG_SIDE * ratio;
    let height = ratio >= 1 ? EXPORT_MAX_LONG_SIDE / ratio : EXPORT_MAX_LONG_SIDE;

    // Aspect-preserving: lift the short side toward the quality target.
    const shortSide = Math.min(width, height);
    if (shortSide > 0 && shortSide < EXPORT_MIN_SHORT_SIDE) {
        const scale = EXPORT_MIN_SHORT_SIDE / shortSide;
        width *= scale;
        height *= scale;
    }

    // Aspect-preserving: never exceed the mobile canvas/decoder ceiling on the
    // long side. For very extreme ratios this pulls the short side back below
    // the target — the aspect stays exact, the frame is just smaller.
    const longSide = Math.max(width, height);
    if (longSide > EXPORT_MAX_DIMENSION) {
        const scale = EXPORT_MAX_DIMENSION / longSide;
        width *= scale;
        height *= scale;
    }

    return {
        width: evenExportDimension(width),
        height: evenExportDimension(height)
    };
}

// An aspect-preserved frame whose short side fell below the encoder/decoder
// minimum (only the most extreme ratios, e.g. 96:1) cannot be exported as a
// single video without distortion. Callers refuse instead of distorting.
function exportSizeIsViable(size) {
    return Math.min(size.width, size.height) >= EXPORT_HARD_MIN_SHORT;
}

function evenExportDimension(value) {
    return Math.max(2, Math.round(value / 2) * 2);
}

function productLabel(product) {
    return `#${product.no} ${product.name}｜${product.size}｜${product.ratio}｜${product.orientation}｜${product.environment}`;
}

function updateProductMeta() {
    const product = selectedProduct();
    const meta = document.getElementById('productSizeMeta');
    if (!meta) return;
    const swipeHint = screenRatio(product) >= 24 ? '｜可左右滑動查看' : '';
    meta.textContent = `${product.size} mm｜${product.ratio}${product.nonRectangular ? '｜矩形預覽為外環展開近似' : ''}${swipeHint}`;
}

function applyScreenPreviewSize() {
    const product = selectedProduct();
    const ratioText = `${product.width} / ${product.height}`;
    const mainMaxWidth = Math.min(860, Math.max(260, window.innerWidth - 72));
    const mainMaxHeight = Math.min(420, Math.max(180, window.innerHeight * 0.38));
    const editorMaxWidth = Math.min(1360, Math.max(260, window.innerWidth - 72));
    const editorMaxHeight = Math.min(500, Math.max(220, window.innerHeight * 0.54));
    const mainSize = readablePreviewSize(mainMaxWidth, mainMaxHeight, product, {
        minWideHeight: 44,
        maxScrollableWidth: mainMaxWidth * 6
    });
    const editorSize = readablePreviewSize(editorMaxWidth, editorMaxHeight, product, {
        minWideHeight: 72,
        maxScrollableWidth: editorMaxWidth * 5
    });

    document.documentElement.style.setProperty('--screen-aspect-ratio', ratioText);
    document.documentElement.style.setProperty('--screen-preview-width', `${mainSize.width}px`);
    document.documentElement.style.setProperty('--screen-preview-height', `${mainSize.height}px`);
    document.documentElement.style.setProperty('--preview-frame-height', `${Math.max(178, mainSize.height + 64)}px`);
    document.documentElement.style.setProperty('--editor-preview-width', `${editorSize.width}px`);
    document.documentElement.style.setProperty('--editor-preview-height', `${editorSize.height}px`);

    document.querySelectorAll('.preview-placeholder').forEach((placeholder) => {
        placeholder.textContent = `${product.name} (${product.size} mm)`;
    });
    updateProductMeta();
    if (activeImageEdit) renderImageEditor();
    updatePreviewPlaceholder();
    requestAnimationFrame(() => {
        document.querySelectorAll('.preview-frame, .editor-preview-frame').forEach((frame) => {
            frame.scrollLeft = Math.max(0, (frame.scrollWidth - frame.clientWidth) / 2);
        });
    });
}

function initializeProductSelector() {
    const select = document.getElementById('productSelect');
    if (!select) return;
    select.innerHTML = AI_POSTER_PRODUCTS.map((product) =>
        `<option value="${product.id}">${productLabel(product)}</option>`
    ).join('');
    select.value = selectedProductId;
    applyScreenPreviewSize();
}

function handleProductChange(productId) {
    if (!PRODUCT_BY_ID.has(productId)) return;
    selectedProductId = productId;
    applyScreenPreviewSize();
    resetViewportZoom(document.getElementById('posterPreview'));
    resetViewportZoom(document.getElementById('imageEditorPreview'));
}

function showFileName(input, labelId) {
    const label = labelId ? document.getElementById(labelId) : input.closest('.content-slot')?.querySelector('.upload-label');
    const file = input.files && input.files[0];
    if (!label) return;

    if (file) {
        if (input.accept === 'video/*' && file.size > MAX_VIDEO_UPLOAD_BYTES) {
            input.value = '';
            label.textContent = '上傳視頻';
            label.classList.remove('has-file');
            alert('影片上傳限制為 10MB，請先壓縮或縮短影片。');
            return;
        }
        label.textContent = file.name;
        label.classList.add('has-file');
        if (input.accept === 'image/*') {
            openImageEditor(input, file);
            return;
        }
        if (input.accept === 'video/*') {
            openVideoEditor(input, file);
            return;
        }
        syncMediaPreview(input.closest('.timeline-clip'));
    } else {
        label.textContent = input.accept === 'image/*' ? '上傳圖片' : '上傳視頻';
        label.classList.remove('has-file');
        syncMediaPreview(input.closest('.timeline-clip'));
    }
}

function entryOptionsHtml() {
    return `
        <option>入場特效</option>
        <option value="effect-typewriter">Typewriter</option>
        <option value="effect-fade-up">Fade Up Characters</option>
        <option value="effect-mask-reveal">Mask Reveal</option>
        <option value="effect-light-sweep">CC Light Sweep</option>
        <option value="effect-zoom-in">Zoom In & Pop</option>
        <option value="effect-slide-in">Slide In</option>
        <option value="effect-rotate-in">Rotate In</option>
        <option value="add-text">在下方增加輸入文字框</option>
        <option value="add-image">在下方增加上傳圖片框</option>
        <option value="add-video">在下方增加上傳視頻框</option>`;
}

function exitOptionsHtml() {
    return `
        <option>出場特效</option>
        <option value="effect-fade-out">Fade Out / Dissolve</option>
        <option value="effect-slide-out">Fly Off / Slide Out</option>
        <option value="effect-glitch-out">Glitch Out</option>
        <option value="effect-particle">Particle Dissolve</option>
        <option value="effect-stretch-out">Stretch Out</option>
        <option value="effect-zoom-out">Zoom Out & Fade</option>
        <option value="effect-spin-out">Spin Out</option>
        <option value="effect-wipe-out">Wipe Out</option>
        <option value="delete-row">刪除本框</option>`;
}

function clipContentHtml(type) {
    if (type === 'text') {
        return `
            <input class="content-input" type="text" placeholder="輸入文字" aria-label="輸入文字">
            <div class="text-tools" aria-label="文字樣式">
                <input class="text-color" type="color" value="#1d2554" title="文字顏色">
                <select class="text-font" title="字型">
                    <option value='"Segoe UI", "Noto Sans TC", sans-serif'>黑體</option>
                    <option value='"Noto Serif TC", "Songti TC", serif'>宋體</option>
                    <option value='"Microsoft JhengHei", "Noto Sans TC", sans-serif'>微軟正黑</option>
                    <option value='"Bradley Hand", "Comic Sans MS", cursive'>手寫</option>
                    <option value='Impact, Haettenschweiler, sans-serif'>Impact</option>
                </select>
                <select class="text-weight" title="文字粗細">
                    <option value="400">細</option>
                    <option value="700">粗</option>
                    <option value="900" selected>黑</option>
                </select>
                <input class="text-size" type="range" value="24" min="8" max="86" step="1" title="字型大小">
            </div>`;
    }

    dynamicMediaId++;
    const isImage = type === 'image';
    const id = `${type}Upload-${dynamicMediaId}`;
    const accept = isImage ? 'image/*' : 'video/*';
    const label = isImage ? '上傳圖片' : '上傳視頻';
    return `
        <input class="upload-input" id="${id}" type="file" accept="${accept}" onchange="showFileName(this)">
        <label class="upload-label" for="${id}">${label}</label>`;
}

function materialRowHtml(type) {
    const label = type === 'text' ? '文字' : type === 'image' ? '圖片' : '視頻';
    return `
        <div class="material-row">
            <select class="effect-select" aria-label="${label}入場特效" onchange="handleEffectSelect(this)">
                ${entryOptionsHtml()}
            </select>
            <div class="clip-lane">
                <div class="content-slot timeline-clip" data-start="0" data-duration="15">
                    <span class="resize-handle resize-left" aria-hidden="true"></span>
                    ${clipContentHtml(type)}
                    <span class="resize-handle resize-right" aria-hidden="true"></span>
                </div>
            </div>
            <select class="effect-select" aria-label="${label}出場特效" onchange="handleEffectSelect(this)">
                ${exitOptionsHtml()}
            </select>
        </div>`;
}

function addMaterialRowAfter(select, type) {
    const row = select.closest('.material-row');
    if (!row) return;

    row.insertAdjacentHTML('afterend', materialRowHtml(type));
    const newRow = row.nextElementSibling;
    const newClip = newRow.querySelector('.timeline-clip');
    setupTimelineClip(newClip);
    setupTextClip(newClip);
    setupMediaClip(newClip);
    setupMaterialRowSelection(newRow);
    setActiveTimelineClip(newClip);
}

function handleEffectSelect(select) {
    const value = select.value;
    const rowClip = select.closest('.material-row')?.querySelector('.timeline-clip');
    if (rowClip) setActiveTimelineClip(rowClip);

    if (value === 'add-text') {
        addMaterialRowAfter(select, 'text');
        select.selectedIndex = 0;
        return;
    }

    if (value === 'add-image') {
        addMaterialRowAfter(select, 'image');
        select.selectedIndex = 0;
        return;
    }

    if (value === 'add-video') {
        addMaterialRowAfter(select, 'video');
        select.selectedIndex = 0;
        return;
    }

    if (value === 'delete-row') {
        const row = select.closest('.material-row');
        const clip = row?.querySelector('.timeline-clip');
        const layer = clip ? getPreviewLayer(clip) : null;
        if (layer) layer.remove();
        if (row) row.remove();
        updatePreviewPlaceholder();
        return;
    }

    if (value.startsWith('effect-')) {
        playSelectedEffect(select);
    }
}

function percentFromSeconds(seconds) {
    return (seconds / TOTAL_SECONDS) * 100;
}

function secondsFromPixels(pixels, laneWidth) {
    return (pixels / laneWidth) * TOTAL_SECONDS;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

const viewportGestureStates = new WeakMap();

function applyViewportTransform(target, state) {
    target.style.setProperty('--preview-zoom', state.scale.toFixed(3));
    target.style.setProperty('--preview-pan-x', `${state.x.toFixed(1)}px`);
    target.style.setProperty('--preview-pan-y', `${state.y.toFixed(1)}px`);
}

function resetViewportZoom(target) {
    const state = viewportGestureStates.get(target);
    if (!state) return;
    state.scale = 1;
    state.x = 0;
    state.y = 0;
    state.pointers.clear();
    state.gesture = null;
    applyViewportTransform(target, state);
}

function setupViewportGestures(target) {
    if (!target || viewportGestureStates.has(target)) return;
    const state = {
        scale: 1,
        x: 0,
        y: 0,
        pointers: new Map(),
        gesture: null
    };
    viewportGestureStates.set(target, state);
    applyViewportTransform(target, state);

    const pointDistance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    const pointCenter = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const editableLayerSelector = '.preview-text-layer, .editor-image-layer, .editor-crop-selection, .editor-crop-handle, .corner-handle, .resize-handle';

    target.addEventListener('pointerdown', (event) => {
        state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (state.pointers.size === 2) {
            const [first, second] = Array.from(state.pointers.values());
            target.dataset.viewportGesture = 'pinch';
            state.gesture = {
                mode: 'pinch',
                distance: pointDistance(first, second),
                center: pointCenter(first, second),
                scale: state.scale,
                x: state.x,
                y: state.y
            };
            event.preventDefault();
            return;
        }

        if (state.pointers.size === 1 && state.scale > 1 && !event.target.closest(editableLayerSelector)) {
            target.dataset.viewportGesture = 'pan';
            state.gesture = {
                mode: 'pan',
                pointerId: event.pointerId,
                x: state.x,
                y: state.y,
                pointerX: event.clientX,
                pointerY: event.clientY
            };
            event.preventDefault();
        }
    }, { capture: true });

    target.addEventListener('pointermove', (event) => {
        if (!state.pointers.has(event.pointerId)) return;
        state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

        if (state.gesture?.mode === 'pinch' && state.pointers.size >= 2) {
            const [first, second] = Array.from(state.pointers.values());
            const center = pointCenter(first, second);
            const nextScale = clamp(state.gesture.scale * (pointDistance(first, second) / Math.max(1, state.gesture.distance)), 1, 5);
            state.scale = nextScale;
            state.x = state.gesture.x + (center.x - state.gesture.center.x);
            state.y = state.gesture.y + (center.y - state.gesture.center.y);
            applyViewportTransform(target, state);
            event.preventDefault();
        } else if (state.gesture?.mode === 'pan' && state.gesture.pointerId === event.pointerId) {
            state.x = state.gesture.x + event.clientX - state.gesture.pointerX;
            state.y = state.gesture.y + event.clientY - state.gesture.pointerY;
            applyViewportTransform(target, state);
            event.preventDefault();
        }
    }, { capture: true });

    const endPointer = (event) => {
        state.pointers.delete(event.pointerId);
        if (state.pointers.size < 2 && state.gesture?.mode === 'pinch') {
            state.gesture = null;
            target.dataset.viewportGesture = '';
        }
        if (state.gesture?.pointerId === event.pointerId) {
            state.gesture = null;
            target.dataset.viewportGesture = '';
        }
    };

    target.addEventListener('pointerup', endPointer, { capture: true });
    target.addEventListener('pointercancel', endPointer, { capture: true });
    target.addEventListener('dblclick', () => {
        if (state.scale > 1) {
            resetViewportZoom(target);
        } else {
            state.scale = 2;
            state.x = 0;
            state.y = 0;
            applyViewportTransform(target, state);
        }
    });
}

function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function parseApiJson(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(text.slice(0, 120) || '伺服器回應格式不正確');
    }
}

async function loadSecurityConfig() {
    if (securityConfigPromise) return securityConfigPromise;

    securityConfigPromise = fetch('/api/me', { cache: 'no-store' })
        .then(parseApiJson)
        .then((data) => {
            appSecurity = data.security || appSecurity;
            return appSecurity;
        })
        .catch((error) => {
            console.warn('Unable to load security config:', error);
            return appSecurity;
        });

    return securityConfigPromise;
}

function loadTurnstileScript() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (turnstileScriptPromise) return turnstileScriptPromise;

    turnstileScriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        script.onload = () => resolve(window.turnstile);
        script.onerror = () => reject(new Error('Turnstile unavailable'));
        document.head.appendChild(script);
    });

    return turnstileScriptPromise;
}

function turnstileHost() {
    let host = document.getElementById('turnstileHost');
    if (!host) {
        host = document.createElement('div');
        host.id = 'turnstileHost';
        host.className = 'turnstile-host';
        document.body.appendChild(host);
    }
    return host;
}

function removeTurnstileHost() {
    document.getElementById('turnstileHost')?.remove();
}

function shouldRunTurnstile(config) {
    return Boolean(config?.enabled && config?.required && config?.siteKey);
}

async function turnstileToken(action) {
    const security = await loadSecurityConfig();
    const config = security?.turnstile || {};
    if (!shouldRunTurnstile(config)) {
        removeTurnstileHost();
        return '';
    }

    let turnstile;
    try {
        turnstile = await loadTurnstileScript();
    } catch (error) {
        console.warn('Turnstile skipped:', error);
        return '';
    }
    const host = turnstileHost();
    host.innerHTML = '';

    return new Promise((resolve, reject) => {
        let widgetId = null;
        let settled = false;
        let timeoutId = null;

        const cleanup = () => {
            window.clearTimeout(timeoutId);
            if (widgetId !== null && turnstile?.remove) {
                try {
                    turnstile.remove(widgetId);
                } catch (error) {
                    console.warn('Turnstile cleanup failed:', error);
                }
            }
        };

        const finish = (type, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (type === 'resolve') {
                resolve(value);
            } else {
                reject(value);
            }
        };

        timeoutId = window.setTimeout(() => {
            finish('resolve', '');
        }, TURNSTILE_TOKEN_TIMEOUT_MS);

        try {
            widgetId = turnstile.render(host, {
                sitekey: config.siteKey,
                execution: 'execute',
                appearance: 'interaction-only',
                action,
                callback: (token) => {
                    finish('resolve', token || '');
                },
                'error-callback': () => {
                    finish('resolve', '');
                },
                'timeout-callback': () => {
                    finish('resolve', '');
                }
            });

            if (widgetId === null || widgetId === undefined) {
                throw new Error('Turnstile unavailable');
            }

            turnstile.execute(host);
        } catch (error) {
            console.warn('Turnstile skipped:', error);
            finish('resolve', '');
        }
    });
}

async function uploadAssetToCloud(fileOrBlob, filename, clip) {
    if (!fileOrBlob) return null;

    const form = new FormData();
    form.append('file', fileOrBlob, filename || fileOrBlob.name || 'asset');
    const token = await turnstileToken('upload');
    if (token) form.append('turnstileToken', token);

    const response = await fetch('/api/assets', {
        method: 'POST',
        body: form
    });
    const data = await parseApiJson(response);
    if (!response.ok || !data.ok) {
        throw new Error(data.message || data.code || '雲端素材上傳失敗');
    }

    if (clip && data.asset) {
        clip.dataset.assetId = data.asset.id;
        clip.dataset.assetUrl = data.asset.downloadUrl;
    }

    return data.asset;
}

async function backupClipAssetToCloud(clip, input) {
    const file = input?.files && input.files[0];
    const label = clip?.querySelector('.upload-label');
    if (!clip || !file) return null;

    const originalLabel = label?.textContent || file.name;
    if (label) label.textContent = `${file.name}｜上傳中`;

    try {
        const asset = await uploadAssetToCloud(file, file.name, clip);
        if (label) {
            label.textContent = `${file.name}｜已備份`;
            label.classList.add('has-file');
        }
        return asset;
    } catch (error) {
        if (label) label.textContent = `${originalLabel}｜雲端未備份`;
        console.warn('Cloud asset upload failed:', error);
        return null;
    }
}

function imageEditStateFromControls() {
    const numberValue = (id) => Number(document.getElementById(id)?.value || 0);
    return {
        crop: {
            left: numberValue('cropLeft'),
            top: numberValue('cropTop'),
            right: numberValue('cropRight'),
            bottom: numberValue('cropBottom')
        },
        box: {
            left: numberValue('imagePosX'),
            top: numberValue('imagePosY'),
            width: numberValue('imageWidth'),
            height: numberValue('imageHeight')
        },
        corners: {
            tl: { x: numberValue('cornerTlX'), y: numberValue('cornerTlY') },
            tr: { x: numberValue('cornerTrX'), y: numberValue('cornerTrY') },
            br: { x: numberValue('cornerBrX'), y: numberValue('cornerBrY') },
            bl: { x: numberValue('cornerBlX'), y: numberValue('cornerBlY') }
        }
    };
}

function clipPathFromState(state) {
    const c = state.corners;
    return `polygon(${c.tl.x}% ${c.tl.y}%, ${c.tr.x}% ${c.tr.y}%, ${c.br.x}% ${c.br.y}%, ${c.bl.x}% ${c.bl.y}%)`;
}

function mediaClipPathFromState(state) {
    const crop = state.crop;
    const c = state.corners;
    const visibleWidth = Math.max(10, 100 - crop.left - crop.right);
    const visibleHeight = Math.max(10, 100 - crop.top - crop.bottom);
    const point = (corner) => ({
        x: crop.left + (corner.x / 100) * visibleWidth,
        y: crop.top + (corner.y / 100) * visibleHeight
    });
    const tl = point(c.tl);
    const tr = point(c.tr);
    const br = point(c.br);
    const bl = point(c.bl);
    return `polygon(${tl.x}% ${tl.y}%, ${tr.x}% ${tr.y}%, ${br.x}% ${br.y}%, ${bl.x}% ${bl.y}%)`;
}

function backgroundFromCrop(state) {
    const crop = state.crop;
    const visibleWidth = Math.max(10, 100 - crop.left - crop.right);
    const visibleHeight = Math.max(10, 100 - crop.top - crop.bottom);
    return {
        size: `${10000 / visibleWidth}% ${10000 / visibleHeight}%`,
        position: `${crop.left}% ${crop.top}%`
    };
}

function applyCropToMediaElement(media, state) {
    if (!media || !state) return;
    const crop = state.crop;
    const visibleWidth = Math.max(10, 100 - crop.left - crop.right);
    const visibleHeight = Math.max(10, 100 - crop.top - crop.bottom);
    media.style.left = `${-(crop.left / visibleWidth) * 100}%`;
    media.style.top = `${-(crop.top / visibleHeight) * 100}%`;
    media.style.width = `${10000 / visibleWidth}%`;
    media.style.height = `${10000 / visibleHeight}%`;
    media.style.clipPath = mediaClipPathFromState(state);
}

function applyImageStateToLayer(layer, state, imageUrl) {
    if (!layer || !state) return;
    const bg = backgroundFromCrop(state);
    layer.style.left = `${state.box.left}%`;
    layer.style.top = `${state.box.top}%`;
    layer.style.width = `${state.box.width}%`;
    layer.style.height = `${state.box.height}%`;
    const visualTarget = layer.querySelector('.editor-image-content') || layer;
    visualTarget.style.backgroundImage = imageUrl ? `url("${imageUrl}")` : visualTarget.style.backgroundImage;
    visualTarget.style.backgroundSize = bg.size;
    visualTarget.style.backgroundPosition = bg.position;
    visualTarget.style.backgroundRepeat = 'no-repeat';
    visualTarget.style.clipPath = clipPathFromState(state);
    visualTarget.style.display = 'block';
    const videoTarget = layer.querySelector('.editor-video-content');
    if (videoTarget) {
        videoTarget.pause?.();
        videoTarget.style.display = 'none';
        videoTarget.removeAttribute('src');
    }
}

function ensureVideoElement(layer) {
    let video = layer?.querySelector('.preview-media-element');
    if (!video && layer) {
        video = document.createElement('video');
        video.className = 'preview-media-element';
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        layer.insertBefore(video, layer.firstChild);
    }
    return video;
}

function applyVideoStateToLayer(layer, state, videoUrl) {
    if (!layer || !state) return;
    layer.style.left = `${state.box.left}%`;
    layer.style.top = `${state.box.top}%`;
    layer.style.width = `${state.box.width}%`;
    layer.style.height = `${state.box.height}%`;
    layer.style.backgroundImage = '';
    const video = layer.id === 'editorImageLayer' ? document.getElementById('editorVideoContent') : ensureVideoElement(layer);
    if (!video) return;
    if (videoUrl && video.src !== videoUrl) video.src = videoUrl;
    video.style.display = 'block';
    applyCropToMediaElement(video, state);
    const imageContent = layer.querySelector('.editor-image-content');
    if (imageContent) imageContent.style.display = 'none';
    video.play?.().catch(() => {});
}

function syncEditorControlsFromState(state) {
    const setValue = (id, value) => {
        const input = document.getElementById(id);
        if (input) input.value = value;
    };
    setValue('cropLeft', state.crop.left);
    setValue('cropTop', state.crop.top);
    setValue('cropRight', state.crop.right);
    setValue('cropBottom', state.crop.bottom);
    setValue('imageWidth', state.box.width);
    setValue('imageHeight', state.box.height);
    setValue('imagePosX', state.box.left);
    setValue('imagePosY', state.box.top);
    setValue('cornerTlX', state.corners.tl.x);
    setValue('cornerTlY', state.corners.tl.y);
    setValue('cornerTrX', state.corners.tr.x);
    setValue('cornerTrY', state.corners.tr.y);
    setValue('cornerBrX', state.corners.br.x);
    setValue('cornerBrY', state.corners.br.y);
    setValue('cornerBlX', state.corners.bl.x);
    setValue('cornerBlY', state.corners.bl.y);
}

function renderImageEditor() {
    if (!activeImageEdit) return;
    activeImageEdit.state = imageEditStateFromControls();
    const layer = document.getElementById('editorImageLayer');
    if (activeImageEdit.mediaType === 'video') {
        applyVideoStateToLayer(layer, activeImageEdit.state, activeImageEdit.videoUrl);
    } else {
        applyImageStateToLayer(layer, activeImageEdit.state, activeImageEdit.imageUrl);
    }
    updateEditorCornerHandles(layer, activeImageEdit.state);
}

function updateEditorCornerHandles(layer, state) {
    if (!layer || !state) return;
    Object.entries(state.corners).forEach(([corner, point]) => {
        const handle = layer.querySelector(`[data-corner="${corner}"]`);
        if (!handle) return;
        handle.style.left = `${point.x}%`;
        handle.style.top = `${point.y}%`;
    });
}

function renderCropSelection(selection) {
    const cropBox = document.getElementById('editorCropSelection');
    if (!cropBox) return;

    if (!selection) {
        cropBox.classList.remove('is-drawing');
        cropBox.style.left = '';
        cropBox.style.top = '';
        cropBox.style.width = '';
        cropBox.style.height = '';
        return;
    }

    cropBox.style.left = `${selection.left}%`;
    cropBox.style.top = `${selection.top}%`;
    cropBox.style.width = `${selection.width}%`;
    cropBox.style.height = `${selection.height}%`;
    cropBox.classList.add('is-drawing');
}

function cropStateFromSelection(baseState, selection) {
    const visibleWidth = Math.max(1, 100 - baseState.crop.left - baseState.crop.right);
    const visibleHeight = Math.max(1, 100 - baseState.crop.top - baseState.crop.bottom);
    const selectionRight = selection.left + selection.width;
    const selectionBottom = selection.top + selection.height;
    const left = clamp(baseState.crop.left + (selection.left / 100) * visibleWidth, 0, 90);
    const top = clamp(baseState.crop.top + (selection.top / 100) * visibleHeight, 0, 90);
    const right = clamp(baseState.crop.right + ((100 - selectionRight) / 100) * visibleWidth, 0, 90 - left);
    const bottom = clamp(baseState.crop.bottom + ((100 - selectionBottom) / 100) * visibleHeight, 0, 90 - top);
    const box = {
        left: clamp(baseState.box.left + (selection.left / 100) * baseState.box.width, 0, 100),
        top: clamp(baseState.box.top + (selection.top / 100) * baseState.box.height, 0, 100),
        width: clamp((selection.width / 100) * baseState.box.width, 8, 100),
        height: clamp((selection.height / 100) * baseState.box.height, 8, 100)
    };

    return {
        ...baseState,
        crop: { left, top, right, bottom },
        box
    };
}

function adjustedCropSelection(selection, edge, dxPercent, dyPercent) {
    const minSize = 3;
    const right = selection.left + selection.width;
    const bottom = selection.top + selection.height;
    const next = { ...selection };

    if (edge === 'left') {
        const left = clamp(selection.left + dxPercent, 0, right - minSize);
        next.left = left;
        next.width = right - left;
    }

    if (edge === 'right') {
        const nextRight = clamp(right + dxPercent, selection.left + minSize, 100);
        next.width = nextRight - selection.left;
    }

    if (edge === 'top') {
        const top = clamp(selection.top + dyPercent, 0, bottom - minSize);
        next.top = top;
        next.height = bottom - top;
    }

    if (edge === 'bottom') {
        const nextBottom = clamp(bottom + dyPercent, selection.top + minSize, 100);
        next.height = nextBottom - selection.top;
    }

    return next;
}

function defaultCropSelection() {
    return {
        left: 12,
        top: 12,
        width: 76,
        height: 76
    };
}

function imageElementFromUrl(imageUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = imageUrl;
    });
}

async function croppedImageUrlFromState(imageUrl, crop) {
    const image = await imageElementFromUrl(imageUrl);
    const sourceWidth = image.naturalWidth || image.width || 1;
    const sourceHeight = image.naturalHeight || image.height || 1;
    const sx = clamp((crop.left / 100) * sourceWidth, 0, sourceWidth - 1);
    const sy = clamp((crop.top / 100) * sourceHeight, 0, sourceHeight - 1);
    const sw = Math.max(1, ((100 - crop.left - crop.right) / 100) * sourceWidth);
    const sh = Math.max(1, ((100 - crop.top - crop.bottom) / 100) * sourceHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw));
    canvas.height = Math.max(1, Math.round(sh));
    const context = canvas.getContext('2d');
    context.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
}

function resetCutButton() {
    const screen = document.getElementById('imageEditorScreen');
    const btn = document.getElementById('cutModeBtn');
    screen?.classList.remove('crop-mode');
    btn?.classList.remove('is-active');
    if (btn) btn.textContent = '切割';
    renderCropSelection(null);
}

function enterCutMode() {
    const screen = document.getElementById('imageEditorScreen');
    const btn = document.getElementById('cutModeBtn');
    if (activeImageEdit && !activeImageEdit.pendingCropSelection) {
        activeImageEdit.pendingCropBaseState = imageEditStateFromControls();
        const layer = document.getElementById('editorImageLayer');
        const preview = document.getElementById('imageEditorPreview');
        const unconstrained = defaultCropSelection();
        activeImageEdit.pendingCropSelection = clampCropSelectionToPreview(unconstrained, layer, preview);
        renderCropSelection(activeImageEdit.pendingCropSelection);
    }
    screen?.classList.add('crop-mode');
    btn?.classList.add('is-active');
    if (btn) btn.textContent = '進行切割';
}

async function applyPendingCutSelection() {
    if (!activeImageEdit?.pendingCropSelection) return false;
    const baseState = activeImageEdit.pendingCropBaseState || imageEditStateFromControls();
    const croppedState = cropStateFromSelection(baseState, activeImageEdit.pendingCropSelection);

    if (activeImageEdit.mediaType === 'video') {
        activeImageEdit.state = croppedState;
        activeImageEdit.pendingCropSelection = null;
        activeImageEdit.pendingCropBaseState = null;
        syncEditorControlsFromState(croppedState);
        renderImageEditor();
        syncActiveVideoEditToPreview(croppedState);
        resetCutButton();
        return true;
    }

    let imageUrl = activeImageEdit.imageUrl;

    try {
        imageUrl = await croppedImageUrlFromState(activeImageEdit.imageUrl, croppedState.crop);
    } catch (error) {
        imageUrl = activeImageEdit.imageUrl;
    }

    const next = {
        ...croppedState,
        crop: { left: 0, top: 0, right: 0, bottom: 0 }
    };
    activeImageEdit.state = next;
    activeImageEdit.imageUrl = imageUrl;
    activeImageEdit.imageSize = await loadImageSize(imageUrl);
    activeImageEdit.pendingCropSelection = null;
    activeImageEdit.pendingCropBaseState = null;
    syncEditorControlsFromState(next);
    renderImageEditor();
    resetCutButton();
    return true;
}

async function openImageEditor(input, file) {
    const clip = input.closest('.timeline-clip');
    const imageUrl = await readFileAsDataUrl(file);
    const imageSize = await loadImageSize(imageUrl);
    const savedState = clip?._editorImageState || clip?._imageEditState || {
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        box: fitImageBoxToEditor(imageSize),
        corners: {
            tl: { x: 0, y: 0 },
            tr: { x: 100, y: 0 },
            br: { x: 100, y: 100 },
            bl: { x: 0, y: 100 }
        }
    };

    activeImageEdit = {
        mediaType: 'image',
        input,
        clip,
        imageUrl,
        imageSize,
        state: savedState,
        pendingCropSelection: null,
        pendingCropBaseState: null
    };
    syncEditorControlsFromState(savedState);
    document.getElementById('mediaEditorTitle').textContent = '圖片編輯';
    document.body.classList.add('image-editing');
    resetViewportZoom(document.getElementById('imageEditorPreview'));
    resetCutButton();
    resetFinishEditButton();
    renderImageEditor();
}

async function openVideoEditor(input, file) {
    const clip = input.closest('.timeline-clip');
    const videoUrl = URL.createObjectURL(file);
    const videoSize = await loadVideoSize(videoUrl);
    const savedState = clip?._editorVideoState || {
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        box: fitImageBoxToEditor(videoSize),
        corners: {
            tl: { x: 0, y: 0 },
            tr: { x: 100, y: 0 },
            br: { x: 100, y: 100 },
            bl: { x: 0, y: 100 }
        }
    };

    activeImageEdit = {
        mediaType: 'video',
        input,
        clip,
        videoUrl,
        videoSize,
        state: savedState,
        pendingCropSelection: null,
        pendingCropBaseState: null
    };
    syncEditorControlsFromState(savedState);
    document.getElementById('mediaEditorTitle').textContent = '視頻編輯';
    document.body.classList.add('image-editing');
    resetViewportZoom(document.getElementById('imageEditorPreview'));
    resetCutButton();
    resetFinishEditButton();
    renderImageEditor();
}

function loadImageSize(imageUrl) {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 });
        image.onerror = () => resolve({ width: 10, height: 1 });
        image.src = imageUrl;
    });
}

function loadVideoSize(videoUrl) {
    return new Promise((resolve) => {
        const video = document.createElement('video');
        video.onloadedmetadata = () => resolve({ width: video.videoWidth || 10, height: video.videoHeight || 1 });
        video.onerror = () => resolve({ width: 10, height: 1 });
        video.src = videoUrl;
    });
}

function fitImageBoxToEditor(imageSize) {
    const preview = document.getElementById('imageEditorPreview');
    const rect = preview?.getBoundingClientRect();
    const previewRatio = rect && rect.height ? rect.width / rect.height : 10;
    const imageRatio = imageSize.width / Math.max(1, imageSize.height);
    const maxWidth = 92;
    const maxHeight = 86;
    let width = maxWidth;
    let height = (width * previewRatio) / imageRatio;

    if (height > maxHeight) {
        height = maxHeight;
        width = (height * imageRatio) / previewRatio;
    }

    return {
        left: (100 - width) / 2,
        top: (100 - height) / 2,
        width,
        height
    };
}

function imageStateForPosterPreview(imageSize) {
    const previewRatio = 10;
    const imageRatio = imageSize.width / Math.max(1, imageSize.height);
    const maxWidth = 92;
    const maxHeight = 82;
    let width = maxWidth;
    let height = (width * previewRatio) / imageRatio;

    if (height > maxHeight) {
        height = maxHeight;
        width = (height * imageRatio) / previewRatio;
    }

    return {
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        box: {
            left: (100 - width) / 2,
            top: (100 - height) / 2,
            width,
            height
        },
        corners: {
            tl: { x: 0, y: 0 },
            tr: { x: 100, y: 0 },
            br: { x: 100, y: 100 },
            bl: { x: 0, y: 100 }
        }
    };
}

function imageStateForPosterPreviewFromEditor(fallbackImageSize, sourceState) {
    const safeFrame = document.querySelector('.editor-safe-frame');
    const layer = document.getElementById('editorImageLayer');
    const safeRect = safeFrame?.getBoundingClientRect();
    const layerRect = layer?.getBoundingClientRect();

    if (!safeRect || !layerRect || !safeRect.width || !safeRect.height) {
        return imageStateForPosterPreview(fallbackImageSize);
    }

    return {
        crop: sourceState?.crop || { left: 0, top: 0, right: 0, bottom: 0 },
        box: {
            left: ((layerRect.left - safeRect.left) / safeRect.width) * 100,
            top: ((layerRect.top - safeRect.top) / safeRect.height) * 100,
            width: (layerRect.width / safeRect.width) * 100,
            height: (layerRect.height / safeRect.height) * 100
        },
        corners: sourceState?.corners || {
            tl: { x: 0, y: 0 },
            tr: { x: 100, y: 0 },
            br: { x: 100, y: 100 },
            bl: { x: 0, y: 100 }
        }
    };
}

function visibleMediaAspectRatio(mediaSize, crop) {
    const visibleWidth = Math.max(1, mediaSize.width * (100 - crop.left - crop.right) / 100);
    const visibleHeight = Math.max(1, mediaSize.height * (100 - crop.top - crop.bottom) / 100);
    return visibleWidth / visibleHeight;
}

function syncActiveVideoEditToPreview(state = imageEditStateFromControls()) {
    if (!activeImageEdit || activeImageEdit.mediaType !== 'video') return;
    const { clip, videoUrl, videoSize } = activeImageEdit;
    if (!clip || !videoUrl || !videoSize) return;

    clip._editorVideoState = state;
    clip._posterVideoState = imageStateForPosterPreviewFromEditor(videoSize, state);
    clip._videoUrl = videoUrl;
    clip._videoAspectRatio = visibleMediaAspectRatio(videoSize, state.crop);

    const layer = getMediaLayer(clip, true);
    applyVideoStateToLayer(layer, clip._posterVideoState, videoUrl);
    if (layer) {
        layer.firstChild.nodeValue = '';
        layer.dataset.fixedRatio = 'true';
        layer.dataset.aspectRatio = String(clip._videoAspectRatio);
    }
    updatePreviewPlaceholder();
}

async function toggleCutMode() {
    if (!activeImageEdit) return;
    if (await applyPendingCutSelection()) return;

    const screen = document.getElementById('imageEditorScreen');
    if (screen?.classList.contains('crop-mode')) {
        activeImageEdit.pendingCropSelection = null;
        activeImageEdit.pendingCropBaseState = null;
        resetCutButton();
        return;
    }

    enterCutMode();
}

function cancelImageEdit() {
    activeImageEdit = null;
    document.body.classList.remove('image-editing');
    resetCutButton();
    resetFinishEditButton();
}

function setFinishEditButtonProcessing() {
    const btn = document.getElementById('finishImageEditBtn');
    if (!btn) return false;
    if (btn.disabled) return false;
    btn.disabled = true;
    btn.classList.add('is-processing');
    btn.textContent = '請稍後';
    return true;
}

function resetFinishEditButton() {
    const btn = document.getElementById('finishImageEditBtn');
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove('is-processing');
    btn.textContent = '編輯完成';
}

async function finishImageEdit() {
    if (!activeImageEdit) return;
    if (!setFinishEditButtonProcessing()) return;

    try {
        await applyPendingCutSelection();
        if (activeImageEdit.mediaType === 'video') {
            await finishVideoEdit();
            return;
        }
        const { clip, input, imageUrl, imageSize } = activeImageEdit;
        const state = imageEditStateFromControls();
        clip._editorImageState = state;
        clip._posterImageState = imageStateForPosterPreviewFromEditor(imageSize);
        clip._imageEditState = clip._posterImageState;
        clip._imageUrl = imageUrl;
        clip._imageAspectRatio = imageSize.width / Math.max(1, imageSize.height);
        syncMediaPreview(clip);
        const layer = getMediaLayer(clip, true);
        applyImageStateToLayer(layer, clip._posterImageState, imageUrl);
        if (layer) {
            layer.firstChild.nodeValue = '';
            layer.dataset.fixedRatio = 'true';
            layer.dataset.aspectRatio = String(clip._imageAspectRatio);
        }
        await backupClipAssetToCloud(clip, input);
        activeImageEdit = null;
        document.body.classList.remove('image-editing');
        resetCutButton();
        resetFinishEditButton();
        updatePreviewPlaceholder();
    } catch (error) {
        resetFinishEditButton();
        alert(`編輯尚未完成：${error.message || '請稍後再試。'}`);
    }
}

async function finishVideoEdit() {
    if (!activeImageEdit) return;
    const { clip, input } = activeImageEdit;
    const state = imageEditStateFromControls();
    syncActiveVideoEditToPreview(state);
    await backupClipAssetToCloud(clip, input);
    activeImageEdit = null;
    document.body.classList.remove('image-editing');
    resetCutButton();
    resetFinishEditButton();
    updatePreviewPlaceholder();
}

function clampCropSelectionToPreview(selection, layer, preview) {
    if (!selection || !layer || !preview) return selection;
    const layerRect = layer.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();

    const pageLeft = layerRect.left + (selection.left / 100) * layerRect.width;
    const pageTop = layerRect.top + (selection.top / 100) * layerRect.height;
    const pageWidth = (selection.width / 100) * layerRect.width;
    const pageHeight = (selection.height / 100) * layerRect.height;

    const clampedPageLeft = clamp(pageLeft, previewRect.left, previewRect.right);
    const clampedPageTop = clamp(pageTop, previewRect.top, previewRect.bottom);
    const clampedPageRight = clamp(pageLeft + pageWidth, previewRect.left, previewRect.right);
    const clampedPageBottom = clamp(pageTop + pageHeight, previewRect.top, previewRect.bottom);

    return {
        left: clamp(((clampedPageLeft - layerRect.left) / Math.max(1, layerRect.width)) * 100, 0, 100),
        top: clamp(((clampedPageTop - layerRect.top) / Math.max(1, layerRect.height)) * 100, 0, 100),
        width: clamp(((clampedPageRight - clampedPageLeft) / Math.max(1, layerRect.width)) * 100, 1, 100),
        height: clamp(((clampedPageBottom - clampedPageTop) / Math.max(1, layerRect.height)) * 100, 1, 100)
    };
}

function setupImageEditorInteractions() {
    const layer = document.getElementById('editorImageLayer');
    const preview = document.getElementById('imageEditorPreview');
    if (!layer || !preview) return;

    let state = null;

    layer.addEventListener('pointerdown', (event) => {
        if (!activeImageEdit) return;
        if (preview.dataset.viewportGesture === 'pinch') return;
        const previewRect = preview.getBoundingClientRect();
        const layerRect = layer.getBoundingClientRect();
        const screen = document.getElementById('imageEditorScreen');
        const isCropMode = screen?.classList.contains('crop-mode');
        const corner = event.target.dataset.corner;
        const resize = event.target.dataset.resize;
        const crop = event.target.dataset.crop;
        const cropEdge = event.target.dataset.cropEdge;
        const editState = imageEditStateFromControls();
        const pendingSelection = activeImageEdit.pendingCropSelection;
        const selectionStartX = clamp(((event.clientX - layerRect.left) / layerRect.width) * 100, 0, 100);
        const selectionStartY = clamp(((event.clientY - layerRect.top) / layerRect.height) * 100, 0, 100);

        if (isCropMode && pendingSelection && !cropEdge) {
            event.preventDefault();
            event.stopPropagation();
            return;
        }

        state = {
            mode: cropEdge ? 'crop-edge' : isCropMode && !pendingSelection && !corner && !resize && !crop ? 'crop-select' : corner ? 'corner' : resize ? 'resize' : crop ? 'crop' : 'move',
            corner,
            resize,
            crop,
            cropEdge,
            pointerId: event.pointerId,
            minBoxSize: event.pointerType === 'touch' ? 12 : 8,
            pointerX: event.clientX,
            pointerY: event.clientY,
            previewWidth: previewRect.width,
            previewHeight: previewRect.height,
            layerLeft: layerRect.left,
            layerTop: layerRect.top,
            layerWidth: layerRect.width,
            layerHeight: layerRect.height,
            selectionStartX,
            selectionStartY,
            selection: null,
            edgeSelection: pendingSelection ? { ...pendingSelection } : null,
            editState
        };

        layer.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
    });

    document.addEventListener('pointermove', (event) => {
        if (!state || event.pointerId !== state.pointerId || !activeImageEdit || preview.dataset.viewportGesture === 'pinch') return;
        const dxPercent = ((event.clientX - state.pointerX) / state.previewWidth) * 100;
        const dyPercent = ((event.clientY - state.pointerY) / state.previewHeight) * 100;
        const next = JSON.parse(JSON.stringify(state.editState));

        if (state.mode === 'move') {
            next.box.left = clamp(state.editState.box.left + dxPercent, -150, 150);
            next.box.top = clamp(state.editState.box.top + dyPercent, -150, 150);
        } else if (state.mode === 'corner') {
            const point = next.corners[state.corner];
            point.x = clamp(state.editState.corners[state.corner].x + dxPercent, 0, 100);
            point.y = clamp(state.editState.corners[state.corner].y + dyPercent, 0, 100);
        } else if (state.mode === 'resize') {
            if (state.resize.includes('e')) {
                next.box.width = clamp(state.editState.box.width + dxPercent, state.minBoxSize, 300);
            }
            if (state.resize.includes('s')) {
                next.box.height = clamp(state.editState.box.height + dyPercent, state.minBoxSize, 300);
            }
        } else if (state.mode === 'crop') {
            const cropDeltaX = ((event.clientX - state.pointerX) / Math.max(1, state.editState.box.width / 100 * state.previewWidth)) * 100;
            const cropDeltaY = ((event.clientY - state.pointerY) / Math.max(1, state.editState.box.height / 100 * state.previewHeight)) * 100;
            if (state.crop === 'left') {
                next.crop.left = clamp(state.editState.crop.left + cropDeltaX, 0, 90 - state.editState.crop.right);
            }
            if (state.crop === 'right') {
                next.crop.right = clamp(state.editState.crop.right - cropDeltaX, 0, 90 - state.editState.crop.left);
            }
            if (state.crop === 'top') {
                next.crop.top = clamp(state.editState.crop.top + cropDeltaY, 0, 90 - state.editState.crop.bottom);
            }
            if (state.crop === 'bottom') {
                next.crop.bottom = clamp(state.editState.crop.bottom - cropDeltaY, 0, 90 - state.editState.crop.top);
            }
        } else if (state.mode === 'crop-select') {
            const previewRect = preview.getBoundingClientRect();
            const clientXClamped = clamp(event.clientX, previewRect.left, previewRect.right);
            const clientYClamped = clamp(event.clientY, previewRect.top, previewRect.bottom);

            const currentX = clamp(((clientXClamped - state.layerLeft) / state.layerWidth) * 100, 0, 100);
            const currentY = clamp(((clientYClamped - state.layerTop) / state.layerHeight) * 100, 0, 100);
            const left = Math.min(state.selectionStartX, currentX);
            const top = Math.min(state.selectionStartY, currentY);
            const width = Math.abs(currentX - state.selectionStartX);
            const height = Math.abs(currentY - state.selectionStartY);

            const unconstrainedSelection = { left, top, width, height };
            state.selection = clampCropSelectionToPreview(unconstrainedSelection, layer, preview);
            renderCropSelection(state.selection);
            event.preventDefault();
            return;
        } else if (state.mode === 'crop-edge') {
            const edgeDeltaX = ((event.clientX - state.pointerX) / state.layerWidth) * 100;
            const edgeDeltaY = ((event.clientY - state.pointerY) / state.layerHeight) * 100;
            const unconstrainedSelection = adjustedCropSelection(state.edgeSelection, state.cropEdge, edgeDeltaX, edgeDeltaY);
            state.selection = clampCropSelectionToPreview(unconstrainedSelection, layer, preview);
            activeImageEdit.pendingCropSelection = state.selection;
            renderCropSelection(state.selection);
            event.preventDefault();
            return;
        }

        activeImageEdit.state = next;
        syncEditorControlsFromState(next);
        renderImageEditor();
        event.preventDefault();
    });

    document.addEventListener('pointerup', (event) => {
        if (!state || event.pointerId !== state.pointerId) return;
        if (state?.mode === 'crop-select') {
            if (state.selection && state.selection.width >= 3 && state.selection.height >= 3) {
                activeImageEdit.pendingCropSelection = state.selection;
                activeImageEdit.pendingCropBaseState = state.editState;
                renderCropSelection(state.selection);
            } else {
                activeImageEdit.pendingCropSelection = null;
                activeImageEdit.pendingCropBaseState = null;
                renderCropSelection(null);
            }
        }
        if (state?.mode === 'crop-edge' && state.selection) {
            activeImageEdit.pendingCropSelection = state.selection;
            activeImageEdit.pendingCropBaseState = state.editState;
            renderCropSelection(state.selection);
        }
        state = null;
    });

    document.addEventListener('pointercancel', (event) => {
        if (!state || event.pointerId !== state.pointerId) return;
        state = null;
    });

    document.querySelectorAll('.image-editor-tools input[type="range"]').forEach((input) => {
        input.addEventListener('input', renderImageEditor);
    });
}

function renderClip(clip) {
    const start = parseFloat(clip.dataset.start) || 0;
    const duration = parseFloat(clip.dataset.duration) || TOTAL_SECONDS;
    clip.style.left = `${percentFromSeconds(start)}%`;
    clip.style.width = `${percentFromSeconds(duration)}%`;
    clip.title = `${start.toFixed(1)}s - ${(start + duration).toFixed(1)}s`;
}

function getTextLayer(clip) {
    const preview = document.getElementById('posterPreview');
    const layerId = clip.dataset.previewLayerId;
    return preview?.querySelector(`[data-layer-id="${layerId}"]`);
}

function getPreviewLayer(clip) {
    return getTextLayer(clip) || getMediaLayer(clip, false);
}

function clearActivePreviewLayer() {
    document.querySelectorAll('.preview-text-layer').forEach((item) => {
        item.classList.remove('active-preview-layer');
    });
    document.getElementById('posterPreview')?.classList.remove('has-active-layer');
}

function clipLayerKind(clip) {
    if (!clip) return 'layer';
    if (clip.querySelector('.content-input')) return 'text';
    const upload = clip.querySelector('.upload-input');
    if (upload?.accept === 'image/*') return 'image';
    if (upload?.accept === 'video/*') return 'video';
    return 'layer';
}

function defaultPreviewBoxForClip(clip) {
    const kind = clipLayerKind(clip);
    const presets = {
        text: { left: 5, top: 18, width: 28, height: 52 },
        image: { left: 36, top: 18, width: 28, height: 52 },
        video: { left: 67, top: 18, width: 28, height: 52 }
    };
    if (presets[kind]) return presets[kind];

    const clips = Array.from(document.querySelectorAll('.timeline-clip'));
    const index = Math.max(0, clips.indexOf(clip));
    return {
        left: 5 + (index % 3) * 31,
        top: 18 + Math.floor(index / 3) * 18,
        width: 28,
        height: 52
    };
}

function applyDefaultPreviewBox(layer, clip) {
    if (!layer || layer.dataset.positioned === 'true') return;
    const box = defaultPreviewBoxForClip(clip);
    layer.style.left = `${box.left}%`;
    layer.style.top = `${clamp(box.top, 4, 100 - box.height)}%`;
    layer.style.width = `${box.width}%`;
    layer.style.height = `${box.height}%`;
    layer.dataset.positioned = 'true';
}

function setActiveTimelineClip(clip, options = {}) {
    if (!clip) return;
    activeTimelineClip = clip;
    document.querySelectorAll('.timeline-clip').forEach((item) => {
        item.classList.toggle('selected-timeline-clip', item === clip);
    });

    let layer = getPreviewLayer(clip);
    if (!layer && options.ensureLayer !== false) {
        layer = prepareClipPreviewLayer(clip);
    }

    clearActivePreviewLayer();
    if (layer) {
        layer.classList.add('active-preview-layer');
        document.getElementById('posterPreview')?.classList.add('has-active-layer');
        setLayerPlaybackVisible(layer, true);
    }
}

function syncActivePreviewLayer() {
    if (!activeTimelineClip) return;
    setActiveTimelineClip(activeTimelineClip, { ensureLayer: false });
}

function updatePreviewPlaceholder() {
    const preview = document.getElementById('posterPreview');
    if (!preview) return;
    const hasVisibleText = Array.from(preview.querySelectorAll('.preview-text-layer')).some((layer) => {
        const hasImage = Boolean(layer.style.backgroundImage && layer.style.backgroundImage !== 'none');
        return layer.textContent.trim() || hasImage;
    });
    preview.classList.toggle('has-text', hasVisibleText);
}

function getRowEffect(row, index) {
    const effects = row ? row.querySelectorAll('.effect-select') : [];
    const value = effects[index]?.value || '';
    return value.startsWith('effect-') ? value : '';
}

function replayLayerEffect(layer, className) {
    if (!layer || !className) return;
    PREVIEW_EFFECT_CLASSES.forEach((item) => layer.classList.remove(item));
    void layer.offsetWidth;
    layer.classList.add(className);
}

function removeLayerEffects(layer) {
    if (!layer) return;
    PREVIEW_EFFECT_CLASSES.forEach((item) => layer.classList.remove(item));
}

function syncTextPreview(clip) {
    const layer = getTextLayer(clip);
    if (!layer) return;

    const input = clip.querySelector('.content-input');
    const color = clip.querySelector('.text-color');
    const font = clip.querySelector('.text-font');
    const weight = clip.querySelector('.text-weight');
    const size = clip.querySelector('.text-size');
    const text = input?.value || '';

    layer.firstChild.nodeValue = text;
    layer.style.color = color?.value || '#1d2554';
    layer.style.fontFamily = font?.value || '"Segoe UI", "Noto Sans TC", sans-serif';
    layer.style.fontWeight = weight?.value || '900';
    layer.style.fontSize = `${clamp(Number(size?.value) || 24, 8, 86)}px`;
    updatePreviewPlaceholder();
}

function setupPreviewLayerDrag(layer) {
    if (!layer || layer.dataset.dragReady === 'true') return;
    layer.dataset.dragReady = 'true';
    let state = null;

    function persistPreviewLayerState() {
        const clip = document.querySelector(`[data-preview-layer-id="${layer.dataset.layerId}"]`);
        if (!clip) return;
        const targetState = clip._posterImageState || clip._posterVideoState || clip._imageEditState;
        if (!targetState) return;
        targetState.box = {
            left: parseFloat(layer.style.left) || targetState.box.left,
            top: parseFloat(layer.style.top) || targetState.box.top,
            width: parseFloat(layer.style.width) || targetState.box.width,
            height: parseFloat(layer.style.height) || targetState.box.height
        };
        if (clip._posterImageState) clip._imageEditState = clip._posterImageState;
    }

    layer.addEventListener('pointerdown', (event) => {
        const preview = layer.closest('.poster-preview');
        if (!preview) return;
        if (preview.dataset.viewportGesture === 'pinch') return;
        const clip = document.querySelector(`[data-preview-layer-id="${layer.dataset.layerId}"]`);
        if (clip) setActiveTimelineClip(clip, { ensureLayer: false });

        const rect = preview.getBoundingClientRect();
        const layerRect = layer.getBoundingClientRect();
        const isResize = Boolean(event.target.closest('.preview-layer-resize'));

        state = {
            mode: isResize ? 'resize' : 'move',
            pointerId: event.pointerId,
            minWidth: event.pointerType === 'touch' ? 36 : 24,
            minHeight: event.pointerType === 'touch' ? 28 : 18,
            pointerX: event.clientX,
            pointerY: event.clientY,
            previewWidth: rect.width,
            previewHeight: rect.height,
            left: layerRect.left - rect.left,
            top: layerRect.top - rect.top,
            width: layerRect.width,
            height: layerRect.height
        };

        layer.setPointerCapture?.(event.pointerId);
        event.preventDefault();
        event.stopPropagation();
    });

    document.addEventListener('pointermove', (event) => {
        if (!state || event.pointerId !== state.pointerId || layer.closest('.poster-preview')?.dataset.viewportGesture === 'pinch') return;
        const dx = event.clientX - state.pointerX;
        const dy = event.clientY - state.pointerY;

        if (state.mode === 'move') {
            const nextLeft = clamp(state.left + dx, 0, state.previewWidth - state.width);
            const nextTop = clamp(state.top + dy, 0, state.previewHeight - state.height);
            layer.style.left = `${(nextLeft / state.previewWidth) * 100}%`;
            layer.style.top = `${(nextTop / state.previewHeight) * 100}%`;
        } else {
            let nextWidth = clamp(state.width + dx, state.minWidth, state.previewWidth - state.left);
            let nextHeight = clamp(state.height + dy, state.minHeight, state.previewHeight - state.top);
            if (layer.dataset.fixedRatio === 'true') {
                const ratio = Number(layer.dataset.aspectRatio) || (state.width / Math.max(1, state.height));
                nextHeight = clamp(nextWidth / ratio, state.minHeight, state.previewHeight - state.top);
            }
            layer.style.width = `${(nextWidth / state.previewWidth) * 100}%`;
            layer.style.height = `${(nextHeight / state.previewHeight) * 100}%`;
        }
        persistPreviewLayerState();

        event.preventDefault();
    });

    document.addEventListener('pointerup', (event) => {
        if (!state || event.pointerId !== state.pointerId) return;
        state = null;
    });

    document.addEventListener('pointercancel', (event) => {
        if (!state || event.pointerId !== state.pointerId) return;
        state = null;
    });
}

function getMediaLayer(clip, shouldCreate = true) {
    if (!clip || clip.querySelector('.content-input')) return null;
    const preview = document.getElementById('posterPreview');
    if (!preview) return null;

    const existingId = clip.dataset.previewLayerId;
    if (existingId) {
        const existing = preview.querySelector(`[data-layer-id="${existingId}"]`);
        if (existing) return existing;
    }

    if (!shouldCreate) return null;

    mediaLayerId++;
    const layerId = `media-layer-${mediaLayerId}`;
    clip.dataset.previewLayerId = layerId;

    const layer = document.createElement('div');
    layer.className = 'preview-text-layer preview-media-layer';
    layer.dataset.layerId = layerId;
    layer.append(document.createTextNode(''));
    applyDefaultPreviewBox(layer, clip);

    const resizeHandle = document.createElement('span');
    resizeHandle.className = 'preview-layer-resize';
    resizeHandle.setAttribute('aria-hidden', 'true');
    layer.append(resizeHandle);

    preview.append(layer);
    setupPreviewLayerDrag(layer);
    syncMediaPreview(clip);
    syncActivePreviewLayer();
    return layer;
}

function syncMediaPreview(clip) {
    if (!clip || clip.querySelector('.content-input')) return;
    const layer = getMediaLayer(clip, true);
    const input = clip.querySelector('.upload-input');
    const label = clip.querySelector('.upload-label');
    if (!layer || !input || !label) return;

    const file = input.files && input.files[0];
    const isImage = input.accept === 'image/*';
    const isVideo = input.accept === 'video/*';
    layer.classList.toggle('preview-image-layer', isImage);
    layer.classList.toggle('preview-video-layer', isVideo);
    layer.style.backgroundImage = '';

    if (isImage && clip._imageUrl) {
        const existingVideo = layer.querySelector('.preview-media-element');
        if (existingVideo) {
            existingVideo.pause?.();
            existingVideo.remove();
        }
        const previewState = clip._posterImageState || clip._imageEditState;
        applyImageStateToLayer(layer, previewState, clip._imageUrl);
        layer.dataset.fixedRatio = 'true';
        if (clip._imageAspectRatio) {
            layer.dataset.aspectRatio = String(clip._imageAspectRatio);
        }
        layer.firstChild.nodeValue = '';
    } else if (isVideo && clip._videoUrl) {
        const previewState = clip._posterVideoState || clip._editorVideoState;
        applyVideoStateToLayer(layer, previewState, clip._videoUrl);
        layer.dataset.fixedRatio = 'true';
        if (clip._videoAspectRatio) {
            layer.dataset.aspectRatio = String(clip._videoAspectRatio);
        }
        layer.firstChild.nodeValue = '';
    } else if (file && isImage) {
        layer.style.backgroundImage = `url("${URL.createObjectURL(file)}")`;
        layer.firstChild.nodeValue = '';
    } else {
        layer.firstChild.nodeValue = file?.name || (isImage ? '圖片' : '視頻');
    }

    updatePreviewPlaceholder();
    syncActivePreviewLayer();
}

function setupMediaClip(clip) {
    if (!clip || clip.querySelector('.content-input') || clip.dataset.mediaReady === 'true') return;
    clip.dataset.mediaReady = 'true';
    clip.querySelector('.upload-input')?.addEventListener('change', () => syncMediaPreview(clip));
}

function preserveLayerBox(layer, action) {
    if (!layer) return action();
    const box = {
        left: layer.style.left,
        top: layer.style.top,
        width: layer.style.width,
        height: layer.style.height
    };
    const result = action();
    layer.style.left = box.left;
    layer.style.top = box.top;
    layer.style.width = box.width;
    layer.style.height = box.height;
    return result;
}

function playSelectedEffect(select) {
    const clip = select.closest('.material-row')?.querySelector('.timeline-clip');
    if (!clip) return;

    let layer = getPreviewLayer(clip);
    if (!layer && clip.querySelector('.content-input')) {
        setupTextClip(clip);
        layer = getTextLayer(clip);
    }
    if (!layer) layer = getMediaLayer(clip, true);
    if (!layer) return;

    if (clip.querySelector('.content-input')) {
        const input = clip.querySelector('.content-input');
        const originalText = input.value;
        if (!originalText) layer.firstChild.nodeValue = input.placeholder || '文字';
        preserveLayerBox(layer, () => syncTextPreview(clip));
        if (!originalText) layer.firstChild.nodeValue = input.placeholder || '文字';
    } else {
        preserveLayerBox(layer, () => syncMediaPreview(clip));
    }

    replayLayerEffect(layer, select.value);
    updatePreviewPlaceholder();

    window.setTimeout(() => {
        layer.classList.remove(select.value);
        if (clip.querySelector('.content-input') && !clip.querySelector('.content-input').value) {
            layer.firstChild.nodeValue = '';
            updatePreviewPlaceholder();
        }
    }, 1050);
}

function prepareClipPreviewLayer(clip) {
    if (!clip) return null;
    let layer = getPreviewLayer(clip);

    if (clip.querySelector('.content-input')) {
        setupTextClip(clip);
        layer = getTextLayer(clip);
        preserveLayerBox(layer, () => syncTextPreview(clip));
        const input = clip.querySelector('.content-input');
        if (layer && !input.value) layer.firstChild.nodeValue = input.placeholder || '文字';
    } else {
        setupMediaClip(clip);
        layer = getMediaLayer(clip, true);
        preserveLayerBox(layer, () => syncMediaPreview(clip));
    }

    return layer;
}

function setLayerPlaybackVisible(layer, visible) {
    if (!layer) return;
    layer.classList.toggle('playback-hidden', !visible);
}

function updateTimelinePreviewFrame(now) {
    const elapsedSeconds = ((now - previewPlaybackStart) / 1000) % TOTAL_SECONDS;
    const playhead = document.getElementById('timelinePlayhead');
    if (playhead) {
        playhead.style.left = `${percentFromSeconds(elapsedSeconds)}%`;
    }

    document.querySelectorAll('.timeline-clip').forEach((clip) => {
        const layer = prepareClipPreviewLayer(clip);
        if (!layer) return;

        const row = clip.closest('.material-row');
        const start = parseFloat(clip.dataset.start) || 0;
        const duration = parseFloat(clip.dataset.duration) || TOTAL_SECONDS;
        const end = start + duration;
        const isVisible = elapsedSeconds >= start && elapsedSeconds <= end;
        const localTime = elapsedSeconds - start;
        const phase = clip.dataset.playbackPhase || '';

        if (!isVisible) {
            setLayerPlaybackVisible(layer, false);
            removeLayerEffects(layer);
            clip.dataset.playbackPhase = 'hidden';
            return;
        }

        setLayerPlaybackVisible(layer, true);

        const entryEffect = getRowEffect(row, 0);
        const exitEffect = getRowEffect(row, 1);
        const effectWindow = Math.min(1, Math.max(0.25, duration / 3));

        if (entryEffect && localTime <= effectWindow && phase !== 'entry') {
            replayLayerEffect(layer, entryEffect);
            clip.dataset.playbackPhase = 'entry';
            return;
        }

        if (exitEffect && end - elapsedSeconds <= effectWindow && phase !== 'exit') {
            replayLayerEffect(layer, exitEffect);
            clip.dataset.playbackPhase = 'exit';
            return;
        }

        if (localTime > effectWindow && end - elapsedSeconds > effectWindow && phase !== 'steady') {
            removeLayerEffects(layer);
            clip.dataset.playbackPhase = 'steady';
        }
    });

    previewPlaybackId = requestAnimationFrame(updateTimelinePreviewFrame);
}

function startTimelinePreview() {
    const preview = document.getElementById('posterPreview');
    const btn = document.getElementById('previewBtn');
    const ruler = document.querySelector('.timeline-ruler');
    const playhead = document.getElementById('timelinePlayhead');
    preview?.classList.add('preview-playback');
    ruler?.classList.add('is-playing');
    if (playhead) playhead.style.left = '0%';
    btn?.classList.add('is-playing');
    if (btn) btn.innerText = '停止';

    document.querySelectorAll('.timeline-clip').forEach((clip) => {
        clip.dataset.playbackPhase = '';
        const layer = prepareClipPreviewLayer(clip);
        setLayerPlaybackVisible(layer, false);
    });

    updatePreviewPlaceholder();
    previewPlaybackStart = performance.now();
    previewPlaybackId = requestAnimationFrame(updateTimelinePreviewFrame);
}

function stopTimelinePreview() {
    const preview = document.getElementById('posterPreview');
    const btn = document.getElementById('previewBtn');
    const ruler = document.querySelector('.timeline-ruler');
    const playhead = document.getElementById('timelinePlayhead');
    if (previewPlaybackId) cancelAnimationFrame(previewPlaybackId);
    previewPlaybackId = null;

    preview?.classList.remove('preview-playback');
    ruler?.classList.remove('is-playing');
    if (playhead) playhead.style.left = '0%';
    btn?.classList.remove('is-playing');
    if (btn) btn.innerText = '預覽';

    document.querySelectorAll('.timeline-clip').forEach((clip) => {
        clip.dataset.playbackPhase = '';
        const layer = getPreviewLayer(clip);
        if (!layer) return;
        setLayerPlaybackVisible(layer, true);
        removeLayerEffects(layer);
        if (clip.querySelector('.content-input')) {
            syncTextPreview(clip);
        } else {
            syncMediaPreview(clip);
        }
    });

    updatePreviewPlaceholder();
}

function toggleTimelinePreview() {
    if (previewPlaybackId) {
        stopTimelinePreview();
    } else {
        startTimelinePreview();
    }
}

function setupTextClip(clip) {
    if (!clip || !clip.querySelector('.content-input') || clip.dataset.textReady === 'true') return;
    clip.dataset.textReady = 'true';

    textLayerId++;
    const layerId = `text-layer-${textLayerId}`;
    clip.dataset.previewLayerId = layerId;

    const layer = document.createElement('div');
    layer.className = 'preview-text-layer';
    layer.dataset.layerId = layerId;
    layer.append(document.createTextNode(''));
    applyDefaultPreviewBox(layer, clip);

    const resizeHandle = document.createElement('span');
    resizeHandle.className = 'preview-layer-resize';
    resizeHandle.setAttribute('aria-hidden', 'true');
    layer.append(resizeHandle);

    document.getElementById('posterPreview')?.append(layer);
    setupPreviewLayerDrag(layer);

    clip.querySelectorAll('.content-input, .text-color, .text-font, .text-weight, .text-size').forEach((control) => {
        control.addEventListener('input', () => syncTextPreview(clip));
        control.addEventListener('change', () => syncTextPreview(clip));
    });

    syncTextPreview(clip);
    syncActivePreviewLayer();
}

function setupTimelineClip(clip) {
    if (!clip || clip.dataset.initialized === 'true') return;
    clip.dataset.initialized = 'true';
    renderClip(clip);

    const selectClip = () => setActiveTimelineClip(clip);
    clip.addEventListener('focusin', selectClip);
    clip.addEventListener('pointerdown', selectClip);

    let dragState = null;

    let suppressNextClick = false;

    function beginInteraction(event, mode) {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        setActiveTimelineClip(clip);
        const lane = clip.closest('.clip-lane');
        const laneWidth = lane.getBoundingClientRect().width;
        const start = parseFloat(clip.dataset.start) || 0;
        const duration = parseFloat(clip.dataset.duration) || TOTAL_SECONDS;

        dragState = {
            mode,
            pointerId: event.pointerId,
            pointerType: event.pointerType,
            laneWidth,
            pointerStartX: event.clientX,
            start,
            duration,
            active: mode !== 'move' || event.pointerType === 'touch'
        };

        if (dragState.active) {
            clip.classList.add('dragging');
            event.preventDefault();
        }
        clip.setPointerCapture?.(event.pointerId);
        event.stopPropagation();
    }

    clip.querySelector('.resize-left').addEventListener('pointerdown', (event) => {
        beginInteraction(event, 'resize-left');
    });

    clip.querySelector('.resize-right').addEventListener('pointerdown', (event) => {
        beginInteraction(event, 'resize-right');
    });

    clip.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.resize-handle')) return;
        if (event.target.closest('.text-tools, input, select, button, label')) return;
        beginInteraction(event, 'move');
    });

    clip.addEventListener('click', (event) => {
        if (!suppressNextClick) return;
        suppressNextClick = false;
        event.preventDefault();
        event.stopPropagation();
    }, true);

    document.addEventListener('pointermove', (event) => {
        if (!dragState || event.pointerId !== dragState.pointerId) return;

        const deltaPixels = event.clientX - dragState.pointerStartX;
        const activationThreshold = dragState.pointerType === 'touch' ? 1 : 4;
        if (!dragState.active && Math.abs(deltaPixels) < activationThreshold) return;

        if (!dragState.active) {
            dragState.active = true;
            suppressNextClick = true;
            clip.classList.add('dragging');
            if (document.activeElement && typeof document.activeElement.blur === 'function') {
                document.activeElement.blur();
            }
        }

        event.preventDefault();

        const deltaSeconds = secondsFromPixels(deltaPixels, dragState.laneWidth);
        let nextStart = dragState.start;
        let nextDuration = dragState.duration;

        if (dragState.mode === 'move') {
            nextStart = clamp(dragState.start + deltaSeconds, 0, TOTAL_SECONDS - dragState.duration);
        }

        if (dragState.mode === 'resize-left') {
            const fixedEnd = dragState.start + dragState.duration;
            nextStart = clamp(dragState.start + deltaSeconds, 0, fixedEnd - MIN_DURATION_SECONDS);
            nextDuration = fixedEnd - nextStart;
        }

        if (dragState.mode === 'resize-right') {
            const fixedStart = dragState.start;
            const nextEnd = clamp(fixedStart + dragState.duration + deltaSeconds, fixedStart + MIN_DURATION_SECONDS, TOTAL_SECONDS);
            nextDuration = nextEnd - fixedStart;
        }

        clip.dataset.start = nextStart.toFixed(2);
        clip.dataset.duration = nextDuration.toFixed(2);
        renderClip(clip);
    });

    function endInteraction(event) {
        if (!dragState || event.pointerId !== dragState.pointerId) return;
        dragState = null;
        clip.classList.remove('dragging');
    }

    document.addEventListener('pointerup', endInteraction);
    document.addEventListener('pointercancel', endInteraction);
}

function setupMaterialRowSelection(row) {
    if (!row || row.dataset.selectionReady === 'true') return;
    row.dataset.selectionReady = 'true';
    const selectClip = () => {
        const clip = row.querySelector('.timeline-clip');
        if (clip) setActiveTimelineClip(clip);
    };
    row.querySelectorAll('.effect-select').forEach((select) => {
        select.addEventListener('focus', selectClip);
        select.addEventListener('pointerdown', selectClip);
    });
}

document.querySelectorAll('.timeline-clip').forEach(setupTimelineClip);
document.querySelectorAll('.timeline-clip').forEach(setupMediaClip);
document.querySelectorAll('.timeline-clip').forEach(prepareClipPreviewLayer);
document.querySelectorAll('.material-row').forEach(setupMaterialRowSelection);
setupImageEditorInteractions();

const exportAssetCache = new Map();
const exportJobs = new Map();
const exportJobPollers = new Map();
let activeJobCountdownSeconds = null;
let activeJobCountdownInterval = null;

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function escapeText(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[char]);
}

function exportStatusLabel(status) {
    const labels = {
        uploading: '準備 MP4 素材',
        creating_job: '建立 MP4 工作',
        queued: '排隊中',
        processing: 'H.265 轉檔中',
        waiting_renderer: '等待轉檔服務',
        completed: '已完成',
        failed: '失敗'
    };
    return labels[status] || status || '未知';
}

function exportJobMessage(job) {
    const message = job?.message || job?.error_message || job?.errorMessage || '';
    if (/防機器人驗證|Turnstile/i.test(message)) return '';
    return message ? message.replace(/\s+/g, ' ').slice(0, 80) : '';
}

function formatQueueEta(seconds) {
    const value = Number(seconds || 0);
    if (!Number.isFinite(value) || value <= 0) return '即將完成';
    if (value >= 60) {
        const m = Math.floor(value / 60);
        const s = value % 60;
        return `約 ${m} 分 ${s} 秒`;
    }
    return `約 ${value} 秒`;
}

function exportQueueMessage(job) {
    const queue = job?.queue;
    if (!queue || !['queued', 'processing', 'waiting_renderer'].includes(job?.status)) return '';
    const position = Number(queue.position || 0);
    const eta = formatQueueEta(queue.estimatedSeconds);
    if (job.status === 'processing') {
        return eta ? `正在轉檔，${eta}` : '正在轉檔';
    }
    if (position > 0) {
        return `排隊第 ${position} 位${eta ? `，${eta}` : ''}`;
    }
    return eta ? `排隊中，${eta}` : '排隊中';
}

function jobSourceAssetUrl(job) {
    return job?.sourceAssetUrl || job?.input?.settings?.sourceAssetUrl || '';
}

function jobOutputUrl(job) {
    return job?.outputUrl || '';
}

function jobOutputFilename(job) {
    return job?.outputFilename || `${job?.id || 'ai_poster'}_60frame_h265.mp4`;
}

async function downloadJobOutput(jobId) {
    const job = exportJobs.get(jobId);
    const outputUrl = jobOutputUrl(job);
    if (!outputUrl) return;
    const filename = jobOutputFilename(job).replace(/\.html$/i, '').replace(/\.mp4$/i, '') + '.mp4';
    try {
        const downloadLink = document.createElement('a');
        downloadLink.href = outputUrl;
        downloadLink.download = filename;
        downloadLink.rel = 'noopener';
        downloadLink.style.display = 'none';
        document.body.appendChild(downloadLink);
        downloadLink.click();
        downloadLink.remove();
    } catch (error) {
        window.location.assign(outputUrl);
        upsertExportJob({
            ...job,
            errorMessage: error.message || '下載失敗，請稍後再試。'
        });
    }
}

function renderExportJobs() {
    const panel = document.getElementById('exportJobsPanel');
    if (!panel) return;

    const jobs = Array.from(exportJobs.values()).slice(0, 1);
    panel.classList.toggle('has-jobs', jobs.length > 0);
    panel.innerHTML = jobs.map((job) => {
        const title = job.status === 'completed' 
            ? '您的廣告影片已製作完成！' 
            : job.status === 'failed' 
                ? '影片輸出失敗' 
                : '系統正在為您處理廣告影片...';
                
        const statusLabel = exportStatusLabel(job.status);
        const hasQueue = job.queue && ['queued', 'processing', 'waiting_renderer'].includes(job.status);
        const isCompleted = job.status === 'completed';
        const isFailed = job.status === 'failed';
        
        let positionText = '';
        let etaText = '';
        let progressPercent = 0;
        
        if (hasQueue) {
            const position = Number(job.queue.position || 0);
            if (job.status === 'processing') {
                positionText = '正在為您進行 H.265 60fps 硬體加速轉檔...';
                progressPercent = 65;
            } else if (position > 0) {
                positionText = `排隊第 ${position} 位 (前面有 ${position - 1} 個任務等待中)`;
                progressPercent = Math.max(10, Math.min(40, 50 - position * 10));
            } else {
                positionText = '正在佇列中等待...';
                progressPercent = 10;
            }
            
            etaText = formatQueueEta(activeJobCountdownSeconds !== null ? activeJobCountdownSeconds : Number(job.queue.estimatedSeconds));
        }

        return `
            <article class="export-job">
                <div class="export-job-header">
                    <span class="export-job-title">${escapeText(title)}</span>
                    <span class="export-status-badge ${escapeText(job.status)}">${escapeText(statusLabel)}</span>
                </div>
                
                ${hasQueue ? `
                <div class="export-job-progress-wrapper">
                    <div class="export-job-progress-bar">
                        <div class="export-job-progress-fill ${escapeText(job.status)}" style="width: ${progressPercent}%"></div>
                    </div>
                </div>
                <div class="export-job-details">
                    <span class="export-job-position">${escapeText(positionText)}</span>
                    <span class="export-job-eta">🕒 剩餘時間：<span class="eta-countdown">${escapeText(etaText)}</span></span>
                </div>
                ` : ''}
                
                ${isCompleted ? `
                <div class="export-job-success-actions">
                    <button class="export-link-btn" type="button" onclick="downloadJobOutput('${escapeText(job.id)}')">
                        📥 下載 H.265 MP4
                    </button>
                    <span class="download-hint">手機下載後請至 Safari 下載項目或「檔案」App 查看。</span>
                </div>
                ` : ''}
                
                ${isFailed ? `
                <div class="export-job-error">
                    <strong>錯誤原因：</strong>${escapeText(exportJobMessage(job)) || '未知錯誤，請重新提交。'}
                </div>
                ` : ''}
            </article>
        `;
    }).join('');
}

function upsertExportJob(job) {
    if (!job?.id) return;
    exportJobs.delete(job.id);
    exportJobs.set(job.id, job);
    const ordered = Array.from(exportJobs.values()).slice(-1);
    exportJobs.clear();
    ordered.reverse().forEach((item) => exportJobs.set(item.id, item));
    
    // Manage active countdown timer
    const activeJob = ordered[0];
    if (activeJob && ['queued', 'processing', 'waiting_renderer'].includes(activeJob.status)) {
        const queueSeconds = activeJob.queue?.estimatedSeconds;
        if (queueSeconds !== undefined && queueSeconds !== null) {
            if (activeJobCountdownSeconds === null || Math.abs(activeJobCountdownSeconds - Number(queueSeconds)) > 5) {
                activeJobCountdownSeconds = Number(queueSeconds);
            }
            if (!activeJobCountdownInterval) {
                activeJobCountdownInterval = setInterval(() => {
                    if (activeJobCountdownSeconds !== null && activeJobCountdownSeconds > 0) {
                        activeJobCountdownSeconds--;
                        const etaSpan = document.querySelector('.eta-countdown');
                        if (etaSpan) {
                            etaSpan.textContent = formatQueueEta(activeJobCountdownSeconds);
                        }
                    } else {
                        clearInterval(activeJobCountdownInterval);
                        activeJobCountdownInterval = null;
                        activeJobCountdownSeconds = null;
                    }
                }, 1000);
            }
        }
    } else {
        if (activeJobCountdownInterval) {
            clearInterval(activeJobCountdownInterval);
            activeJobCountdownInterval = null;
        }
        activeJobCountdownSeconds = null;
    }

    renderExportJobs();
}

async function loadExportJobs() {
    try {
        const response = await fetch('/api/jobs');
        const data = await parseApiJson(response);
        if (!response.ok || !data.ok) return;
        exportJobs.clear();
        (data.jobs || []).slice(0, 1).reverse().forEach(upsertExportJob);
        renderExportJobs();
    } catch (error) {
        console.warn('Unable to load export jobs:', error);
    }
}

function pollExportJob(jobId) {
    if (!jobId || exportJobPollers.has(jobId)) return;

    const expiresAt = Date.now() + 30 * 60 * 1000;
    let poller = null;
    const stopPolling = () => {
        if (poller) clearInterval(poller);
        exportJobPollers.delete(jobId);
    };

    const pollOnce = async () => {
        try {
            const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
            const data = await parseApiJson(response);
            if (response.ok && data.ok && data.job) {
                upsertExportJob(data.job);
                if (['completed', 'failed', 'waiting_renderer'].includes(data.job.status)) {
                    stopPolling();
                }
            }
        } catch (error) {
            console.warn('Unable to poll export job:', error);
        }

        if (Date.now() >= expiresAt) {
            stopPolling();
            renderExportJobs();
        }
    };

    poller = setInterval(pollOnce, 5000);

    exportJobPollers.set(jobId, poller);
    pollOnce();
}

function loadExportImage(src) {
    if (exportAssetCache.has(src)) return exportAssetCache.get(src).promise;
    const entry = { image: null, promise: null };
    entry.promise = new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
            entry.image = image;
            resolve(image);
        };
        image.onerror = reject;
        image.src = src;
    });
    exportAssetCache.set(src, entry);
    return entry.promise;
}

function loadedExportImage(src) {
    return exportAssetCache.get(src)?.image || null;
}

async function prepareExportImages(clips) {
    const urls = Array.from(new Set(
        clips
            .map((clip) => clip._imageUrl)
            .filter(Boolean)
    ));
    await Promise.all(urls.map((url) => loadExportImage(url)));
}

const exportDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Layers whose `.playback-hidden` we temporarily clear for the duration of an
// export so their on-screen <video> stays rendered. Mobile browsers (Android
// Chrome especially) will not decode frames from a visibility:hidden video, so
// drawImage() of it produces a blank frame.
let exportHiddenLayers = [];

// Pause the live export videos and restore the visibility we changed.
function endExportVideos() {
    document.querySelectorAll('.timeline-clip').forEach((clip) => {
        if (clip._exportVideo) {
            try { clip._exportVideo.pause(); } catch (error) {}
            clip._exportVideo = null;
        }
    });
    exportHiddenLayers.forEach((layer) => layer.classList.add('playback-hidden'));
    exportHiddenLayers = [];
}

function waitForVideoFrame(video, timeout = 160) {
    if (!video) return Promise.resolve();
    return new Promise((resolve) => {
        let requestId = null;
        const cleanup = () => {
            clearTimeout(timer);
            if (requestId && video.cancelVideoFrameCallback) {
                video.cancelVideoFrameCallback(requestId);
            }
            video.removeEventListener('seeked', cleanup);
            video.removeEventListener('loadeddata', cleanup);
            video.removeEventListener('timeupdate', cleanup);
            resolve();
        };
        const timer = setTimeout(cleanup, timeout);
        if (video.requestVideoFrameCallback) {
            requestId = video.requestVideoFrameCallback(cleanup);
        }
        video.addEventListener('seeked', cleanup, { once: true });
        video.addEventListener('loadeddata', cleanup, { once: true });
        video.addEventListener('timeupdate', cleanup, { once: true });
    });
}

function percentBoxForLayer(layer, clip) {
    const state = clip?._posterImageState || clip?._posterVideoState || clip?._imageEditState;
    if (state?.box) return state.box;
    return {
        left: parseFloat(layer.style.left) || 0,
        top: parseFloat(layer.style.top) || 0,
        width: parseFloat(layer.style.width) || 100,
        height: parseFloat(layer.style.height) || 100
    };
}

function clipRectForCanvas(layer, canvas, previewRect, scaleX, scaleY, clip) {
    const percentBox = percentBoxForLayer(layer, clip);
    if (Number.isFinite(percentBox.left) && Number.isFinite(percentBox.top) && Number.isFinite(percentBox.width) && Number.isFinite(percentBox.height)) {
        return {
            x: canvas.width * percentBox.left / 100,
            y: canvas.height * percentBox.top / 100,
            width: canvas.width * percentBox.width / 100,
            height: canvas.height * percentBox.height / 100
        };
    }

    const rect = layer.getBoundingClientRect();
    return {
        x: (rect.left - previewRect.left) * scaleX,
        y: (rect.top - previewRect.top) * scaleY,
        width: rect.width * scaleX,
        height: rect.height * scaleY
    };
}

function exportLayerRank(clip) {
    if (clip.querySelector('.content-input')) return 3;
    if (clip.querySelector('.upload-input')?.accept === 'image/*') return 2;
    if (clip.querySelector('.upload-input')?.accept === 'video/*') return 1;
    return 0;
}

function createExportFrameLayout(canvas) {
    const preview = document.getElementById('posterPreview');
    const previewRect = preview.getBoundingClientRect();
    const scaleX = canvas.width / previewRect.width;
    const scaleY = canvas.height / previewRect.height;
    const clips = Array.from(document.querySelectorAll('.timeline-clip')).sort((a, b) => exportLayerRank(a) - exportLayerRank(b));
    const items = clips.map((clip) => {
        const layer = prepareClipPreviewLayer(clip);
        if (!layer) return null;
        const box = clipRectForCanvas(layer, canvas, previewRect, scaleX, scaleY, clip);
        return {
            clip,
            layer,
            box,
            start: parseFloat(clip.dataset.start) || 0,
            duration: parseFloat(clip.dataset.duration) || TOTAL_SECONDS
        };
    }).filter(Boolean);
    return { scaleY, items };
}

function exportEffectOpacity(clip, elapsedSeconds) {
    const row = clip.closest('.material-row');
    const start = parseFloat(clip.dataset.start) || 0;
    const duration = parseFloat(clip.dataset.duration) || TOTAL_SECONDS;
    const localTime = elapsedSeconds - start;
    const remaining = start + duration - elapsedSeconds;
    const effectWindow = Math.min(1, Math.max(0.25, duration / 3));
    
    let opacity = 1;
    let offsetX = 0;
    let offsetY = 0;
    let scaleX = 1;
    let scaleY = 1;
    let rotate = 0;
    let typewriterProgress = undefined;
    let clipLeftToRight = undefined;
    let clipFromCenter = undefined;
    let lightSweepProgress = undefined;
    let glitchOffset = undefined;
    let particleProgress = undefined;

    const entryEffect = getRowEffect(row, 0);
    const exitEffect = getRowEffect(row, 1);

    if (entryEffect && localTime <= effectWindow) {
        const progress = clamp(localTime / effectWindow, 0, 1);
        if (entryEffect === 'effect-typewriter') {
            typewriterProgress = progress;
            clipLeftToRight = progress;
        } else if (entryEffect === 'effect-fade-up') {
            opacity = progress;
            offsetY = (1 - progress) * 18;
        } else if (entryEffect === 'effect-mask-reveal') {
            opacity = progress;
            clipFromCenter = progress;
        } else if (entryEffect === 'effect-light-sweep') {
            lightSweepProgress = progress;
        } else if (entryEffect === 'effect-zoom-in') {
            opacity = progress;
            scaleX = progress;
            scaleY = progress;
        } else if (entryEffect === 'effect-slide-in') {
            opacity = progress;
            offsetX = -(1 - progress) * 40;
        } else if (entryEffect === 'effect-rotate-in') {
            opacity = progress;
            scaleX = progress;
            scaleY = progress;
            rotate = -(1 - progress) * Math.PI;
        }
    }

    if (exitEffect && remaining <= effectWindow) {
        const progress = clamp(remaining / effectWindow, 0, 1);
        if (exitEffect === 'effect-fade-out') {
            opacity *= progress;
        } else if (exitEffect === 'effect-slide-out') {
            opacity *= progress;
            offsetX = (1 - progress) * 40; // slide right
        } else if (exitEffect === 'effect-glitch-out') {
            opacity *= (progress < 0.2 && Math.random() < 0.5 ? 0 : progress);
            glitchOffset = (Math.random() - 0.5) * 15 * (1 - progress);
        } else if (exitEffect === 'effect-particle') {
            particleProgress = progress;
            opacity *= progress;
        } else if (exitEffect === 'effect-stretch-out') {
            opacity *= progress;
            scaleX = progress;
        } else if (exitEffect === 'effect-zoom-out') {
            opacity *= progress;
            scaleX = progress;
            scaleY = progress;
        } else if (exitEffect === 'effect-spin-out') {
            opacity *= progress;
            scaleX = progress;
            scaleY = progress;
            rotate = (1 - progress) * 2 * Math.PI;
        } else if (exitEffect === 'effect-wipe-out') {
            opacity *= progress;
            clipLeftToRight = progress;
        }
    }

    return {
        opacity,
        offsetX,
        offsetY,
        scaleX,
        scaleY,
        rotate,
        typewriterProgress,
        clipLeftToRight,
        clipFromCenter,
        lightSweepProgress,
        glitchOffset,
        particleProgress
    };
}

function applyClipEffects(ctx, box, effect) {
    // Opacity
    ctx.globalAlpha = ctx.globalAlpha * effect.opacity;
    
    // Translation (Offset)
    ctx.translate(effect.offsetX || 0, effect.offsetY || 0);
    
    // Glitch Offset
    if (effect.glitchOffset) {
        ctx.translate(effect.glitchOffset, 0);
    }
    
    // Rotation
    if (effect.rotate !== undefined && effect.rotate !== 0) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        ctx.translate(cx, cy);
        ctx.rotate(effect.rotate);
        ctx.translate(-cx, -cy);
    }
    
    // Scaling (Stretch Out)
    if (effect.scaleX !== 1 || effect.scaleY !== 1) {
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        ctx.translate(cx, cy);
        ctx.scale(effect.scaleX, effect.scaleY);
        ctx.translate(-cx, -cy);
    }
    
    // Typewriter / Left-to-right wipe on image/video
    if (effect.clipLeftToRight !== undefined) {
        ctx.beginPath();
        ctx.rect(box.x, box.y, box.width * effect.clipLeftToRight, box.height);
        ctx.clip();
    }
    
    // Center expansion Mask Reveal
    if (effect.clipFromCenter !== undefined) {
        const p = effect.clipFromCenter;
        const w = box.width * p;
        const h = box.height * p;
        const x = box.x + (box.width - w) / 2;
        const y = box.y + (box.height - h) / 2;
        ctx.beginPath();
        ctx.rect(x, y, w, h);
        ctx.clip();
    }
    
    // Particle Dissolve (Vertical stripes cut)
    if (effect.particleProgress !== undefined) {
        const p = effect.particleProgress;
        ctx.beginPath();
        const numStripes = 10;
        const stripeHeight = box.height / numStripes;
        for (let i = 0; i < numStripes; i++) {
            const threshold = 0.1 + (i / numStripes) * 0.8;
            if (p > threshold) {
                ctx.rect(box.x, box.y + i * stripeHeight, box.width, stripeHeight);
            }
        }
        ctx.clip();
    }
}

function drawLightSweep(ctx, box, progress) {
    ctx.save();
    // Diagonal light sweep gradient moving left-to-right
    const x0 = box.x + (box.width + 100) * progress - 50;
    const y0 = box.y;
    const x1 = x0 + 40;
    const y1 = box.y + box.height;
    
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
    grad.addColorStop(0.5, 'rgba(255, 255, 255, 0.75)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    
    ctx.fillStyle = grad;
    ctx.fillRect(box.x, box.y, box.width, box.height);
    ctx.restore();
}

function clipPolygon(ctx, box, corners) {
    const c = corners || {
        tl: { x: 0, y: 0 },
        tr: { x: 100, y: 0 },
        br: { x: 100, y: 100 },
        bl: { x: 0, y: 100 }
    };
    ctx.beginPath();
    ctx.moveTo(box.x + box.width * c.tl.x / 100, box.y + box.height * c.tl.y / 100);
    ctx.lineTo(box.x + box.width * c.tr.x / 100, box.y + box.height * c.tr.y / 100);
    ctx.lineTo(box.x + box.width * c.br.x / 100, box.y + box.height * c.br.y / 100);
    ctx.lineTo(box.x + box.width * c.bl.x / 100, box.y + box.height * c.bl.y / 100);
    ctx.closePath();
    ctx.clip();
}

function fullMediaState() {
    return {
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        corners: {
            tl: { x: 0, y: 0 },
            tr: { x: 100, y: 0 },
            br: { x: 100, y: 100 },
            bl: { x: 0, y: 100 }
        }
    };
}

function drawImageClip(ctx, clip, layer, box, effect) {
    const state = clip._posterImageState || clip._imageEditState;
    if (!state || !clip._imageUrl) return;
    const image = loadedExportImage(clip._imageUrl);
    if (!image) return;
    const crop = state.crop;
    const sx = image.naturalWidth * crop.left / 100;
    const sy = image.naturalHeight * crop.top / 100;
    const sw = image.naturalWidth * (100 - crop.left - crop.right) / 100;
    const sh = image.naturalHeight * (100 - crop.top - crop.bottom) / 100;
    ctx.save();
    
    applyClipEffects(ctx, box, effect);
    
    clipPolygon(ctx, box, state.corners);
    ctx.drawImage(image, sx, sy, sw, sh, box.x, box.y, box.width, box.height);
    ctx.restore();
    
    if (effect.lightSweepProgress !== undefined) {
        drawLightSweep(ctx, box, effect.lightSweepProgress);
    }
}

// Align the video playhead to the clip's local time WITHOUT blocking the
// render loop. Setting currentTime requests a seek but we never await it, so a
// device that seeks slowly can't freeze the export — the next frames pick up
// the corrected time. A clip starting at 5s plays its video from 0s on entry,
// and small drift during real-time playback self-corrects.
function syncExportVideoTime(video, clip, elapsedSeconds) {
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    const start = parseFloat(clip.dataset.start) || 0;
    const target = Math.max(0, elapsedSeconds - start) % video.duration;

    // During export, we rely entirely on syncAllVideosToTime's precise paused seeking.
    // We do NOT want to seek or play here because that would conflict with the frame-by-frame loop!
    if (video === clip._exportVideo) {
        return;
    }

    if (Math.abs(video.currentTime - target) > 0.3) {
        try { video.currentTime = target; } catch (error) {}
    }
    if (video.paused) {
        try { video.play().catch(() => {}); } catch (error) {}
    }
}

// Synchronous: never await anything here. The render loop calls this once per
// frame, so a stalling await (e.g. video.play() that never resolves on Android)
// would freeze the whole export. The video is pre-warmed + playing in
// prepareExportVideos(); if a frame isn't decoded yet we just skip drawing it
// this tick and pick it up on the next frame.
function drawVideoClip(ctx, clip, layer, box, effect, elapsedSeconds) {
    const state = clip._posterVideoState || clip._editorVideoState || fullMediaState();
    const video = clip._exportVideo || layer.querySelector('.preview-media-element');
    if (!video || !video.videoWidth || !video.videoHeight) return;
    syncExportVideoTime(video, clip, elapsedSeconds);
    const crop = state.crop;
    const sx = video.videoWidth * crop.left / 100;
    const sy = video.videoHeight * crop.top / 100;
    const sw = video.videoWidth * (100 - crop.left - crop.right) / 100;
    const sh = video.videoHeight * (100 - crop.top - crop.bottom) / 100;
    ctx.save();
    
    applyClipEffects(ctx, box, effect);
    
    clipPolygon(ctx, box, state.corners);
    try {
        ctx.drawImage(video, sx, sy, sw, sh, box.x, box.y, box.width, box.height);
    } catch (error) {}
    ctx.restore();
    
    if (effect.lightSweepProgress !== undefined) {
        drawLightSweep(ctx, box, effect.lightSweepProgress);
    }
}

async function prepareExportVideos() {
    const videoClips = Array.from(document.querySelectorAll('.timeline-clip')).filter((clip) => {
        return clip._videoUrl || clip.querySelector('.upload-input')?.accept === 'video/*';
    });

    await Promise.all(videoClips.map(async (clip) => {
        const layer = prepareClipPreviewLayer(clip);
        if (!layer) return;
        const video = layer.querySelector('.preview-media-element') || ensureVideoElement(layer);
        if (!video) return;
        if (clip._videoUrl && video.src !== clip._videoUrl) video.src = clip._videoUrl;

        // Force the layer rendered (not visibility:hidden) so the browser keeps
        // decoding frames we can drawImage() — required for Android Chrome.
        if (layer.classList.contains('playback-hidden')) {
            exportHiddenLayers.push(layer);
            layer.classList.remove('playback-hidden');
        }

        video.muted = true;
        video.defaultMuted = true;
        video.playsInline = true;
        video.setAttribute('muted', '');
        video.setAttribute('playsinline', '');
        video.loop = true;
        clip._exportVideo = video;

        // Bounded pre-warm: play() and the first-frame wait are each capped so a
        // device that never resolves them can't block the export.
        try { await Promise.race([video.play(), exportDelay(1200)]); } catch (error) {}
        await Promise.race([waitForVideoFrame(video, 1200), exportDelay(1200)]);
    }));
}

function drawTextClip(ctx, clip, layer, box, scaleY, effect) {
    const input = clip.querySelector('.content-input');
    let text = input?.value || '';
    if (!text) return;
    
    if (effect.typewriterProgress !== undefined) {
        const charCount = Math.floor(text.length * effect.typewriterProgress);
        text = text.slice(0, charCount);
    }
    
    const style = getComputedStyle(layer);
    const fontSize = Math.max(6, parseFloat(style.fontSize) * scaleY);
    ctx.save();
    
    applyClipEffects(ctx, box, effect);
    
    ctx.fillStyle = style.color || '#1d2554';
    ctx.font = `${style.fontWeight || 800} ${fontSize}px ${style.fontFamily || 'sans-serif'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, box.x + box.width / 2, box.y + box.height / 2, box.width);
    ctx.restore();
    
    if (effect.lightSweepProgress !== undefined) {
        drawLightSweep(ctx, box, effect.lightSweepProgress);
    }
}

function drawExportFrame(ctx, canvas, elapsedSeconds, layout = createExportFrameLayout(canvas)) {
    const { items, scaleY } = layout;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#fbf8ec';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const item of items) {
        const { clip, layer, box, start, duration } = item;
        if (elapsedSeconds < start || elapsedSeconds > start + duration) continue;

        const effect = exportEffectOpacity(clip, elapsedSeconds);

        if (clip.querySelector('.content-input')) {
            drawTextClip(ctx, clip, layer, box, scaleY, effect);
        } else if (clip._imageUrl) {
            drawImageClip(ctx, clip, layer, box, effect);
        } else if (clip._videoUrl || layer.querySelector('.preview-media-element')) {
            drawVideoClip(ctx, clip, layer, box, effect, elapsedSeconds);
        }
    }
}

async function syncAllVideosToTime(elapsedSeconds, layout, force = false) {
    if (!force) return;
    const videoSeeks = [];
    for (const item of layout.items) {
        const { clip, layer, start, duration } = item;
        if (elapsedSeconds < start || elapsedSeconds > start + duration) {
            const video = clip._exportVideo || layer.querySelector('.preview-media-element');
            if (video && !video.paused) {
                try { video.pause(); } catch (e) {}
            }
            continue;
        }
        if (clip._videoUrl || layer.querySelector('.preview-media-element')) {
            const video = clip._exportVideo || layer.querySelector('.preview-media-element');
            if (!video || !Number.isFinite(video.duration) || video.duration <= 0) continue;
            
            // Force pause the video during export so it doesn't play forward in real-time
            if (!video.paused) {
                try { video.pause(); } catch (e) {}
            }

            const target = Math.max(0, elapsedSeconds - start) % video.duration;
            if (Math.abs(video.currentTime - target) > 0.001) {
                videoSeeks.push(new Promise((resolve) => {
                    let resolved = false;
                    const onSeeked = () => {
                        if (resolved) return;
                        resolved = true;
                        video.removeEventListener('seeked', onSeeked);
                        resolve();
                    };
                    video.addEventListener('seeked', onSeeked);
                    setTimeout(onSeeked, 150);
                    try {
                        video.currentTime = target;
                    } catch (error) {
                        onSeeked();
                    }
                }));
            }
        }
    }
    if (videoSeeks.length > 0) {
        await Promise.all(videoSeeks);
    }
}

async function recordPreviewWebM(frameRate = EXPORT_FRAME_RATE) {
    const canvas = document.createElement('canvas');
    const canvasSize = exportCanvasSize();
    canvas.width = canvasSize.width;
    canvas.height = canvasSize.height;
    const ctx = canvas.getContext('2d');
    let stream = canvas.captureStream(0);
    let videoTrack = stream.getVideoTracks()[0];
    if (!videoTrack?.requestFrame) {
        stream = canvas.captureStream(frameRate);
        videoTrack = stream.getVideoTracks()[0];
    }
    const chunks = [];
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
    // Scale the recording bitrate with resolution so larger frames aren't
    // starved, but cap it so the intermediate WebM stays under the renderer's
    // video upload limit (MAX_VIDEO_UPLOAD_MB = 10MB; ~4Mbps * 15s ≈ 7.5MB).
    const videoBitsPerSecond = Math.min(
        4000000,
        Math.max(2000000, Math.round(canvas.width * canvas.height * frameRate * 0.08))
    );
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond });
    recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
    };

    const clips = Array.from(document.querySelectorAll('.timeline-clip'));
    clips.forEach(prepareClipPreviewLayer);
    await prepareExportImages(clips);
    await prepareExportVideos();
    const layout = createExportFrameLayout(canvas);
    recorder.start(1000);
    const startTime = performance.now();
    const stopped = new Promise((resolve) => {
        recorder.onstop = resolve;
    });

    await new Promise((resolve) => {
        const totalFrames = Math.round(TOTAL_SECONDS * frameRate);
        let frameIndex = 0;

        const render = async () => {
            const elapsed = Math.min(TOTAL_SECONDS, frameIndex / frameRate);
            await syncAllVideosToTime(elapsed, layout, true);
            drawExportFrame(ctx, canvas, elapsed, layout);
            videoTrack?.requestFrame?.();

            if (frameIndex >= totalFrames) {
                recorder.stop();
                resolve();
                return;
            }

            frameIndex += 1;
            const targetTime = startTime + (frameIndex * 1000 / frameRate);
            window.setTimeout(render, Math.max(0, targetTime - performance.now()));
        };

        render();
    });

    await stopped;
    endExportVideos();

    return new Blob(chunks, { type: 'video/webm' });
}

async function executeArrangement() {
    const btn = document.getElementById('arrangeBtn');
    btn.disabled = true;
    btn.innerText = "輸出中...";
    exportJobs.clear();
    renderExportJobs();
    try {
        if (previewPlaybackId) stopTimelinePreview();
        const product = selectedProduct();
        const outputFrameRate = EXPORT_FRAME_RATE;
        if (!exportSizeIsViable(exportCanvasSize(product))) {
            upsertExportJob({
                id: 'current-export',
                status: 'failed',
                message: '此產品比例過寬，目前無法輸出為單一 MP4 影片。'
            });
            return;
        }
        const webmBlob = await recordPreviewWebM(outputFrameRate);
        upsertExportJob({ id: 'current-export', status: 'uploading' });
        const sourceAsset = await uploadAssetToCloud(webmBlob, 'ai_poster_preview.webm');
        upsertExportJob({ id: 'current-export', status: 'creating_job' });
        const canvasSize = exportCanvasSize(product);
        const token = await turnstileToken('export');
        const response = await fetch('/api/jobs/export', {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                format: 'h265',
                turnstileToken: token || undefined,
                settings: {
                    sourceAssetId: sourceAsset?.id || null,
                    sourceAssetUrl: sourceAsset?.downloadUrl || null,
                    productId: product.id,
                    productName: product.name,
                    displaySizeMm: product.size,
                    displayWidthMm: product.width,
                    displayHeightMm: product.height,
                    displayRatio: product.ratio,
                    displayOrientation: product.orientation,
                    exportWidth: canvasSize.width,
                    exportHeight: canvasSize.height,
                    durationSeconds: TOTAL_SECONDS,
                    frameRate: outputFrameRate
                }
            })
        });
        const data = await parseApiJson(response);
        if (!response.ok || !data.ok) {
            if (data.job) {
                upsertExportJob(data.job);
                pollExportJob(data.job.id);
                return;
            }
            if (data.queue) {
                upsertExportJob({
                    id: 'current-export',
                    status: 'failed',
                    message: `${data.message || '目前 MP4 佇列已滿'} ${formatQueueEta(data.queue.estimatedSeconds)}`
                });
                return;
            }
            throw new Error(data.message || data.code || "後端連線異常");
        }
        upsertExportJob(data.job);
        pollExportJob(data.job.id);
    } catch (error) {
        upsertExportJob({ id: 'current-export', status: 'failed', errorMessage: error.message || '雲端輸出服務尚未啟用，請稍後再試。' });
    } finally {
        btn.disabled = false;
        btn.innerText = "安排";
    }
}

async function loadUserProfile() {
    try {
        const response = await fetch('/api/me', { cache: 'no-store' });
        const data = await parseApiJson(response);
        if (!response.ok || !data.ok) return;

        const badge = document.getElementById('userProfileBadge');
        const emailSpan = document.getElementById('userEmail');
        const planSpan = document.getElementById('userPlan');

        if (badge && emailSpan && planSpan) {
            emailSpan.textContent = data.user?.email || '未登入';
            
            const plan = data.user?.plan || 'free';
            planSpan.textContent = plan;
            planSpan.className = `user-plan-badge ${plan}`;
            
            badge.style.display = 'inline-flex';
        }
    } catch (error) {
        console.warn('Unable to load user profile:', error);
    }
}

function openRedeemModal() {
    const modal = document.getElementById('redeemModal');
    const input = document.getElementById('redeemCodeInput');
    const msg = document.getElementById('redeemMessage');
    if (modal) {
        modal.style.display = 'flex';
        modal.setAttribute('aria-hidden', 'false');
    }
    if (input) {
        input.value = '';
        input.focus();
    }
    if (msg) {
        msg.textContent = '';
        msg.className = 'modal-message';
    }
}

function closeRedeemModal() {
    const modal = document.getElementById('redeemModal');
    if (modal) {
        modal.style.display = 'none';
        modal.setAttribute('aria-hidden', 'true');
    }
}

async function submitRedeemCode() {
    const input = document.getElementById('redeemCodeInput');
    const msg = document.getElementById('redeemMessage');
    const btn = document.getElementById('redeemSubmitBtn');
    
    const code = input?.value?.trim()?.toUpperCase() || '';
    if (!code) {
        if (msg) {
            msg.textContent = '請輸入有效邀請碼。';
            msg.className = 'modal-message error';
        }
        return;
    }
    
    if (btn) btn.disabled = true;
    if (msg) {
        msg.textContent = '正在驗證序號...';
        msg.className = 'modal-message';
    }
    
    try {
        const response = await fetch('/api/invites/redeem', {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({ code })
        });
        const data = await parseApiJson(response);
        if (!response.ok || !data.ok) {
            throw new Error(data.message || '兌換失敗，請確認序號是否正確或已被使用。');
        }
        
        if (msg) {
            msg.textContent = '🎉 兌換成功！正在更新方案...';
            msg.className = 'modal-message success';
        }
        
        // Refresh user profile to show updated plan
        await loadUserProfile();
        
        setTimeout(() => {
            closeRedeemModal();
        }, 1500);
    } catch (error) {
        if (msg) {
            msg.textContent = error.message;
            msg.className = 'modal-message error';
        }
    } finally {
        if (btn) btn.disabled = false;
    }
}

initializeProductSelector();
loadSecurityConfig();
loadUserProfile();
setupViewportGestures(document.getElementById('posterPreview'));
setupViewportGestures(document.getElementById('imageEditorPreview'));
window.addEventListener('resize', applyScreenPreviewSize);
