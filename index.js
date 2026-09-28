const MODULE_NAME = 'preset-drawers';
const TAG = '[PresetDrawers]';

const {
    extensionSettings,
    saveSettingsDebounced,
    renderExtensionTemplateAsync,
    eventSource,
    eventTypes,
    getPresetManager,
    getRequestHeaders,
    Popup,
    POPUP_RESULT,
    chatCompletionSettings,
} = SillyTavern.getContext();

const API_IDS = ['openai', 'textgenerationwebui', 'kobold', 'novel'];

// 条目分组只作用于 Chat Completion：酒馆里只有 openai.js 会创建条目管理器
// （setupChatCompletionPromptManager），条目列表里的标识全部来自 openai 预设。
const PROMPT_PRESET_API = 'openai';

// prompt_order 里 character_id 100001 是 Chat Completion「不绑定角色」的顺序，
// 也就是 openai.js 建立条目管理器时传进去的 promptOrder.dummyId，跟条目列表
// 在没有角色专属顺序时展示的那一份是同一个。100000 只是 PromptManager 类里
// 的默认值，只对没有覆盖它的调用方生效；预设文件里那份 100000 是旧版本留下的，
// 里面往往只有内建条目，按它排序会把自定义条目全挤到末尾。
const DEFAULT_PROMPT_ORDER_ID = 100001;

// 内建条目里只有这几个允许改正文，与 PromptManager.isPromptEditAllowed 的白名单
// 一致；其余的 marker 条目正文由酒馆在运行时拼出来，预设文件里没有文本可编辑。
const EDITABLE_MARKER_IDS = new Set([
    'charDescription',
    'charPersonality',
    'scenario',
    'personaDescription',
    'worldInfoBefore',
    'worldInfoAfter',
]);

// PromptManager.overridablePrompts：原生弹窗里只有这几个标识的条目才显示
// 「禁止覆盖」复选框，其余条目一律 visibility:hidden。
const OVERRIDABLE_PROMPT_IDS = ['main', 'jailbreak'];

const ROLE_OPTIONS = [
    { value: 'system', label: '系统' },
    { value: 'user', label: '用户' },
    { value: 'assistant', label: 'AI 助手' },
];
const TRIGGER_OPTIONS = [
    { value: 'normal', label: '正常' },
    { value: 'continue', label: '续写' },
    { value: 'impersonate', label: 'AI 帮答' },
    { value: 'swipe', label: '备选回复' },
    { value: 'regenerate', label: '重新生成' },
    { value: 'quiet', label: '静默' },
];

// 备份走 /api/files/upload，接口只收 a-zA-Z0-9_- 与点号组成的文件名，
// 所以名字里放时间戳和预设名的短哈希，预设名本身记在扩展设置的清单里。
const BACKUP_PREFIX = 'pd-backup-';
// 酒馆的条目列表由 openai.js 里的 promptManager 渲染。这个路径与 ST 的
// public/ 目录对应，模块是 ES module，动态 import 拿到的就是页面在用的那一个。
const NATIVE_PROMPT_MODULE = '/scripts/openai.js';
const BACKUP_KEEP = 20;

const UNCLASSIFIED = '__unclassified__';

const defaultSettings = Object.freeze({
    enabled: true,
    useCustomPicker: true,
    promptGroupsEnabled: true,
    backupBeforeSave: true,
    backups: [],
    apiConfig: {},
    promptGroups: { groups: [], assign: {} },
});

let panelEl = null;
let panelAbort = null;
let openApiId = null;
let searchTerm = '';
let manageMode = false;
let dragPayload = null;
let suppressClick = false;
let renderQueued = false;
const collapsedSections = new Set();

const PROMPT_CONTAINER_ID = 'completion_prompt_manager';
const PROMPT_LIST_ID = 'completion_prompt_manager_list';

let promptObserver = null;
let promptSyncQueued = false;
let groupMenuEl = null;
let groupMenuAbort = null;
let groupMenuIdentifier = null;
const collapsedGroups = new Set();
const collapsedSettingGroups = new Set();
const collapsedSettingPresets = new Set();
const collapsedBackupGroups = new Set();
let soloGroupId = null;

/* ------------------------------------------------------------------ *
 * 设置读写
 * ------------------------------------------------------------------ */

function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const settings = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = structuredClone(defaultSettings[key]);
        }
    }
    if (!settings.apiConfig || typeof settings.apiConfig !== 'object' || Array.isArray(settings.apiConfig)) {
        settings.apiConfig = {};
    }
    if (!settings.promptGroups || typeof settings.promptGroups !== 'object' || Array.isArray(settings.promptGroups)) {
        settings.promptGroups = structuredClone(defaultSettings.promptGroups);
    }
    const promptGroups = settings.promptGroups;
    if (!Array.isArray(promptGroups.groups)) {
        promptGroups.groups = [];
    }
    promptGroups.groups = promptGroups.groups
        .filter((group) => group && typeof group === 'object' && typeof group.id === 'string')
        .map((group) => ({ id: group.id, name: String(group.name ?? '') }));
    if (!promptGroups.assign || typeof promptGroups.assign !== 'object' || Array.isArray(promptGroups.assign)) {
        promptGroups.assign = {};
    }
    if (!Array.isArray(settings.backups)) {
        settings.backups = [];
    }
    settings.backups = settings.backups
        .filter((item) => item && typeof item === 'object' && typeof item.file === 'string' && item.file);
    return settings;
}

function getApiConfig(apiId) {
    const settings = getSettings();
    if (!settings.apiConfig[apiId] || typeof settings.apiConfig[apiId] !== 'object') {
        settings.apiConfig[apiId] = { drawers: [], assign: {}, order: {} };
    }
    const cfg = settings.apiConfig[apiId];
    if (!Array.isArray(cfg.drawers)) {
        cfg.drawers = [];
    }
    cfg.drawers = cfg.drawers
        .filter((drawer) => drawer && typeof drawer === 'object' && typeof drawer.id === 'string')
        .map((drawer) => ({ id: drawer.id, name: String(drawer.name ?? '') }));
    if (!cfg.assign || typeof cfg.assign !== 'object' || Array.isArray(cfg.assign)) {
        cfg.assign = {};
    }
    if (!cfg.order || typeof cfg.order !== 'object' || Array.isArray(cfg.order)) {
        cfg.order = {};
    }
    return cfg;
}

