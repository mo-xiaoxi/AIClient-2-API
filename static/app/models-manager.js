/**
 * Models Manager - 管理可用模型列表的显示和复制功能
 * Models Manager - Manages the display and copy functionality of available models
 */

import { t } from './i18n.js';

// 模型数据缓存
let modelsCache = null;

// 提供商配置缓存
let currentProviderConfigs = null;

// API Key 缓存
let cachedApiKey = null;

/**
 * 更新提供商配置
 * @param {Array} configs - 提供商配置列表
 */
function updateModelsProviderConfigs(configs) {
    currentProviderConfigs = configs;
    // 如果已经加载了模型，重新渲染一次以更新显示名称和图标
    if (modelsCache) {
        renderModelsList(modelsCache);
    }
}

/**
 * 获取所有提供商的可用模型
 * @returns {Promise<Object>} 模型数据
 */
async function fetchProviderModels() {
    if (modelsCache) {
        return modelsCache;
    }
    
    try {
        const response = await fetch('/api/provider-models', {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}`
            }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        modelsCache = await response.json();
        return modelsCache;
    } catch (error) {
        console.error('[Models Manager] Failed to fetch provider models:', error);
        throw error;
    }
}

/**
 * 获取 API Key（优先使用缓存）
 * @returns {Promise<string>} API Key
 */
async function getApiKey() {
    if (cachedApiKey) return cachedApiKey;
    try {
        const response = await fetch('/api/config', {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken') || ''}`
            }
        });
        if (response.ok) {
            const data = await response.json();
            cachedApiKey = data.REQUIRED_API_KEY || '';
            return cachedApiKey;
        }
    } catch (e) {
        console.error('[Models Manager] Failed to fetch API key:', e);
    }
    return '';
}

/**
 * 生成 OpenAI 格式的 curl 命令
 * @param {string} modelName - 模型名称
 * @param {string} apiKey - API Key
 * @returns {string} curl 命令
 */
function buildCurlCommand(modelName, apiKey) {
    const baseUrl = window.location.origin;
    const bearer = apiKey || 'YOUR_API_KEY';
    return `curl -X POST ${baseUrl}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${bearer}" \\
  -d '{
    "model": "${modelName}",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'`;
}

/**
 * 生成 Claude 格式的 curl 命令
 * @param {string} modelName - 模型名称
 * @param {string} apiKey - API Key
 * @returns {string} curl 命令
 */
function buildClaudeCurlCommand(modelName, apiKey) {
    const baseUrl = window.location.origin;
    const key = apiKey || 'YOUR_API_KEY';
    return `curl -X POST ${baseUrl}/v1/messages \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: ${key}" \\
  -H "anthropic-version: 2023-06-01" \\
  -d '{
    "model": "${modelName}",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'`;
}

/**
 * 复制文本到剪贴板
 * @param {string} text - 要复制的文本
 * @returns {Promise<boolean>} 是否复制成功
 */
async function copyToClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
        
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '-9999px';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textArea);
        return successful;
    } catch (error) {
        console.error('[Models Manager] Failed to copy to clipboard:', error);
        return false;
    }
}

/**
 * 显示复制成功的 Toast 提示
 * @param {string} modelName - 模型名称
 * @param {string} [format] - 格式名称（OpenAI / Claude）
 */
function showCopyToast(modelName, format) {
    const toastContainer = document.getElementById('toastContainer');
    if (!toastContainer) return;

    const formatLabel = format ? ` (${format})` : '';
    const toast = document.createElement('div');
    toast.className = 'toast toast-success';
    toast.innerHTML = `
        <i class="fas fa-check-circle"></i>
        <span>${t('models.copiedCurl') || '已复制 curl 命令'}${formatLabel}: ${modelName}</span>
    `;
    
    toastContainer.appendChild(toast);
    
    // 自动移除
    setTimeout(() => {
        toast.classList.add('toast-fade-out');
        setTimeout(() => {
            toast.remove();
        }, 300);
    }, 2000);
}

/**
 * 渲染模型列表
 * @param {Object} models - 模型数据
 */
