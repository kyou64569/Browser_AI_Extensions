// connectors/kb-registry.js
// 知识库 provider 注册表：集中定义可切换的知识库来源，供设置页/功能页/后台统一渲染与实例化。
// 新增一个在线知识库，只需在这里加一项 + 在 connectors 里实现对应连接器即可，上层无需改动。

import { LocalKbConnector } from './local-kb.js';
import { OnlineKbConnector } from './online-kb.js';

/**
 * 知识库来源定义
 * @typedef {Object} KbProviderDef
 * @property {string} id         provider 唯一 id（也是 providers 字典的键）
 * @property {string} label      展示名
 * @property {'local'|'online'} kind
 * @property {boolean} [placeholder] 仅占位、尚未实现（界面置灰）
 * @property {Array<{key:string,label:string,type:string,placeholder:string}>} [fields] 凭证表单字段
 */

/** 所有知识库来源。placeholder:true 表示暂未实现，仅在界面占位。 */
export const KB_PROVIDERS = [
  {
    id: 'ima',
    label: '腾讯 ima',
    kind: 'online',
    placeholder: false,
    fields: [
      { key: 'clientId', label: 'Client ID', type: 'text', placeholder: 'ima-openapi-clientid' },
      { key: 'apiKey', label: 'API Key', type: 'password', placeholder: 'ima-openapi-apikey' },
    ],
  },
  {
    id: 'local',
    label: '本地知识库',
    kind: 'local',
    placeholder: false,
    fields: [
      { key: 'baseUrl', label: '服务地址', type: 'text', placeholder: 'http://localhost:8000' },
      { key: 'apiKey', label: 'API Key（可选）', type: 'password', placeholder: '如服务启用了鉴权' },
    ],
  },
  {
    // 占位：其他在线知识库（NotebookLM 等）。界面显示“敬请期待”，不可选。
    id: 'notebooklm',
    label: 'NotebookLM（敬请期待）',
    kind: 'online',
    placeholder: true,
    fields: [],
  },
];

export function getKbProviderDef(id) {
  return KB_PROVIDERS.find((p) => p.id === id) || null;
}

/** 按类型实例化连接器；不支持的类型返回 null */
export function createKbConnector(type, cfg) {
  if (type === 'local') return new LocalKbConnector(cfg || {});
  if (type === 'ima') return new OnlineKbConnector(cfg || {});
  return null;
}