/* ------------------------------------------------------------------ *
 * 通用小工具
 * ------------------------------------------------------------------ */

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function debounce(fn, delay) {
    let timer = null;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

function makeDrawerId() {
    return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 扩展可能被装成任意文件夹名（从 Git 地址安装时 ST 用仓库名做目录），
// 这里从自身模块地址推导，避免写死路径导致模板 404。
function resolveTemplateId() {
    try {
        const segments = new URL(import.meta.url).pathname.split('/').filter(Boolean);
        const folder = segments.at(-2);
        if (folder && folder !== 'third-party') {
            return `third-party/${folder}`;
        }
    } catch (error) {
        console.warn(`${TAG} 无法推导扩展目录，回退到默认路径`, error);
    }
    return 'third-party/preset-drawers';
}

function normalizeIds(raw) {
    if (Array.isArray(raw)) {
        return raw.filter((item) => typeof item === 'string' && item);
    }
    if (typeof raw === 'string' && raw) {
        return [raw];
    }
    return [];
}

/* ------------------------------------------------------------------ *
 * 与原生的对接层
 *
 * 隐藏的原生下拉框是「当前选中预设」的唯一真相，这里只负责向它读写，
 * 扩展自身不缓存任何选中状态。
 * ------------------------------------------------------------------ */

function findSelect(apiId) {
    const selects = document.querySelectorAll('select[data-preset-manager-for]');
    for (const select of selects) {
        const raw = select.getAttribute('data-preset-manager-for') ?? '';
        const ids = raw.split(',').map((item) => item.trim()).filter(Boolean);
        if (ids.includes(apiId)) {
            return select;
        }
    }
    return null;
}

function getAdapter(apiId) {
    const select = findSelect(apiId);
    let manager = null;
    try {
        if (typeof getPresetManager === 'function') {
            manager = getPresetManager(apiId);
        }
    } catch (error) {
        manager = null;
    }

    return {
        select,
        manager,

        list() {
            if (manager && typeof manager.getAllPresets === 'function') {
                return manager.getAllPresets()
                    .filter((name) => typeof name === 'string' && name.length > 0)
                    .map((name) => ({ name, value: manager.findPreset(name) }));
            }
            if (!select) {
                return [];
            }
            return Array.from(select.querySelectorAll('option'))
                .map((option) => ({ name: option.textContent ?? '', value: option.value }))
                .filter((item) => item.name.length > 0);
        },

        current() {
            if (manager && typeof manager.getSelectedPresetName === 'function') {
                return {
                    name: manager.getSelectedPresetName() ?? '',
                    value: manager.getSelectedPreset(),
                };
            }
            if (!select || select.selectedIndex < 0) {
                return { name: '', value: '' };
            }
            const option = select.options[select.selectedIndex];
            return { name: option.textContent ?? '', value: option.value };
        },

        async apply(value) {
            if (manager && typeof manager.selectPreset === 'function') {
                await manager.selectPreset(value);
                return;
            }
            if (!select) {
                return;
            }
            $(select).val(value).trigger('change');
        },
    };
}

/* ------------------------------------------------------------------ *
 * 抽屉数据操作
 * ------------------------------------------------------------------ */

function setAssignment(apiId, presetName, ids) {
    const cfg = getApiConfig(apiId);
    const unique = [...new Set(normalizeIds(ids))].filter((id) => cfg.drawers.some((drawer) => drawer.id === id));
    if (unique.length === 0) {
        delete cfg.assign[presetName];
    } else {
        cfg.assign[presetName] = unique;
    }
    saveSettingsDebounced();
}

function getOrder(cfg, drawerId) {
    if (!Array.isArray(cfg.order[drawerId])) {
        cfg.order[drawerId] = [];
    }
    return cfg.order[drawerId];
}

function sortByOrder(list, order) {
    const index = new Map(order.map((name, position) => [name, position]));
    return [...list].sort((left, right) => {
        const leftIndex = index.has(left.name) ? index.get(left.name) : Number.MAX_SAFE_INTEGER;
        const rightIndex = index.has(right.name) ? index.get(right.name) : Number.MAX_SAFE_INTEGER;
        return leftIndex - rightIndex;
    });
}

function reorderInDrawer(apiId, drawerId, presetName, beforeName) {
    const cfg = getApiConfig(apiId);
    const current = (collectState(apiId).byDrawer.get(drawerId) ?? []).map((preset) => preset.name);
    const next = current.filter((name) => name !== presetName);
    const index = beforeName ? next.indexOf(beforeName) : -1;
    if (index < 0) {
        next.push(presetName);
    } else {
        next.splice(index, 0, presetName);
    }
    cfg.order[drawerId] = next;
    saveSettingsDebounced();
}

function createDrawer(apiId, name) {
    const cfg = getApiConfig(apiId);
    const drawer = { id: makeDrawerId(), name: name || '新抽屉' };
    cfg.drawers.push(drawer);
    saveSettingsDebounced();
    return drawer;
}

function renameDrawer(apiId, drawerId, name) {
    const cfg = getApiConfig(apiId);
    const target = cfg.drawers.find((drawer) => drawer.id === drawerId);
    if (!target) {
        return;
    }
    const trimmed = name.trim();
    const duplicate = cfg.drawers.find((drawer) => drawer.id !== drawerId && drawer.name === trimmed);
    if (duplicate) {
        // 重命名撞名时按合并处理：归属转移后删掉当前抽屉
        for (const [presetName, ids] of Object.entries(cfg.assign)) {
            const normalized = normalizeIds(ids);
            if (!normalized.includes(drawerId)) {
                continue;
            }
            const merged = normalized.map((id) => (id === drawerId ? duplicate.id : id));
            cfg.assign[presetName] = [...new Set(merged)];
        }
        const mergedOrder = [
            ...getOrder(cfg, duplicate.id),
            ...getOrder(cfg, drawerId).filter((name) => !getOrder(cfg, duplicate.id).includes(name)),
        ];
        deleteOrder(cfg, drawerId);
        cfg.order[duplicate.id] = mergedOrder;
        cfg.drawers = cfg.drawers.filter((drawer) => drawer.id !== drawerId);
    } else {
        target.name = trimmed;
    }
    saveSettingsDebounced();
}

function deleteOrder(cfg, drawerId) {
    delete cfg.order[drawerId];
}

function deleteDrawer(apiId, drawerId) {
    const cfg = getApiConfig(apiId);
    cfg.drawers = cfg.drawers.filter((drawer) => drawer.id !== drawerId);
    deleteOrder(cfg, drawerId);
    for (const [presetName, ids] of Object.entries(cfg.assign)) {
        const next = normalizeIds(ids).filter((id) => id !== drawerId);
        if (next.length === 0) {
            delete cfg.assign[presetName];
        } else {
            cfg.assign[presetName] = next;
        }
    }
    saveSettingsDebounced();
}

function moveDrawer(apiId, drawerId, delta) {
    const cfg = getApiConfig(apiId);
    const from = cfg.drawers.findIndex((drawer) => drawer.id === drawerId);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= cfg.drawers.length) {
        return;
    }
    const [moved] = cfg.drawers.splice(from, 1);
    cfg.drawers.splice(to, 0, moved);
    saveSettingsDebounced();
}

/* ------------------------------------------------------------------ *
 * 条目分组数据操作
 *
 * 归属按条目的 identifier 记录，只打标记，绝不改动条目顺序。
 * ------------------------------------------------------------------ */

function getPromptGroups() {
    return getSettings().promptGroups;
}

function setPromptGroupsFor(identifier, ids) {
    const pg = getPromptGroups();
    const unique = [...new Set(normalizeIds(ids))].filter((id) => pg.groups.some((group) => group.id === id));
    if (unique.length === 0) {
        delete pg.assign[identifier];
    } else {
        pg.assign[identifier] = unique;
    }
    saveSettingsDebounced();
}

function createPromptGroup(name) {
    const pg = getPromptGroups();
    const group = { id: makeDrawerId(), name: name.trim() || '新分组' };
    pg.groups.push(group);
    saveSettingsDebounced();
    return group;
}

function renamePromptGroup(groupId, name) {
    const pg = getPromptGroups();
    const target = pg.groups.find((group) => group.id === groupId);
    if (!target) {
        return;
    }
    const trimmed = name.trim();
    const duplicate = pg.groups.find((group) => group.id !== groupId && group.name === trimmed);
    if (duplicate) {
        for (const [identifier, ids] of Object.entries(pg.assign)) {
            const normalized = normalizeIds(ids);
            if (!normalized.includes(groupId)) {
                continue;
            }
            pg.assign[identifier] = [...new Set(normalized.map((id) => (id === groupId ? duplicate.id : id)))];
        }
        pg.groups = pg.groups.filter((group) => group.id !== groupId);
        collapsedGroups.delete(groupId);
        if (soloGroupId === groupId) {
            soloGroupId = null;
        }
    } else {
        target.name = trimmed;
    }
    saveSettingsDebounced();
}

function deletePromptGroup(groupId) {
    const pg = getPromptGroups();
    pg.groups = pg.groups.filter((group) => group.id !== groupId);
    for (const [identifier, ids] of Object.entries(pg.assign)) {
        const next = normalizeIds(ids).filter((id) => id !== groupId);
        if (next.length === 0) {
            delete pg.assign[identifier];
        } else {
            pg.assign[identifier] = next;
        }
    }
    collapsedGroups.delete(groupId);
    if (soloGroupId === groupId) {
        soloGroupId = null;
    }
    saveSettingsDebounced();
}

function getPresetOrderIndex(preset) {
    const map = new Map();
    const orders = Array.isArray(preset?.prompt_order) ? preset.prompt_order : [];
    if (orders.length === 0) {
        return map;
    }
    const picked = orders.find((item) => Number(item?.character_id) === DEFAULT_PROMPT_ORDER_ID) ?? orders[0];
    const list = Array.isArray(picked?.order) ? picked.order : [];
    list.forEach((item, index) => {
        if (item && typeof item.identifier === 'string' && item.identifier) {
            map.set(item.identifier, index);
        }
    });
    return map;
}

// 取出「预设 → 条目」用于设置面板展示。
// 预设文件里 prompts 数组的顺序是按标识排过序的，对人没有意义，
// 所以按 prompt_order 重排成条目列表里实际看到的顺序。
function getPromptPresetEntries() {
    const manager = getAdapter(PROMPT_PRESET_API).manager;
    if (!manager || typeof manager.getPresetList !== 'function') {
        return [];
    }
    let raw = null;
    try {
        raw = manager.getPresetList();
    } catch (error) {
        console.warn(`${TAG} 读不到预设列表`, error);
        return [];
    }
    const presets = Array.isArray(raw?.presets) ? raw.presets : [];
    const names = raw?.preset_names;
    const result = [];

    const push = (name, data) => {
        if (typeof name !== 'string' || name.length === 0) {
            return;
        }
        const order = getPresetOrderIndex(data);
        const entries = (Array.isArray(data?.prompts) ? data.prompts : [])
            .filter((prompt) => prompt && typeof prompt.identifier === 'string' && prompt.identifier)
            .map((prompt) => ({
                identifier: prompt.identifier,
                name: typeof prompt.name === 'string' && prompt.name.length > 0 ? prompt.name : prompt.identifier,
                content: typeof prompt.content === 'string' ? prompt.content : '',
            }))
            .sort((a, b) => (order.get(a.identifier) ?? Number.MAX_SAFE_INTEGER)
                - (order.get(b.identifier) ?? Number.MAX_SAFE_INTEGER));
        result.push({ name, entries });
    };

    if (Array.isArray(names)) {
        names.forEach((name, index) => push(String(name), presets[index]));
    } else if (names && typeof names === 'object') {
        for (const [name, index] of Object.entries(names)) {
            push(name, presets[index]);
        }
    } else {
        presets.forEach((data, index) => push(String(data?.name ?? `#${index + 1}`), data));
    }
    return result;
}

/* ------------------------------------------------------------------ *
 * 状态汇总
 * ------------------------------------------------------------------ */

function collectState(apiId) {
    const cfg = getApiConfig(apiId);
    const adapter = getAdapter(apiId);
    const presets = adapter.list();
    const existing = new Set(presets.map((preset) => preset.name));
    const validDrawerIds = new Set(cfg.drawers.map((drawer) => drawer.id));

    let dirty = false;
    for (const presetName of Object.keys(cfg.assign)) {
        const normalized = normalizeIds(cfg.assign[presetName]);
        if (!existing.has(presetName)) {
            delete cfg.assign[presetName];
            dirty = true;
            continue;
        }
        const kept = normalized.filter((id) => validDrawerIds.has(id));
        if (kept.length === 0) {
            delete cfg.assign[presetName];
            dirty = true;
        } else if (kept.length !== normalized.length) {
            cfg.assign[presetName] = kept;
            dirty = true;
        }
    }
    if (dirty) {
        saveSettingsDebounced();
    }

    const byDrawer = new Map(cfg.drawers.map((drawer) => [drawer.id, []]));
    const unclassified = [];
    for (const preset of presets) {
        const ids = normalizeIds(cfg.assign[preset.name]);
        if (ids.length === 0) {
            unclassified.push(preset);
            continue;
        }
        for (const id of ids) {
            if (byDrawer.has(id)) {
                byDrawer.get(id).push(preset);
            }
        }
    }
    for (const drawer of cfg.drawers) {
        byDrawer.set(drawer.id, sortByOrder(byDrawer.get(drawer.id), getOrder(cfg, drawer.id)));
    }

    return { cfg, adapter, presets, byDrawer, unclassified, current: adapter.current() };
}

/* ------------------------------------------------------------------ *
 * 选择器控件（替代被隐藏的原生下拉框）
 * ------------------------------------------------------------------ */

function buildPicker(apiId) {
    const picker = document.createElement('div');
    picker.className = 'pd-picker';
    picker.dataset.pdApi = apiId;
    picker.tabIndex = 0;
    picker.setAttribute('role', 'button');
    picker.innerHTML = `
        <span class="pd-picker-text"></span>
        <span class="pd-picker-badge"></span>
        <i class="pd-picker-caret fa-solid fa-caret-down"></i>
    `;
    picker.addEventListener('click', () => {
        if (openApiId === apiId) {
            closePanel();
        } else {
            openPanel(apiId);
        }
    });
    picker.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openPanel(apiId);
        }
    });
    return picker;
}

function buildTriggerButton(apiId) {
    const button = document.createElement('div');
    button.className = 'pd-trigger menu_button menu_button_icon';
    button.dataset.pdApi = apiId;
    button.title = '预设抽屉';
    button.innerHTML = '<i class="fa-fw fa-solid fa-box-archive"></i>';
    button.addEventListener('click', () => {
        if (openApiId === apiId) {
            closePanel();
        } else {
            openPanel(apiId);
        }
    });
    return button;
}

function syncApi(apiId) {
    const settings = getSettings();
    const select = findSelect(apiId);
    if (!select) {
        return;
    }
    const row = select.parentElement;
    if (!row) {
        return;
    }

    const active = settings.enabled;

    let picker = row.querySelector(`.pd-picker[data-pd-api="${apiId}"]`);
    let trigger = row.querySelector(`.pd-trigger[data-pd-api="${apiId}"]`);

    if (!active) {
        select.classList.remove('pd-hidden');
        picker?.remove();
        trigger?.remove();
        if (openApiId === apiId) {
            closePanel();
        }
        return;
    }

    if (settings.useCustomPicker) {
        if (!picker) {
            picker = buildPicker(apiId);
            row.insertBefore(picker, select);
        }
        trigger?.remove();
        select.classList.add('pd-hidden');
    } else {
        if (!trigger) {
            trigger = buildTriggerButton(apiId);
            row.appendChild(trigger);
        }
        picker?.remove();
        select.classList.remove('pd-hidden');
    }

    refreshPickerLabel(apiId);
}