function renderModelsList(models) {
    const container = document.getElementById('modelsList');
    if (!container) return;
    
    // 检查是否有模型数据
    const providerTypes = Object.keys(models);
    if (providerTypes.length === 0) {
        container.innerHTML = `
            <div class="models-empty">
                <i class="fas fa-cube"></i>
                <p data-i18n="models.empty">${t('models.empty') || '暂无可用模型'}</p>
            </div>
        `;
        return;
    }
    
    // 渲染每个提供商的模型组
    let html = '';
    
    for (const providerType of providerTypes) {
        const modelList = models[providerType];
        if (!modelList || modelList.length === 0) continue;
        
        // 如果配置了不可见，则跳过
        if (currentProviderConfigs) {
            const config = currentProviderConfigs.find(c => c.id === providerType);
            if (config && config.visible === false) continue;
        }
        
        const providerDisplayName = getProviderDisplayName(providerType);
        const providerIcon = getProviderIcon(providerType);
        
        html += `
            <div class="provider-models-group" data-provider="${providerType}">
                <div class="provider-models-header" onclick="window.toggleProviderModels('${providerType}')">
                    <div class="provider-models-title">
                        <i class="${providerIcon}"></i>
                        <h3>${providerDisplayName}</h3>
                        <span class="provider-models-count">${modelList.length}</span>
                    </div>
                    <div class="provider-models-toggle">
                        <i class="fas fa-chevron-down"></i>
                    </div>
                </div>
                <div class="provider-models-content" id="models-${providerType}">
                    ${modelList.map(model => `
                        <div class="model-item">
                            <div class="model-item-icon">
                                <i class="fas fa-cube"></i>
                            </div>
                            <span class="model-item-name">${escapeHtml(model)}</span>
                            <div class="model-item-copy-buttons">
                                <button class="model-copy-btn" onclick="window.copyModelAsOpenAI('${escapeHtml(model)}', this)" title="${t('models.copyAsOpenAI') || '复制为 OpenAI 格式 curl'}">
                                    OpenAI
                                </button>
                                <button class="model-copy-btn model-copy-btn-claude" onclick="window.copyModelAsClaude('${escapeHtml(model)}', this)" title="${t('models.copyAsClaude') || '复制为 Claude 格式 curl'}">
                                    Claude
                                </button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }
    
    container.innerHTML = html;
}

/**
 * 获取提供商显示名称
 * @param {string} providerType - 提供商类型
 * @returns {string} 显示名称
 */
function getProviderDisplayName(providerType) {
    // 优先从外部传入的配置中获取名称
    if (currentProviderConfigs) {
        const config = currentProviderConfigs.find(c => c.id === providerType);
        if (config && config.name) {
            return config.name;
        }
    }

    const displayNames = {
        'gemini-cli-oauth': 'Gemini CLI (OAuth)',
        'gemini-antigravity': 'Gemini Antigravity',
        'claude-custom': 'Claude Custom',
        'claude-kiro-oauth': 'Claude Kiro (OAuth)',
        'openai-custom': 'OpenAI Custom',
        'openaiResponses-custom': 'OpenAI Responses Custom',
        'openai-qwen-oauth': 'Qwen (OAuth)',
        'openai-iflow': 'iFlow',
        'openai-codex-oauth': 'OpenAI Codex (OAuth)',
        'cursor-oauth': 'Cursor (OAuth)',
        'openai-copilot-oauth': 'Copilot (OAuth)',
        'openai-codebuddy-oauth': 'CodeBuddy (OAuth)',
        'openai-kimi-oauth': 'Kimi (OAuth)',
        'openai-gitlab-oauth': 'GitLab (OAuth)',
        'openai-kilo-oauth': 'Kilo (OAuth)'
    };

    return displayNames[providerType] || providerType;
}

/**
 * 获取提供商图标
 * @param {string} providerType - 提供商类型
 * @returns {string} 图标类名
 */