function updatePickerBadge(apiId) {
    const select = findSelect(apiId);
    if (!select) {
        return;
    }
    const row = select.parentElement;
    const state = collectState(apiId);
    const drawerNames = normalizeIds(state.cfg.assign[state.current.name])
        .map((id) => state.cfg.drawers.find((drawer) => drawer.id === id)?.name)
        .filter(Boolean);

    const picker = row?.querySelector(`.pd-picker[data-pd-api="${apiId}"]`);
    if (picker) {
        picker.querySelector('.pd-picker-text').textContent = state.current.name;
        const badge = picker.querySelector('.pd-picker-badge');
        badge.textContent = drawerNames.length > 0 ? drawerNames[0] : '';
        badge.classList.toggle('pd-empty', drawerNames.length === 0);
        picker.title = drawerNames.length > 0
            ? `${state.current.name} · ${drawerNames.join(' / ')}`
            : state.current.name;
    }
}

function refreshPickerLabel(apiId) {
    updatePickerBadge(apiId);

    if (openApiId === apiId) {
        renderPanel();
    }
}

function syncAll() {
    for (const apiId of API_IDS) {
        syncApi(apiId);
    }
}

/* ------------------------------------------------------------------ *
 * 面板
 * ------------------------------------------------------------------ */

function ensurePanel() {
    if (panelEl) {
        return panelEl;
    }
    panelAbort = new AbortController();
    panelEl = document.createElement('div');
    panelEl.className = 'pd-panel';
    panelEl.innerHTML = `
        <div class="pd-panel-head">
            <input class="pd-search text_pole" type="text" placeholder="搜索预设或抽屉…" />
            <div class="pd-icon-button pd-manage" title="管理抽屉"><i class="fa-solid fa-gear"></i></div>
            <div class="pd-icon-button pd-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="pd-panel-body"></div>
        <div class="pd-panel-foot">
            <div class="pd-foot-button pd-add-drawer"><i class="fa-solid fa-plus"></i> 新建抽屉</div>
            <span class="pd-hint">拖动预设到抽屉即可归类，同一预设可同时属于多个抽屉</span>
        </div>
    `;
    document.body.appendChild(panelEl);

    const stopNavbarAutoclose = (event) => event.stopPropagation();
    panelEl.addEventListener('mousedown', stopNavbarAutoclose);
    panelEl.addEventListener('touchstart', stopNavbarAutoclose);

    const search = panelEl.querySelector('.pd-search');
    search.addEventListener('input', () => {
        searchTerm = search.value;
        renderPanel();
    });
    panelEl.querySelector('.pd-close').addEventListener('click', () => closePanel());
    panelEl.querySelector('.pd-manage').addEventListener('click', () => {
        manageMode = !manageMode;
        panelEl.classList.toggle('pd-managing', manageMode);
        renderPanel();
    });
    panelEl.querySelector('.pd-add-drawer').addEventListener('click', () => {
        if (!openApiId) {
            return;
        }
        const drawer = createDrawer(openApiId, '新抽屉');
        manageMode = true;
        panelEl.classList.add('pd-managing');
        renderPanel();
        const input = panelEl.querySelector(`.pd-drawer-name[data-pd-drawer="${drawer.id}"]`);
        input?.focus();
        input?.select();
    });

    document.addEventListener('mousedown', (event) => {
        if (!panelEl || openApiId === null) {
            return;
        }
        const target = event.target;
        if (panelEl.contains(target)) {
            return;
        }
        if (target instanceof Element && target.closest('.pd-picker, .pd-trigger')) {
            return;
        }
        closePanel();
    }, { signal: panelAbort.signal });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            closePanel();
        }
    }, { signal: panelAbort.signal });

    return panelEl;
}

function openPanel(apiId) {
    if (!API_IDS.includes(apiId)) {
        return;
    }
    const select = findSelect(apiId);
    const row = select?.parentElement;
    const anchor = row?.querySelector(`.pd-picker[data-pd-api="${apiId}"]`)
        ?? row?.querySelector(`.pd-trigger[data-pd-api="${apiId}"]`);

    const panel = ensurePanel();
    openApiId = apiId;
    searchTerm = '';
    manageMode = false;
    panel.classList.remove('pd-managing');
    panel.querySelector('.pd-search').value = '';

    // 先显示再渲染：renderPanel 会跳过处于隐藏状态的面板
    panel.style.display = 'flex';
    renderPanel();

    const rect = anchor ? anchor.getBoundingClientRect() : null;
    const width = panel.offsetWidth || 360;
    const height = panel.offsetHeight || 320;
    let left;
    let top;

    if (rect && rect.width > 0) {
        left = rect.left + window.scrollX;
        top = rect.bottom + window.scrollY + 4;
    } else {
        left = window.scrollX + (window.innerWidth - width) / 2;
        top = window.scrollY + Math.max(8, (window.innerHeight - height) / 2);
    }

    left = Math.max(8, Math.min(left, window.scrollX + window.innerWidth - width - 8));
    top = Math.max(8, Math.min(top, window.scrollY + window.innerHeight - height - 8));

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
}

function closePanel() {
    commitPendingDrawerName();

    if (panelEl) {
        panelEl.style.display = 'none';
    }
    openApiId = null;
}

function renderPanel() {
    if (!panelEl || !openApiId || panelEl.style.display === 'none') {
        return;
    }
    const apiId = openApiId;
    const state = collectState(apiId);
    const body = panelEl.querySelector('.pd-panel-body');
    const query = searchTerm.trim().toLowerCase();
    const matches = (name) => query === '' || name.toLowerCase().includes(query);

    body.innerHTML = '';

    if (state.presets.length === 0) {
        body.innerHTML = '<div class="pd-empty-state">当前 API 下没有读到预设</div>';
        return;
    }

    const unclassified = state.unclassified.filter((preset) => matches(preset.name));
    if (unclassified.length > 0) {
        body.appendChild(buildSection({
            apiId,
            drawerId: UNCLASSIFIED,
            title: '未分类',
            count: state.unclassified.length,
            presets: unclassified,
            currentName: state.current.name,
            removable: false,
            collapsed: query === '' && collapsedSections.has(`${apiId}::${UNCLASSIFIED}`),
        }));
    }

    for (const drawer of state.cfg.drawers) {
        const inner = state.byDrawer.get(drawer.id) ?? [];
        const nameMatches = matches(drawer.name);
        const filtered = inner.filter((preset) => matches(preset.name));
        if (!nameMatches && filtered.length === 0 && query !== '') {
            continue;
        }
        body.appendChild(buildSection({
            apiId,
            drawerId: drawer.id,
            title: drawer.name,
            count: inner.length,
            presets: filtered,
            currentName: state.current.name,
            removable: true,
            collapsed: query === '' && collapsedSections.has(`${apiId}::${drawer.id}`),
        }));
    }

    if (body.childElementCount === 0) {
        body.innerHTML = '<div class="pd-empty-state">没有匹配的预设</div>';
    }
}

function commitDrawerNameInput(input) {
    const apiId = input.dataset.pdApi;
    const drawerId = input.dataset.pdDrawer;
    const target = getApiConfig(apiId).drawers.find((drawer) => drawer.id === drawerId);
    if (!target) {
        return;
    }
    const next = input.value.trim();
    if (!next || next === target.name) {
        input.value = target.name;
        return;
    }
    renameDrawer(apiId, drawerId, next);
    const stillExists = getApiConfig(apiId).drawers.some((drawer) => drawer.id === drawerId);
    if (stillExists) {
        updatePickerBadge(apiId);
    } else {
        refreshPickerLabel(apiId);
    }
}

function commitPendingDrawerName() {
    panelEl?.querySelectorAll('.pd-drawer-name').forEach((input) => commitDrawerNameInput(input));
}

function buildSection({ apiId, drawerId, title, count, presets, currentName, removable, collapsed }) {
    const section = document.createElement('div');
    section.className = 'pd-section';
    section.classList.toggle('pd-collapsed', collapsed);
    section.dataset.pdDrawer = drawerId;

    const header = document.createElement('div');
    header.className = 'pd-section-head';

    if (manageMode && removable) {
        header.innerHTML = `
            <div class="pd-fold" title="折叠 / 展开"><i class="fa-solid fa-caret-down"></i></div>
            <input class="pd-drawer-name text_pole" data-pd-api="${escapeHtml(apiId)}" data-pd-drawer="${escapeHtml(drawerId)}" value="${escapeHtml(title)}" />
            <span class="pd-section-count">${count}</span>
            <div class="pd-icon-button pd-move-up" title="上移"><i class="fa-solid fa-arrow-up"></i></div>
            <div class="pd-icon-button pd-move-down" title="下移"><i class="fa-solid fa-arrow-down"></i></div>
            <div class="pd-icon-button pd-remove-drawer" title="删除抽屉"><i class="fa-solid fa-trash-can"></i></div>
        `;
    } else {
        header.innerHTML = `
            <div class="pd-fold" title="折叠 / 展开"><i class="fa-solid fa-caret-down"></i></div>
            <span class="pd-section-title">${escapeHtml(title)}</span>
            <span class="pd-section-count">${count}</span>
        `;
    }
    section.appendChild(header);

    const toggleFold = () => {
        const key = `${apiId}::${drawerId}`;
        if (collapsedSections.has(key)) {
            collapsedSections.delete(key);
        } else {
            collapsedSections.add(key);
        }
        renderPanel();
    };
    header.querySelector('.pd-fold').addEventListener('click', (event) => {
        event.stopPropagation();
        toggleFold();
    });
    header.querySelector('.pd-section-title')?.addEventListener('click', toggleFold);

    const nameInput = header.querySelector('.pd-drawer-name');
    if (nameInput) {
        nameInput.addEventListener('blur', () => commitDrawerNameInput(nameInput));
        nameInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                commitDrawerNameInput(nameInput);
                nameInput.blur();
            }
        });
    }
    header.querySelector('.pd-move-up')?.addEventListener('click', () => {
        moveDrawer(apiId, drawerId, -1);
        renderPanel();
    });
    header.querySelector('.pd-move-down')?.addEventListener('click', () => {
        moveDrawer(apiId, drawerId, 1);
        renderPanel();
    });
    header.querySelector('.pd-remove-drawer')?.addEventListener('click', () => {
        deleteDrawer(apiId, drawerId);
        refreshPickerLabel(apiId);
    });

    const list = document.createElement('div');
    list.className = 'pd-list';
    list.dataset.pdDrawer = drawerId;

    for (const preset of presets) {
        list.appendChild(buildChip({ apiId, drawerId, preset, currentName, removable }));
    }
    if (presets.length === 0) {
        const placeholder = document.createElement('div');
        placeholder.className = 'pd-list-placeholder';
        placeholder.textContent = '拖预设到这里';
        list.appendChild(placeholder);
    }
    section.appendChild(list);

    section.addEventListener('dragover', (event) => {
        if (!dragPayload || dragPayload.apiId !== apiId) {
            return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        section.classList.add('pd-drop-active');
    });
    section.addEventListener('dragleave', (event) => {
        if (!section.contains(event.relatedTarget)) {
            section.classList.remove('pd-drop-active');
        }
    });
    section.addEventListener('drop', (event) => {
        section.classList.remove('pd-drop-active');
        if (!dragPayload || dragPayload.apiId !== apiId) {
            return;
        }
        event.preventDefault();
        const { name } = dragPayload;
        if (drawerId === UNCLASSIFIED) {
            setAssignment(apiId, name, []);
        } else {
            const ids = normalizeIds(getApiConfig(apiId).assign[name]);
            if (!ids.includes(drawerId)) {
                setAssignment(apiId, name, [...ids, drawerId]);
            } else {
                reorderInDrawer(apiId, drawerId, name, null);
            }
        }
        renderPanel();
        refreshPickerLabel(apiId);
    });

    return section;
}

function buildChip({ apiId, drawerId, preset, currentName, removable }) {
    const chip = document.createElement('div');
    chip.className = 'pd-chip';
    chip.draggable = true;
    chip.dataset.pdName = preset.name;
    if (preset.name === currentName) {
        chip.classList.add('pd-current');
    }

    const label = document.createElement('span');
    label.className = 'pd-chip-name';
    label.textContent = preset.name;
    label.title = preset.name;
    chip.appendChild(label);

    if (removable) {
        const remove = document.createElement('span');
        remove.className = 'pd-chip-remove';
        remove.title = '从这个抽屉移出';
        remove.textContent = '×';
        remove.addEventListener('mousedown', (event) => event.stopPropagation());
        remove.addEventListener('click', (event) => {
            event.stopPropagation();
            const ids = normalizeIds(getApiConfig(apiId).assign[preset.name]).filter((id) => id !== drawerId);
            setAssignment(apiId, preset.name, ids);
            renderPanel();
            refreshPickerLabel(apiId);
        });
        chip.appendChild(remove);
    }

    chip.addEventListener('click', async () => {
        if (suppressClick) {
            return;
        }
        if (typeof preset.value === 'undefined' || preset.value === null) {
            return;
        }
        await getAdapter(apiId).apply(preset.value);
        refreshPickerLabel(apiId);
        closePanel();
    });

    chip.addEventListener('dragstart', (event) => {
        dragPayload = { apiId, name: preset.name };
        suppressClick = true;
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', preset.name);
        }
        chip.classList.add('pd-dragging');
    });

    chip.addEventListener('dragend', () => {
        dragPayload = null;
        chip.classList.remove('pd-dragging');
        document.querySelectorAll('.pd-drop-active').forEach((element) => element.classList.remove('pd-drop-active'));
        setTimeout(() => {
            suppressClick = false;
        }, 0);
    });

    chip.addEventListener('dragover', (event) => {
        if (!dragPayload || dragPayload.apiId !== apiId) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        chip.classList.add('pd-drop-before');
    });

    chip.addEventListener('dragleave', () => {
        chip.classList.remove('pd-drop-before');
    });

    chip.addEventListener('drop', (event) => {
        chip.classList.remove('pd-drop-before');
        if (!dragPayload || dragPayload.apiId !== apiId) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const { name } = dragPayload;
        if (name === preset.name) {
            return;
        }
        if (drawerId === UNCLASSIFIED) {
            setAssignment(apiId, name, []);
        } else {
            const ids = normalizeIds(getApiConfig(apiId).assign[name]);
            if (!ids.includes(drawerId)) {
                setAssignment(apiId, name, [...ids, drawerId]);
            }
            reorderInDrawer(apiId, drawerId, name, preset.name);
        }
        renderPanel();
        refreshPickerLabel(apiId);
    });

    return chip;
}

/* ------------------------------------------------------------------ *
 * 条目分组的界面：往预设条目列表里插分组横幅与标记
 *
 * 只做视觉分组 —— 横幅插在组内第一个条目的位置，折叠时按原位置隐藏成员，
 * 条目的排列顺序（prompt_order）一个字节都不动。
 * ------------------------------------------------------------------ */

function removePromptInjections(list) {
    list.querySelectorAll('.pd-pm-banner').forEach((banner) => banner.remove());
    list.querySelectorAll('li[data-pm-identifier]').forEach((row) => {
        row.classList.remove('pd-pm-hidden', 'pd-pm-member');
        row.querySelectorAll('.pd-pm-marker').forEach((marker) => marker.remove());
    });
}

function toggleGroupCollapsed(groupId) {
    if (soloGroupId) {
        soloGroupId = null;
    }
    if (collapsedGroups.has(groupId)) {
        collapsedGroups.delete(groupId);
    } else {
        collapsedGroups.add(groupId);
    }
    syncPromptGroups();
}

function buildGroupBanner(group, count) {
    const banner = document.createElement('li');
    banner.className = 'pd-pm-banner';
    banner.dataset.pdGroup = group.id;
    if (soloGroupId === group.id) {
        banner.classList.add('pd-pm-solo');
    }
    if (collapsedGroups.has(group.id) && soloGroupId !== group.id) {
        banner.classList.add('pd-pm-collapsed');
    }
    banner.innerHTML = `
        <div class="pd-fold" title="折叠 / 展开"><i class="fa-solid fa-caret-down"></i></div>
        <span class="pd-pm-banner-name" title="${escapeHtml(group.name)}">${escapeHtml(group.name)}</span>
        <span class="pd-section-count">${count}</span>
        <div class="pd-pm-solo-toggle" title="只看这一组"><i class="fa-solid fa-filter"></i></div>
        <div class="pd-icon-button pd-pm-group-remove" title="删除分组"><i class="fa-solid fa-trash-can"></i></div>
    `;
    banner.querySelector('.pd-fold').addEventListener('click', (event) => {
        event.stopPropagation();
        toggleGroupCollapsed(group.id);
    });
    banner.querySelector('.pd-pm-banner-name').addEventListener('click', () => toggleGroupCollapsed(group.id));
    banner.querySelector('.pd-pm-solo-toggle').addEventListener('click', (event) => {
        event.stopPropagation();
        soloGroupId = soloGroupId === group.id ? null : group.id;
        syncPromptGroups();
        renderPromptGroupSettings();
    });
    banner.querySelector('.pd-pm-group-remove').addEventListener('click', (event) => {
        event.stopPropagation();
        deletePromptGroup(group.id);
        syncPromptGroups();
        renderPromptGroupSettings();
    });
    return banner;
}

function buildRowMarker(row, groups) {
    const marker = document.createElement('span');
    marker.className = 'pd-pm-marker';
    marker.dataset.pdIdentifier = row.dataset.pmIdentifier;
    if (groups.length === 0) {
        marker.classList.add('pd-pm-marker-empty');
    }
    marker.title = groups.length > 0
        ? groups.map((group) => group.name).join(' / ')
        : '加入分组';
    marker.innerHTML = `
        <i class="fa-solid fa-tag"></i>
        <span class="pd-pm-marker-text">${escapeHtml(groups.length > 0 ? groups.map((group) => group.name).join(' / ') : '分组')}</span>
    `;
    marker.addEventListener('mousedown', (event) => event.stopPropagation());
    marker.addEventListener('touchstart', (event) => event.stopPropagation());
    marker.addEventListener('click', (event) => {
        event.stopPropagation();
        openGroupMenu(row, marker);
    });
    return marker;
}

function syncPromptGroups() {
    const container = document.getElementById(PROMPT_CONTAINER_ID);
    if (!container) {
        return;
    }
    const list = container.querySelector(`#${PROMPT_LIST_ID}`);
    if (!list) {
        return;
    }

    promptObserver?.disconnect();
    removePromptInjections(list);

    const rows = Array.from(list.querySelectorAll('li[data-pm-identifier]'));
    const pg = getPromptGroups();
    const ready = getSettings().enabled && getSettings().promptGroupsEnabled && rows.length > 0 && pg.groups.length > 0;

    if (!ready) {
        rows.forEach((row) => row.classList.remove('pd-pm-hidden'));
        promptObserver?.observe(container, { childList: true, subtree: true });
        return;
    }

    const validIds = new Set(pg.groups.map((group) => group.id));
    const members = new Map(pg.groups.map((group) => [group.id, []]));
    const rowGroups = new Map();

    for (const row of rows) {
        const ids = normalizeIds(pg.assign[row.dataset.pmIdentifier]).filter((id) => validIds.has(id));
        rowGroups.set(row, ids);
        for (const id of ids) {
            members.get(id).push(row);
        }
    }

    for (const group of pg.groups) {
        const own = members.get(group.id);
        if (own.length === 0) {
            continue;
        }
        list.insertBefore(buildGroupBanner(group, own.length), own[0]);
        own.forEach((row) => row.classList.add('pd-pm-member'));
    }

    for (const row of rows) {
        const names = rowGroups.get(row)
            .map((id) => pg.groups.find((group) => group.id === id))
            .filter(Boolean);
        row.appendChild(buildRowMarker(row, names));
    }

    for (const row of rows) {
        const ids = rowGroups.get(row);
        if (soloGroupId) {
            if (!ids.includes(soloGroupId)) {
                row.classList.add('pd-pm-hidden');
            }
        } else if (ids.length > 0 && ids.every((id) => collapsedGroups.has(id))) {
            row.classList.add('pd-pm-hidden');
        }
    }

    if (soloGroupId) {
        list.querySelectorAll('.pd-pm-banner').forEach((banner) => {
            if (banner.dataset.pdGroup !== soloGroupId) {
                banner.classList.add('pd-pm-hidden');
            }
        });
    }

    promptObserver?.observe(container, { childList: true, subtree: true });
}

function observePromptManager() {
    const container = document.getElementById(PROMPT_CONTAINER_ID);
    if (!container) {
        return;
    }
    if (!promptObserver) {
        promptObserver = new MutationObserver(() => schedulePromptSync());
    }
    promptObserver.disconnect();
    promptObserver.observe(container, { childList: true, subtree: true });
}

const queuePromptSync = debounce(() => {
    promptSyncQueued = false;
    syncPromptGroups();
}, 80);

function schedulePromptSync() {
    if (promptSyncQueued) {
        return;
    }
    promptSyncQueued = true;
    queuePromptSync();
}