function getProviderIcon(providerType) {
    // 优先从外部传入的配置中获取图标
    if (currentProviderConfigs) {
        const config = currentProviderConfigs.find(c => c.id === providerType);
        if (config && config.icon) {
            // 如果 icon 已经包含 fa- 则直接使用，否则加上 fas
            return config.icon.startsWith('fa-') ? `fas ${config.icon}` : config.icon;
        }
    }

    if (providerType.includes('gemini')) {
        return 'fas fa-gem';
    } else if (providerType.includes('claude')) {
        return 'fas fa-robot';
    } else if (providerType.includes('cursor')) {
        return 'fas fa-mouse-pointer';
    } else if (providerType.includes('copilot')) {
        return 'fas fa-code';
    } else if (providerType.includes('grok')) {
        return 'fas fa-brain';
    } else if (providerType.includes('openai') || providerType.includes('qwen') || providerType.includes('iflow')) {
        return 'fas fa-brain';
    }
    return 'fas fa-server';
}

/**
 * HTML 转义
 * @param {string} text - 原始文本
 * @returns {string} 转义后的文本
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * 切换提供商模型列表的展开/折叠状态
 * @param {string} providerType - 提供商类型
 */
function toggleProviderModels(providerType) {
    const group = document.querySelector(`.provider-models-group[data-provider="${providerType}"]`);
    if (!group) return;
    
    const header = group.querySelector('.provider-models-header');
    const content = group.querySelector('.provider-models-content');
    
    if (content.classList.contains('collapsed')) {
        content.classList.remove('collapsed');
        header.classList.remove('collapsed');
    } else {
        content.classList.add('collapsed');
        header.classList.add('collapsed');
    }
}

/**
 * 复制模型的 OpenAI 格式 curl 命令
 * @param {string} modelName - 模型名称
 * @param {HTMLElement} btnElement - 点击的按钮元素
 */
async function copyModelAsOpenAI(modelName, btnElement) {
    const apiKey = await getApiKey();
    const curlCommand = buildCurlCommand(modelName, apiKey);
    const success = await copyToClipboard(curlCommand);

    if (success) {
        const modelItem = btnElement.closest('.model-item');
        modelItem.classList.add('copied');
        setTimeout(() => {
            modelItem.classList.remove('copied');
        }, 1000);
        showCopyToast(modelName, 'OpenAI');
    }
}

/**
 * 复制模型的 Claude 格式 curl 命令
 * @param {string} modelName - 模型名称
 * @param {HTMLElement} btnElement - 点击的按钮元素
 */
async function copyModelAsClaude(modelName, btnElement) {
    const apiKey = await getApiKey();
    const curlCommand = buildClaudeCurlCommand(modelName, apiKey);
    const success = await copyToClipboard(curlCommand);

    if (success) {
        const modelItem = btnElement.closest('.model-item');
        modelItem.classList.add('copied');
        setTimeout(() => {
            modelItem.classList.remove('copied');
        }, 1000);
        showCopyToast(modelName, 'Claude');
    }
}

/**
 * 初始化模型管理器
 */
async function initModelsManager() {
    const container = document.getElementById('modelsList');
    if (!container) return;
    
    try {
        const models = await fetchProviderModels();
        renderModelsList(models);
    } catch (error) {
        container.innerHTML = `
            <div class="models-empty">
                <i class="fas fa-exclamation-triangle"></i>
                <p>${t('models.loadError') || '加载模型列表失败'}</p>
            </div>
        `;
    }
}

/**
 * 刷新模型列表
 */
async function refreshModels() {
    modelsCache = null;
    await initModelsManager();
}

// 导出到全局作用域供 HTML 调用
window.toggleProviderModels = toggleProviderModels;
window.copyModelAsOpenAI = copyModelAsOpenAI;
window.copyModelAsClaude = copyModelAsClaude;
window.refreshModels = refreshModels;

// 监听组件加载完成事件
window.addEventListener('componentsLoaded', () => {
    initModelsManager();
});

// 导出函数
export {
    initModelsManager,
    refreshModels,
    fetchProviderModels,
    updateModelsProviderConfigs
};