function ensureGroupMenu() {
    if (groupMenuEl) {
        return groupMenuEl;
    }
    groupMenuAbort = new AbortController();
    groupMenuEl = document.createElement('div');
    groupMenuEl.className = 'pd-pm-menu';
    groupMenuEl.innerHTML = `
        <div class="pd-pm-menu-head">
            <span class="pd-pm-menu-title"></span>
            <div class="pd-icon-button pd-pm-menu-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="pd-pm-menu-body"></div>
        <div class="pd-pm-menu-foot">
            <input class="pd-pm-new text_pole" type="text" placeholder="新分组名…" />
            <div class="pd-pm-new-add menu_button">新建并加入</div>
        </div>
    `;
    document.body.appendChild(groupMenuEl);

    const stopNavbarAutoclose = (event) => event.stopPropagation();
    groupMenuEl.addEventListener('mousedown', stopNavbarAutoclose);
    groupMenuEl.addEventListener('touchstart', stopNavbarAutoclose);

    groupMenuEl.querySelector('.pd-pm-menu-close').addEventListener('click', () => closeGroupMenu());
    groupMenuEl.querySelector('.pd-pm-new-add').addEventListener('click', () => {
        const input = groupMenuEl.querySelector('.pd-pm-new');
        const name = input.value.trim();
        if (!groupMenuIdentifier || !name) {
            return;
        }
        const group = createPromptGroup(name);
        const ids = normalizeIds(getPromptGroups().assign[groupMenuIdentifier]);
        setPromptGroupsFor(groupMenuIdentifier, [...ids, group.id]);
        input.value = '';
        renderGroupMenuBody();
        syncPromptGroups();
        renderPromptGroupSettings();
    });

    document.addEventListener('mousedown', (event) => {
        if (!groupMenuEl || groupMenuEl.style.display === 'none' || !groupMenuIdentifier) {
            return;
        }
        const target = event.target;
        if (groupMenuEl.contains(target)) {
            return;
        }
        if (target instanceof Element && target.closest('.pd-pm-marker')) {
            return;
        }
        closeGroupMenu();
    }, { signal: groupMenuAbort.signal });

    return groupMenuEl;
}

function renderGroupMenuBody() {
    const body = groupMenuEl.querySelector('.pd-pm-menu-body');
    const pg = getPromptGroups();
    const ids = normalizeIds(pg.assign[groupMenuIdentifier]);
    body.innerHTML = '';

    if (pg.groups.length === 0) {
        body.innerHTML = '<div class="pd-empty-state">还没有分组，在下面输入名字建一个</div>';
        return;
    }

    for (const group of pg.groups) {
        const label = document.createElement('label');
        label.className = 'checkbox_label pd-pm-menu-row';
        label.innerHTML = `
            <input type="checkbox" ${ids.includes(group.id) ? 'checked' : ''} />
            <span>${escapeHtml(group.name)}</span>
        `;
        label.querySelector('input').addEventListener('change', (event) => {
            const current = normalizeIds(getPromptGroups().assign[groupMenuIdentifier]);
            const next = event.target.checked
                ? [...current, group.id]
                : current.filter((id) => id !== group.id);
            setPromptGroupsFor(groupMenuIdentifier, next);
            renderGroupMenuBody();
            syncPromptGroups();
            renderPromptGroupSettings();
        });
        body.appendChild(label);
    }

    if (ids.length > 0) {
        const clear = document.createElement('div');
        clear.className = 'pd-pm-menu-clear';
        clear.textContent = '把这个条目移出所有分组';
        clear.addEventListener('click', () => {
            setPromptGroupsFor(groupMenuIdentifier, []);
            renderGroupMenuBody();
            syncPromptGroups();
            renderPromptGroupSettings();
        });
        body.appendChild(clear);
    }
}

function openGroupMenu(row, marker) {
    const menu = ensureGroupMenu();
    groupMenuIdentifier = row.dataset.pmIdentifier;
    menu.querySelector('.pd-pm-menu-title').textContent =
        row.querySelector('.completion_prompt_manager_prompt_name')?.dataset.pmName || groupMenuIdentifier;
    renderGroupMenuBody();

    menu.style.display = 'flex';
    const rect = marker.getBoundingClientRect();
    const width = menu.offsetWidth || 260;
    const left = Math.max(8, Math.min(rect.right - width + window.scrollX, window.scrollX + window.innerWidth - width - 8));
    menu.style.left = `${left}px`;
    menu.style.top = `${rect.bottom + window.scrollY + 4}px`;
}

function closeGroupMenu() {
    if (groupMenuEl) {
        groupMenuEl.style.display = 'none';
    }
    groupMenuIdentifier = null;
}

// 折叠状态记在各自的 Set 里：分组用 groupId，预设块用 `${groupId}::${presetName}`
function toggleCollapsed(block, key, store) {
    if (block.classList.toggle('pd-collapsed')) {
        store.add(key);
    } else {
        store.delete(key);
    }
}

// 触摸设备不会派发 dblclick（F12 切到触摸模拟、真机的双击缩放都会吃掉它），
// 所以条目行额外支持长按打开，双击照旧保留。
const ENTRY_LONG_PRESS_MS = 500;
let suppressClickUntil = 0;

function bindEntryLongPress(row, action) {
    let timer = null;

    const clear = () => {
        if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
        }
    };

    // 长按已经打开了弹窗，抬手那一下不要再当点击处理，否则会连带触发编辑。
    row.addEventListener(
        'click',
        (event) => {
            if (Date.now() < suppressClickUntil) {
                event.preventDefault();
                event.stopPropagation();
            }
        },
        true,
    );

    row.addEventListener('pointerdown', (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) {
            return;
        }
        clear();
        timer = window.setTimeout(() => {
            clear();
            suppressClickUntil = Date.now() + 600;
            action();
        }, ENTRY_LONG_PRESS_MS);
    });

    const cancel = () => clear();
    row.addEventListener('pointerup', cancel);
    row.addEventListener('pointercancel', cancel);
    row.addEventListener('pointerleave', cancel);
}

function buildEntryRow(presetName, entry, groupId) {
    const row = document.createElement('div');
    row.className = 'pd-entry';

    const title = document.createElement('span');
    title.className = 'pd-entry-title';
    title.textContent = entry.name;

    const count = document.createElement('span');
    count.className = 'pd-section-count';
    count.textContent = `${entry.content.length} 字`;

    const detach = document.createElement('div');
    detach.className = 'pd-icon-button pd-entry-detach';
    detach.title = '把这个条目从当前分组里移出';
    detach.innerHTML = '<i class="fa-solid fa-trash-can"></i>';

    row.append(title, count, detach);

    const open = () => openEntryEditor(presetName, entry.identifier);
    row.addEventListener('dblclick', open);
    bindEntryLongPress(row, open);

    detach.addEventListener('click', (event) => {
        event.stopPropagation();
        void detachEntryFromGroup(groupId, entry);
    });
    return row;
}

async function detachEntryFromGroup(groupId, entry) {
    const pg = getPromptGroups();
    const group = pg.groups.find((group) => group.id === groupId);
    const assigned = normalizeIds(pg.assign[entry.identifier] ?? []);
    if (!assigned.includes(groupId)) {
        return;
    }

    const confirmed = await Popup.show.confirm(
        '移出分组归属',
        `把「${escapeHtml(entry.name)}」从分组「${escapeHtml(group?.name ?? groupId)}」里移出？条目本身还在预设文件里。`,
    );
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    const next = assigned.filter((id) => id !== groupId);
    if (next.length > 0) {
        pg.assign[entry.identifier] = [...new Set(next)];
    } else {
        delete pg.assign[entry.identifier];
    }
    saveSettingsDebounced();
    renderPromptGroupSettings();
    syncPromptGroups();
}

function buildPresetBlock(groupId, presetName, entries) {
    const key = `${groupId}::${presetName}`;
    const block = document.createElement('div');
    block.className = 'pd-preset-block';
    if (collapsedSettingPresets.has(key)) {
        block.classList.add('pd-collapsed');
    }

    const head = document.createElement('div');
    head.className = 'pd-preset-head';
    head.innerHTML = `
        <div class="pd-fold" title="折叠 / 展开"><i class="fa-solid fa-caret-down"></i></div>
        <span class="pd-preset-name">${escapeHtml(presetName)}</span>
        <span class="pd-section-count">${entries.length} 个条目</span>
    `;
    const toggle = () => toggleCollapsed(block, key, collapsedSettingPresets);
    head.querySelector('.pd-fold').addEventListener('click', toggle);
    head.querySelector('.pd-preset-name').addEventListener('click', toggle);
    block.appendChild(head);

    const body = document.createElement('div');
    body.className = 'pd-preset-body';
    for (const entry of entries) {
        body.appendChild(buildEntryRow(presetName, entry, groupId));
    }
    block.appendChild(body);
    return block;
}

function buildSettingGroupBlock(group, presetBlocks) {
    const block = document.createElement('div');
    block.className = 'pd-group-block';
    if (collapsedSettingGroups.has(group.id)) {
        block.classList.add('pd-collapsed');
    }

    const head = document.createElement('div');
    head.className = 'pd-group-head';
    head.innerHTML = `
        <div class="pd-fold" title="折叠 / 展开"><i class="fa-solid fa-caret-down"></i></div>
        <input class="text_pole flex1 pd-group-name" value="${escapeHtml(group.name)}" />
        <div class="pd-icon-button pd-group-remove" title="删除分组"><i class="fa-solid fa-trash-can"></i></div>
    `;
    head.querySelector('.pd-fold').addEventListener('click', () => toggleCollapsed(block, group.id, collapsedSettingGroups));

    const input = head.querySelector('.pd-group-name');
    const commit = () => {
        const current = getPromptGroups().groups.find((item) => item.id === group.id);
        if (!current) {
            return;
        }
        const next = input.value.trim();
        if (!next || next === current.name) {
            input.value = current.name;
            return;
        }
        renamePromptGroup(group.id, next);
        // 改成已有分组的名字会合并两个分组，结构变了必须重画；
        // 否则只同步条目列表里的标记，不重画面板——重画会在
        // mousedown → 失焦 → mouseup → click 的序列中途销毁输入框。
        if (!getPromptGroups().groups.some((item) => item.id === group.id)) {
            renderPromptGroupSettings();
        }
        syncPromptGroups();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            input.blur();
        }
    });

    head.querySelector('.pd-group-remove').addEventListener('click', () => {
        deletePromptGroup(group.id);
        collapsedSettingGroups.delete(group.id);
        renderPromptGroupSettings();
        syncPromptGroups();
    });
    block.appendChild(head);

    const body = document.createElement('div');
    body.className = 'pd-group-body';
    if (presetBlocks.length === 0) {
        body.innerHTML = '<small class="pd-settings-hint">该分组还没有条目</small>';
    } else {
        for (const presetBlock of presetBlocks) {
            body.appendChild(presetBlock);
        }
    }
    block.appendChild(body);
    return block;
}

function renderPromptGroupSettings() {
    const container = document.querySelector('#pd_prompt_groups');
    if (!container) {
        return;
    }
    const pg = getPromptGroups();
    container.innerHTML = '';

    if (pg.groups.length === 0) {
        container.innerHTML = '<small class="pd-settings-hint">分组仅对条目进行标记，不改动提示词顺序</small>';
        return;
    }

    const presets = getPromptPresetEntries();
    // 只判断「预设列表为空」不够：更常见的情况是预设名字在、但预设内容
    // 还没加载进来（这时每个分组都会显示成空的，比给一句提示更容易误导）。
    if (!presets.some((preset) => preset.entries.length > 0)) {
        container.innerHTML = '<small class="pd-settings-hint">读不到 Chat Completion 预设内容，稍后再打开此面板</small>';
        return;
    }

    const validIds = new Set(pg.groups.map((group) => group.id));
    const assign = new Map();
    for (const [identifier, ids] of Object.entries(pg.assign)) {
        const kept = normalizeIds(ids).filter((id) => validIds.has(id));
        if (kept.length > 0) {
            assign.set(identifier, kept);
        }
    }

    for (const group of pg.groups) {
        const presetBlocks = [];
        for (const preset of presets) {
            const entries = preset.entries
                .filter((entry) => (assign.get(entry.identifier) ?? []).includes(group.id));
            if (entries.length > 0) {
                presetBlocks.push(buildPresetBlock(group.id, preset.name, entries));
            }
        }
        container.appendChild(buildSettingGroupBlock(group, presetBlocks));
    }
}

function mountPromptGroups() {
    $('#pd_prompt_group_add').on('click', () => {
        createPromptGroup('新分组');
        renderPromptGroupSettings();
        syncPromptGroups();
    });
    renderPromptGroupSettings();
}

/* ------------------------------------------------------------------ *
 * 条目编辑弹窗
 *
 * 结构照着酒馆原生的条目编辑框做。原生那个不能直接调用：它绑死在「当前激活
 * 预设」上（openai.js 建立条目管理器时传进去的就是当前设置对象），改不了别的
 * 预设，只能自己复刻一份。
 * 写盘也不走 PresetManager.savePreset —— 它内部会调 updateList，把预设下拉切到
 * 被保存的那一个，等于顺手改了用户的当前预设。
 * ------------------------------------------------------------------ */

let entryEditorEl = null;
let entryEditorCtx = null;

function findPresetObject(presetName) {
    const manager = getAdapter(PROMPT_PRESET_API).manager;
    if (!manager || typeof manager.getCompletionPresetByName !== 'function') {
        return null;
    }
    try {
        return manager.getCompletionPresetByName(presetName) ?? null;
    } catch (error) {
        console.warn(`${TAG} 读不到预设对象`, error);
        return null;
    }
}

function isActivePreset(presetName) {
    return Boolean(chatCompletionSettings) && chatCompletionSettings.preset_settings_openai === presetName;
}

// 当前激活的预设要以运行时那份为准：用户在酒馆的条目列表里改过的内容还没写进
// 预设文件的快照，拿快照去显示或回写都会把人刚做的改动盖掉。
function getLivePreset(presetName) {
    if (isActivePreset(presetName) && Array.isArray(chatCompletionSettings.prompts)) {
        return chatCompletionSettings;
    }
    return findPresetObject(presetName);
}

function findPresetEntry(presetName, identifier) {
    const source = getLivePreset(presetName);
    const list = Array.isArray(source?.prompts) ? source.prompts : [];
    return list.find((item) => item && item.identifier === identifier) ?? null;
}

// 与 PromptManager.isPromptEditAllowed 一致：marker 条目的正文由运行时生成，
// 只有白名单里那几个例外还能改。
function canEditEntryContent(identifier, entry) {
    return !entry?.marker || EDITABLE_MARKER_IDS.has(identifier);
}

function toPositiveInt(raw, fallback) {
    if (raw === '' || raw === null || raw === undefined) {
        return fallback;
    }
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : fallback;
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function ensureEntryEditor() {
    if (entryEditorEl) {
        return entryEditorEl;
    }
    // 用原生 dialog：居中、顶层、Esc、遮罩都交给浏览器，跟酒馆自带弹窗同一套
    entryEditorEl = document.createElement('dialog');
    entryEditorEl.className = 'pd-editor';
    entryEditorEl.innerHTML = `
        <div class="pd-editor-head">
            <span class="pd-editor-title">编辑</span>
            <div class="pd-icon-button pd-editor-close" title="关闭"><i class="fa-solid fa-xmark"></i></div>
        </div>
        <div class="pd-editor-body">
            <div class="pd-editor-meta">
                <span class="pd-editor-preset"></span>
            </div>
            <div class="pd-editor-row">
                <label class="pd-editor-field">
                    <span class="pd-editor-label">姓名</span>
                    <input class="text_pole pd-editor-name" type="text" />
                    <small class="pd-settings-hint">此提示词的名称。</small>
                </label>
                <label class="pd-editor-field pd-editor-field-narrow">
                    <span class="pd-editor-label">身份</span>
                    <select class="text_pole pd-editor-role"></select>
                    <small class="pd-settings-hint">此消息应归于谁。</small>
                </label>
            </div>
            <div class="pd-editor-row">
                <label class="pd-editor-field">
                    <span class="pd-editor-label">触发器</span>
                    <select class="text_pole pd-editor-triggers" multiple></select>
                    <small class="pd-settings-hint">筛选到特定的生成类型。</small>
                </label>
                <label class="pd-editor-field pd-editor-field-narrow">
                    <span class="pd-editor-label">位置</span>
                    <select class="text_pole pd-editor-position">
                        <option value="0">相对</option>
                        <option value="1">聊天中</option>
                    </select>
                    <small class="pd-settings-hint">相对（相对于提示词管理器中的其他提示词）或在聊天中的指定深度。</small>
                </label>
            </div>
            <div class="pd-editor-row pd-editor-depth-order-row">
                <label class="pd-editor-field">
                    <span class="pd-editor-label">深度</span>
                    <input class="text_pole pd-editor-depth" type="number" min="0" max="9999" />
                    <small class="pd-settings-hint">“0”为在最后一条消息之后，“1”为在最后一条消息之前，等等。</small>
                </label>
                <label class="pd-editor-field">
                    <span class="pd-editor-label">排序</span>
                    <input class="text_pole pd-editor-order" type="number" min="0" max="9999" />
                    <small class="pd-settings-hint">从低/顶到高/底排序，并按相同顺序：助手、用户、系统。</small>
                </label>
            </div>
            <div class="pd-editor-forbid-block" title="即使选择覆盖，此提示词也不能被角色卡覆盖。">
                <label class="checkbox_label">
                    <input class="pd-editor-forbid" type="checkbox" />
                    <span>禁止覆盖</span>
                </label>
            </div>
            <div class="pd-editor-content-head">
                <span>提示词</span>
                <span class="pd-section-count pd-editor-count"></span>
            </div>
            <textarea class="text_pole pd-editor-content" rows="10"></textarea>
            <small class="pd-settings-hint pd-editor-lock-hint"></small>
        </div>
        <div class="pd-editor-foot">
            <div class="menu_button pd-editor-cancel">取消</div>
            <div class="menu_button pd-editor-save">保存</div>
        </div>
    `;
    document.body.appendChild(entryEditorEl);

    const stopNavbarAutoclose = (event) => event.stopPropagation();
    entryEditorEl.addEventListener('mousedown', stopNavbarAutoclose);
    entryEditorEl.addEventListener('touchstart', stopNavbarAutoclose);

    entryEditorEl.querySelector('.pd-editor-role').innerHTML = ROLE_OPTIONS
        .map(({ value, label }) => `<option value="${value}">${escapeHtml(label)}</option>`)
        .join('');
    entryEditorEl.querySelector('.pd-editor-triggers').innerHTML = TRIGGER_OPTIONS
        .map(({ value, label }) => `<option value="${value}">${escapeHtml(label)}</option>`)
        .join('');
    // 原生这个字段也是 select2 下拉，点开才列选项，不直接摊开六个
    initTriggerSelect(entryEditorEl.querySelector('.pd-editor-triggers'));

    // 浏览器给 modal dialog 的 Esc 自带关闭，拦下来走统一的未保存确认
    entryEditorEl.addEventListener('cancel', (event) => {
        event.preventDefault();
        void closeEntryEditor();
    });
    // 点在弹窗外（遮罩上）也算关闭，事件目标就是弹窗自己
    entryEditorEl.addEventListener('click', (event) => {
        if (event.target === entryEditorEl) {
            void closeEntryEditor();
        }
    });

    entryEditorEl.querySelector('.pd-editor-close').addEventListener('click', () => { void closeEntryEditor(); });
    entryEditorEl.querySelector('.pd-editor-cancel').addEventListener('click', () => { void closeEntryEditor(); });
    entryEditorEl.querySelector('.pd-editor-save').addEventListener('click', () => { void saveEntryEditor(); });
    entryEditorEl.querySelector('.pd-editor-content').addEventListener('input', updateEntryEditorCount);
    entryEditorEl.querySelector('.pd-editor-position').addEventListener('change', syncEntryEditorPositionState);
    entryEditorEl.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            void closeEntryEditor();
        }
    });
    return entryEditorEl;
}

function initTriggerSelect(select) {
    const $ = window.jQuery;
    if (!$ || !$.fn || typeof $.fn.select2 !== 'function') {
        return;
    }
    $(select).select2({
        placeholder: '所有类型（默认）',
        width: '100%',
        closeOnSelect: false,
        // dialog 用 showModal 进顶层后，挂在 body 下的下拉会被遮罩压住，
        // 所以把面板收进弹窗里（酒馆自己的弹窗也是这么写的）
        dropdownParent: $(entryEditorEl),
        dropdownCssClass: 'pd-select2-dropdown',
    });
}

function destroyTriggerSelect() {
    const select = entryEditorEl?.querySelector('.pd-editor-triggers');
    const $ = window.jQuery;
    if (!select || !$ || !$.fn || typeof $.fn.select2 !== 'function') {
        return;
    }
    if ($(select).data('select2')) {
        $(select).select2('destroy');
    }
}

function updateEntryEditorCount() {
    if (!entryEditorEl) {
        return;
    }
    const length = entryEditorEl.querySelector('.pd-editor-content').value.length;
    entryEditorEl.querySelector('.pd-editor-count').textContent = `${length} 字`;
}

function syncEntryEditorPositionState() {
    if (!entryEditorEl) {
        return;
    }
    const absolute = entryEditorEl.querySelector('.pd-editor-position').value === '1';
    const row = entryEditorEl.querySelector('.pd-editor-depth-order-row');
    if (row) {
        // 这里不用原生的 visibility：那玩意只藏内容、照旧占着高度，窄屏上字段竖排时
        // 位置与提示词之间会凭空空出小一百来像素。改成隐藏就彻底不占位。
        row.style.display = absolute ? '' : 'none';
    }
}

function snapshotEditableFields(entry) {
    return {
        name: typeof entry.name === 'string' ? entry.name : '',
        // ROLE_OPTIONS 是 {value,label} 数组，不能直接 includes 字符串
        role: ROLE_OPTIONS.some((option) => option.value === entry.role) ? entry.role : 'system',
        content: typeof entry.content === 'string' ? entry.content : '',
        injection_position: Number(entry.injection_position) === 1 ? 1 : 0,
        injection_depth: toPositiveInt(entry.injection_depth, 4),
        injection_order: toPositiveInt(entry.injection_order, 100),
        injection_trigger: Array.isArray(entry.injection_trigger) ? [...entry.injection_trigger] : null,
        forbid_overrides: Boolean(entry.forbid_overrides),
    };
}

function fillTriggerSelect(select, raw) {
    const values = Array.isArray(raw) ? raw : [];
    for (const option of select.options) {
        option.selected = values.includes(option.value);
    }
}

function collectEntryForm() {
    const el = entryEditorEl;
    return {
        name: el.querySelector('.pd-editor-name').value.trim(),
        role: el.querySelector('.pd-editor-role').value,
        content: el.querySelector('.pd-editor-content').value,
        injection_position: el.querySelector('.pd-editor-position').value === '1' ? 1 : 0,
        injection_depth: toPositiveInt(el.querySelector('.pd-editor-depth').value, 4),
        injection_order: toPositiveInt(el.querySelector('.pd-editor-order').value, 100),
        injection_trigger: Array.from(el.querySelector('.pd-editor-triggers').selectedOptions)
            .map((option) => option.value),
        forbid_overrides: el.querySelector('.pd-editor-forbid').checked,
    };
}

function isEntryDirty() {
    if (!entryEditorCtx) {
        return false;
    }
    const next = collectEntryForm();
    const before = entryEditorCtx.original;
    return next.name !== before.name
        || next.role !== before.role
        || next.content !== before.content
        || next.injection_position !== before.injection_position
        || next.injection_depth !== before.injection_depth
        || next.injection_order !== before.injection_order
        || next.forbid_overrides !== before.forbid_overrides
        || [...next.injection_trigger].sort().join('|') !== [...(before.injection_trigger ?? [])].sort().join('|');
}

async function confirmDiscardEntryEdit(presetName, identifier) {
    const result = await Popup.show.confirm('放弃修改？', '本次改动尚未保存。<br>确认取消？');
    if (result !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }
    entryEditorCtx = null;
    openEntryEditor(presetName, identifier);
}

function openEntryEditor(presetName, identifier) {
    // 弹窗里正开着另一个条目且改过东西，直接换等于把它静默丢掉，先问一次
    if (entryEditorCtx && isEntryDirty()) {
        void confirmDiscardEntryEdit(presetName, identifier);
        return;
    }
    const entry = findPresetEntry(presetName, identifier);
    if (!entry) {
        toastr.warning('读不到这个条目的内容，刷新页面后再试');
        return;
    }

    const el = ensureEntryEditor();
    const original = snapshotEditableFields(entry);
    entryEditorCtx = { presetName, identifier, original };

    el.querySelector('.pd-editor-preset').textContent = presetName;
    el.dataset.pdIdentifier = identifier;

    el.querySelector('.pd-editor-name').value = original.name;
    el.querySelector('.pd-editor-role').value = original.role;
    fillTriggerSelect(el.querySelector('.pd-editor-triggers'), entry.injection_trigger);
    el.querySelector('.pd-editor-position').value = String(original.injection_position);
    el.querySelector('.pd-editor-depth').value = String(original.injection_depth);
    el.querySelector('.pd-editor-order').value = String(original.injection_order);
    el.querySelector('.pd-editor-forbid').checked = original.forbid_overrides;
    const forbidBlock = el.querySelector('.pd-editor-forbid-block');
    // 同深度排序那块：不用 visibility，隐藏就别占位（原生 PopupManager 那边是留位置的）
    forbidBlock.style.display = OVERRIDABLE_PROMPT_IDS.includes(identifier) ? '' : 'none';

    const editable = canEditEntryContent(identifier, entry);
    const contentField = el.querySelector('.pd-editor-content');
    contentField.value = original.content;
    contentField.readOnly = !editable;
    el.querySelector('.pd-editor-lock-hint').textContent = editable
        ? ''
        : '此提示词的内容是从其他地方提取的，无法在此处进行编辑。';

    syncEntryEditorPositionState();
    updateEntryEditorCount();
    if (!el.open) {
        el.showModal();
    }
    el.querySelector('.pd-editor-name').focus();
}

async function closeEntryEditor() {
    if (entryEditorCtx && isEntryDirty()) {
        const result = await Popup.show.confirm('放弃修改？', '本次改动尚未保存。<br>确认取消？');
        if (result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }
    }
    if (entryEditorEl && entryEditorEl.open) {
        entryEditorEl.close();
    }
    entryEditorCtx = null;
}

async function saveEntryEditor() {
    const ctx = entryEditorCtx;
    if (!ctx) {
        return;
    }
    const patch = collectEntryForm();
    if (!patch.name) {
        toastr.warning('条目名不能为空');
        return;
    }
    // 一个字没改就别折腾：备份、确认、写盘三样都不该发生，直接关掉
    if (!isEntryDirty()) {
        await closeEntryEditor();
        return;
    }

    const entry = findPresetEntry(ctx.presetName, ctx.identifier);
    if (!canEditEntryContent(ctx.identifier, entry)) {
        delete patch.content;
    }
    // 原本没有这个字段的条目，一个触发类型都没选就不要凭空写个空数组进去
    if (patch.injection_trigger.length === 0 && ctx.original.injection_trigger === null) {
        delete patch.injection_trigger;
    }

    // 备份关着时「只能通过备份还原」不成立，后半句跟着省掉。
    // 换行用 <br>：Popup 是把描述当 HTML 塞进去的（content.innerHTML = content），\n 不会生效。
    const backupNote = getSettings().backupBeforeSave ? '，之后只能通过备份还原' : '';
    const confirmed = await Popup.show.confirm(
        '写入预设文件',
        `本次改动将写入预设「${escapeHtml(ctx.presetName)}」文件内${backupNote}。<br>确认保存？`,
    );
    if (confirmed !== POPUP_RESULT.AFFIRMATIVE) {
        return;
    }

    if (getSettings().backupBeforeSave) {
        const backedUp = await backupPreset(ctx.presetName);
        if (!backedUp) {
            const proceed = await Popup.show.confirm('备份没做成', '没能留下备份。仍然要写入吗？');
            if (proceed !== POPUP_RESULT.AFFIRMATIVE) {
                return;
            }
        }
    }

    const saved = await writePresetEntry(ctx.presetName, ctx.identifier, patch);
    if (!saved) {
        return;
    }

    toastr.success(`已保存「${patch.name}」`);
    if (entryEditorEl && entryEditorEl.open) {
        entryEditorEl.close();
    }
    entryEditorCtx = null;
    renderPromptGroupSettings();
    syncPromptGroups();
}

async function writePresetEntry(presetName, identifier, patch) {
    const source = findPresetObject(presetName);
    if (!source) {
        toastr.error('读不到这个预设，刷新页面后再试');
        return false;
    }

    const preset = structuredClone(source);
    if (isActivePreset(presetName)) {
        // 运行时的提示词与顺序才是最新的，先让它们盖过快照
        preset.prompts = structuredClone(chatCompletionSettings.prompts);
        preset.prompt_order = structuredClone(chatCompletionSettings.prompt_order);
    }

    const list = Array.isArray(preset.prompts) ? preset.prompts : [];
    const target = list.find((item) => item && item.identifier === identifier);
    if (!target) {
        toastr.error('这个预设里找不到该条目');
        return false;
    }
    Object.assign(target, patch);

    let response;
    try {
        response = await fetch('/api/presets/save', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ apiId: PROMPT_PRESET_API, name: presetName, preset }),
        });
    } catch (error) {
        console.warn(`${TAG} 保存预设失败`, error);
        toastr.error('保存失败，预设文件没有改动');
        return false;
    }
    if (!response.ok) {
        console.warn(`${TAG} 保存预设失败`, response.status);
        toastr.error('保存失败，预设文件没有改动');
        return false;
    }

    applyPresetToMemory(presetName, preset);
    if (isActivePreset(presetName)) {
        const runtimeEntry = (chatCompletionSettings.prompts ?? [])
            .find((item) => item && item.identifier === identifier);
        if (runtimeEntry) {
            Object.assign(runtimeEntry, patch);
        }
    }
    // 写盘接口只负责落文件，不管页面上的列表。不刷新的话条目改名要等刷新页面才看得到。
    void refreshNativePromptList();
    return true;
}

// render(false) 里的 false 表示不额外跑一次生成试算，只重绘图。
async function refreshNativePromptList() {
    try {
        const module = await import(NATIVE_PROMPT_MODULE);
        module.promptManager?.render(false);
    } catch (error) {
        console.warn(`${TAG} 没能刷新原生条目列表，改动已写入文件`, error);
    }
}

// 只替换这一个预设对象，不碰下拉选中项 —— savePreset 内部的 updateList 会把
// 当前预设切到被保存的那个，那不是这里该有的副作用。
function applyPresetToMemory(presetName, preset) {
    const manager = getAdapter(PROMPT_PRESET_API).manager;
    if (!manager || typeof manager.getPresetList !== 'function') {
        return;
    }
    try {
        const { presets, preset_names: names } = manager.getPresetList();
        if (!Array.isArray(presets)) {
            return;
        }
        if (Array.isArray(names)) {
            const index = names.indexOf(presetName);
            if (index >= 0) {
                presets[index] = preset;
            }
            return;
        }
        if (names && typeof names === 'object' && typeof names[presetName] === 'number') {
            presets[names[presetName]] = preset;
        }
    } catch (error) {
        console.warn(`${TAG} 同步预设内存失败`, error);
    }
}

/* ------------------------------------------------------------------ *
 * 写盘前的备份
 *
 * 走 /api/files/upload 存到酒馆的 user/files 目录；接口只收 a-zA-Z0-9_- 和点号
 * 组成的文件名，所以预设名不进文件名，只把短哈希放进去，全名记在清单里。
 * ------------------------------------------------------------------ */

function makeBackupName(presetName) {
    const now = new Date();
    const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`
        + `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    let hash = 0;
    for (const char of presetName) {
        hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 100000;
    }
    return `${BACKUP_PREFIX}${stamp}-${String(hash).padStart(5, '0')}.json`;
}

// 上传接口收 base64，中文得先按 UTF-8 转成字节
function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

async function backupPreset(presetName) {
    const source = getLivePreset(presetName);
    if (!source) {
        return false;
    }
    const json = JSON.stringify(source, null, 4);
    const name = makeBackupName(presetName);
    try {
        const response = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ name, data: encodeBase64(json) }),
        });
        if (!response.ok) {
            console.warn(`${TAG} 备份失败`, response.status);
            return false;
        }
        const data = await response.json();
        rememberBackup({
            file: typeof data?.path === 'string' && data.path ? data.path : `/user/files/${name}`,
            preset: presetName,
            time: Date.now(),
            size: json.length,
        });
        renderBackupList();
        return true;
    } catch (error) {
        console.warn(`${TAG} 备份失败`, error);
        return false;
    }
}

async function deleteBackupFile(path) {
    try {
        await fetch('/api/files/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: String(path).replace(/^\//, '') }),
        });
    } catch (error) {
        console.warn(`${TAG} 删除备份失败`, error);
    }
}

function rememberBackup(record) {
    const settings = getSettings();
    const kept = [record, ...settings.backups.filter((item) => item.file !== record.file)];
    const dropped = kept.slice(BACKUP_KEEP);
    settings.backups = kept.slice(0, BACKUP_KEEP);
    saveSettingsDebounced();
    // 挤出去的旧备份顺手删掉，免得 user/files 里越堆越多
    for (const item of dropped) {
        void deleteBackupFile(item.file);
    }
}

function formatBackupTime(time) {
    const date = new Date(Number(time) || 0);
    if (Number.isNaN(date.getTime())) {
        return '';
    }
    return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())} `
        + `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function buildBackupRow(record) {
    const row = document.createElement('div');
    row.className = 'pd-backup-row';
    row.innerHTML = `
        <span class="pd-backup-meta">${escapeHtml(formatBackupTime(record.time))} · ${Math.max(1, Math.round(Number(record.size) / 1024))} KB</span>
        <a class="pd-icon-button pd-backup-download" title="下载这份备份" href="${escapeHtml(record.file)}" download><i class="fa-solid fa-download"></i></a>
        <div class="pd-icon-button pd-backup-remove" title="删除这份备份"><i class="fa-solid fa-trash-can"></i></div>
    `;
    row.querySelector('.pd-backup-remove').addEventListener('click', async () => {
        const settings = getSettings();
        settings.backups = settings.backups.filter((item) => item.file !== record.file);
        saveSettingsDebounced();
        renderBackupList();
        await deleteBackupFile(record.file);
    });
    return row;
}

// 备份按预设名分组，每组可折叠；整块区域本身在设置面板里默认收起（见 settings.html）。
function renderBackupList() {
    const container = document.querySelector('#pd_backups');
    if (!container) {
        return;
    }
    const backups = getSettings().backups;
    container.innerHTML = '';

    if (backups.length === 0) {
        container.innerHTML = '<small class="pd-settings-hint">还没有备份</small>';
        return;
    }

    const byPreset = new Map();
    for (const record of backups) {
        if (!byPreset.has(record.preset)) {
            byPreset.set(record.preset, []);
        }
        byPreset.get(record.preset).push(record);
    }

    for (const [preset, records] of byPreset) {
        const collapsed = collapsedBackupGroups.has(preset);
        const group = document.createElement('div');
        group.className = 'pd-backup-group';
        group.innerHTML = `
            <div class="pd-backup-group-head">
                <div class="pd-fold" title="折叠 / 展开"><i class="fa-solid fa-caret-${collapsed ? 'right' : 'down'}"></i></div>
                <span class="pd-backup-preset" title="${escapeHtml(preset)}">${escapeHtml(preset)}</span>
                <span class="pd-section-count">${records.length} 份</span>
            </div>
        `;
        const body = document.createElement('div');
        body.className = 'pd-backup-group-body';
        if (collapsed) {
            body.style.display = 'none';
        }
        for (const record of records) {
            body.appendChild(buildBackupRow(record));
        }
        group.appendChild(body);

        group.querySelector('.pd-backup-group-head').addEventListener('click', () => {
            if (collapsedBackupGroups.has(preset)) {
                collapsedBackupGroups.delete(preset);
            } else {
                collapsedBackupGroups.add(preset);
            }
            renderBackupList();
        });
        container.appendChild(group);
    }
}

/* ------------------------------------------------------------------ *
 * 对外部变化的跟随
 * ------------------------------------------------------------------ */

const queueRender = debounce(() => {
    renderQueued = false;
    if (openApiId) {
        renderPanel();
    }
    for (const apiId of API_IDS) {
        refreshPickerLabel(apiId);
    }
}, 80);

function scheduleRender() {
    if (renderQueued) {
        return;
    }
    renderQueued = true;
    queueRender();
}

const observer = new MutationObserver(() => {
    scheduleRender();
});

function observeSelects() {
    observer.disconnect();
    for (const apiId of API_IDS) {
        const select = findSelect(apiId);
        if (select) {
            observer.observe(select, { childList: true, subtree: true, characterData: true });
        }
    }
}

function bindSelectEvents() {
    for (const apiId of API_IDS) {
        const select = findSelect(apiId);
        if (!select || select.dataset.pdBound === '1') {
            continue;
        }
        select.dataset.pdBound = '1';
        $(select).on('change', () => {
            refreshPickerLabel(apiId);
        });
    }
}

function migrateAssignment(apiId, fromName, toName) {
    const cfg = getApiConfig(apiId);
    if (!Object.hasOwn(cfg.assign, fromName)) {
        return false;
    }
    cfg.assign[toName] = cfg.assign[fromName];
    delete cfg.assign[fromName];
    for (const drawerId of Object.keys(cfg.order)) {
        const order = getOrder(cfg, drawerId);
        const index = order.indexOf(fromName);
        if (index >= 0) {
            order[index] = toName;
        }
    }
    return true;
}

function dropAssignment(apiId, presetName) {
    const cfg = getApiConfig(apiId);
    if (!Object.hasOwn(cfg.assign, presetName)) {
        return false;
    }
    delete cfg.assign[presetName];
    for (const drawerId of Object.keys(cfg.order)) {
        cfg.order[drawerId] = getOrder(cfg, drawerId).filter((name) => name !== presetName);
    }
    return true;
}

/* ------------------------------------------------------------------ *
 * 设置面板
 * ------------------------------------------------------------------ */

async function mountSettings() {
    const html = await renderExtensionTemplateAsync(resolveTemplateId(), 'settings');
    $('#extensions_settings2').append(html);

    const settings = getSettings();
    $('#pd_enabled').prop('checked', settings.enabled).on('change', function () {
        settings.enabled = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        syncAll();
    });
    $('#pd_custom_picker').prop('checked', settings.useCustomPicker).on('change', function () {
        settings.useCustomPicker = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        syncAll();
    });
    $('#pd_prompt_groups_enabled').prop('checked', settings.promptGroupsEnabled).on('change', function () {
        settings.promptGroupsEnabled = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
        syncPromptGroups();
    });
    $('#pd_backup_enabled').prop('checked', settings.backupBeforeSave).on('change', function () {
        settings.backupBeforeSave = Boolean($(this).prop('checked'));
        saveSettingsDebounced();
    });

    $('#pd_open_manager').on('click', () => {
        const apiId = $('#pd_manager_api').val() || API_IDS[0];
        openPanel(apiId);
    });

    $('#pd_reset').on('click', () => {
        const confirmed = window.confirm('将清空所有抽屉、以及全部预设的归类记录。预设文件本身不受影响。确定继续？');
        if (!confirmed) {
            return;
        }
        getSettings().apiConfig = {};
        saveSettingsDebounced();
        refreshPickerLabel(openApiId ?? API_IDS[0]);
        if (openApiId) {
            renderPanel();
        }
    });

    mountPromptGroups();
    renderBackupList();
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

export async function init() {
    getSettings();
    await mountSettings();
    syncAll();
    bindSelectEvents();
    observeSelects();
    observePromptManager();
    syncPromptGroups();

    eventSource.on(eventTypes.PRESET_RENAMED, onPresetRenamed);
    eventSource.on(eventTypes.PRESET_DELETED, onPresetDeleted);
    eventSource.on(eventTypes.CHAT_CHANGED, onChatChanged);

    console.log(`${TAG} ready`);
}

function onPresetRenamed(payload) {
    if (!payload) {
        return;
    }
    const { apiId, oldName, newName } = payload;
    if (migrateAssignment(apiId, oldName, newName)) {
        saveSettingsDebounced();
        scheduleRender();
    }
}

function onPresetDeleted(payload) {
    if (!payload) {
        return;
    }
    const { apiId, name } = payload;
    if (dropAssignment(apiId, name)) {
        saveSettingsDebounced();
        scheduleRender();
    }
}

function onChatChanged() {
    scheduleRender();
}

export function onDisable() {
    for (const apiId of API_IDS) {
        const select = findSelect(apiId);
        if (!select) {
            continue;
        }
        select.classList.remove('pd-hidden');
        const row = select.parentElement;
        row?.querySelector(`.pd-picker[data-pd-api="${apiId}"]`)?.remove();
        row?.querySelector(`.pd-trigger[data-pd-api="${apiId}"]`)?.remove();
    }
    observer.disconnect();
    panelAbort?.abort();
    panelAbort = null;
    panelEl?.remove();
    panelEl = null;
    openApiId = null;

    promptObserver?.disconnect();
    promptObserver = null;
    const promptContainer = document.getElementById(PROMPT_CONTAINER_ID);
    const promptList = promptContainer?.querySelector(`#${PROMPT_LIST_ID}`);
    if (promptList) {
        removePromptInjections(promptList);
    }
    groupMenuAbort?.abort();
    groupMenuAbort = null;
    groupMenuEl?.remove();
    groupMenuEl = null;
    groupMenuIdentifier = null;

    eventSource.removeListener(eventTypes.PRESET_RENAMED, onPresetRenamed);
    eventSource.removeListener(eventTypes.PRESET_DELETED, onPresetDeleted);
    eventSource.removeListener(eventTypes.CHAT_CHANGED, onChatChanged);

    destroyTriggerSelect();
    entryEditorEl?.remove();
    entryEditorEl = null;
    entryEditorCtx = null;
}

/**
 * 清理扩展数据（manifest 里的 clean hook）。
 * 删除或清理扩展时，酒馆会先调这个钩子再写盘、刷新。
 * 扩展设置存在酒馆全局的 extension_settings 里，删目录清不掉，只能在这里删。
 */
export async function cleanup() {
    const settings = getSettings();
    for (const item of [...settings.backups]) {
        void deleteBackupFile(item.file);
    }

    delete extensionSettings[MODULE_NAME];
    // 清理是卸载路径，这里抛错会导致后面清不干净，所以只在确实是数组时才动
    if (Array.isArray(extensionSettings.disabledExtensions)) {
        extensionSettings.disabledExtensions = extensionSettings.disabledExtensions.filter((name) => name !== MODULE_NAME);
    }

    const { saveSettings } = SillyTavern.getContext();
    await saveSettings();
}
