import React, { useState } from 'react';
import { isBillableModel, isBillableSpeed } from '../model.js';
import { isFusionValue } from '../fusion.js';
import { shorten } from '../utils/format.js';

export function WorkspaceBar({ conv, defaultCwd, busy: running, onApply, onBrowse }) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = conv.workspace || defaultCwd || '';

  const apply = async () => {
    const p = input.trim();
    if (!p) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch('/api/workspace/inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || '检查失败');
      onApply(j.path);
      setEditing(false);
    } catch (e) {
      setErr(e.message || '检查失败');
    } finally {
      setBusy(false);
    }
  };

  // 已有回合或回合进行中不提供换目录入口（目录只对空会话可变）。
  if (conv.turns.length > 0 || running) return null;

  return (
    <div className="ws-bar markup-ui">
      {editing ? (
        <span className="ws-edit">
          <input
            className="ws-input"
            aria-label="工作区绝对路径"
            placeholder="/absolute/path"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && apply()}
          />
          <button type="button" className="mini-btn" disabled={busy} onClick={apply}>
            {busy ? '检查中…' : '检查'}
          </button>
          <button
            type="button"
            className="mini-btn"
            onClick={() => {
              setEditing(false);
              setErr('');
            }}
          >
            取消
          </button>
          {err && <span className="ws-err" role="alert">{err}</span>}
        </span>
      ) : (
        <>
          <button
            type="button"
            className="mini-btn"
            title="更改当前对话的目录"
            onClick={() => {
              setInput(shown);
              setEditing(true);
              setErr('');
            }}
          >
            更改目录
          </button>
          <button
            type="button"
            className="mini-btn ws-browse"
            onClick={onBrowse}
          >
            浏览文件夹
          </button>
        </>
      )}
    </div>
  );
}

// 实际生效模型标签：done 事件上报值 → 探测选项命中时显示名称，否则原始值。
// 只有免费档精确 SKU 不标黄；Fusion（UID 含 sidekick-swe-2）与
// swe-2-*-lightning 等计费变体都会标黄（判定见 model.js isBillableModel）。
// ACP 的 configOption 只报家族值（如 swe-2-high），速度 Fast 实际会被
// Devin 解析成收费的 Lightning 变体，因此 speed=fast 也按计费标黄。
function EffectiveModelTag({ value, opts, speed = '' }) {
  const options =
    opts.status === 'ok' && Array.isArray(opts.config?.model?.options)
      ? opts.config.model.options
      : [];
  const name = options.find((o) => o.value === value)?.name || value;
  const fast = isBillableSpeed(speed);
  const speedName =
    (opts.status === 'ok'
      ? opts.config?.speed?.options?.find((o) => o.value === speed)?.name
      : '') || speed;
  const billable = isBillableModel(value) || fast;
  const reasons = [
    isBillableModel(value) ? '此模型不在免费档（计费）' : '',
    fast
      ? '非 Standard 速度档会解析为收费快速变体（SWE-2 → Lightning），会消耗周额度'
      : '',
  ].filter(Boolean);
  return (
    <span
      className={`model-eff ${billable ? 'warn' : ''}`}
      title={billable ? reasons.join('；') : undefined}
    >
      实际：{name}
      {fast ? `（${speedName} 计费）` : ''}
    </span>
  );
}

// 会话级 模型/思考/速度 下拉（work 会话输入区可见）。
// '' 值 = 默认，跟随 Devin 全局配置；选择对下一回合生效（回合进行中禁用）。
// opts 来自 GET /api/devin/options：error → 整行禁用并标「不可用」。
export function ModelBar({ conv, opts, busy, onSelect }) {
  const ready = opts.status === 'ok';
  const loading = opts.status === 'idle' || opts.status === 'loading';
  const cfg = conv.modelConfig || {};
  // 「实际」模型推导：选择与上次生效同源（effFor）→ 显示 done 上报的真实解析值；
  // 刚改过选择 → 实时显示选中项（等下回合 done 再换成真实解析值）。
  const cfgModel = typeof cfg.model === 'string' ? cfg.model : '';
  const effFor = typeof conv.effFor === 'string' ? conv.effFor : '';
  const effValue = conv.effectiveModel || '';
  const curValue = ready ? opts.config?.model?.currentValue : '';
  const resolvedModel =
    cfgModel === effFor
      ? effValue || cfgModel || curValue
      : cfgModel || curValue || effValue;
  const cfgSpeed = typeof cfg.speed === 'string' ? cfg.speed : '';
  const dftSpeed = ready ? opts.config?.speed?.currentValue : '';
  const speedValue = cfgSpeed || dftSpeed || '';
  const fastSpeed = isBillableSpeed(speedValue);
  // 实际模型标签绑定的是上一回合：模型选择未变时用那次的 speed，
  // 选择已变则按当前 speed 预览下一回合。
  const tagSpeed =
    (cfgModel === effFor ? conv.effSpeed || speedValue : speedValue) || '';
  return (
    <div
      className="model-row markup-ui"
      title={opts.status === 'error' ? '不可用' : undefined}
      aria-label="模型与思考配置"
    >
      {[
        { key: 'model', label: '模型' },
        { key: 'thought_level', label: '思考' },
        { key: 'speed', label: '速度' },
      ].map(({ key, label }) => {
        const group = ready ? opts.config?.[key] : null;
        const options = Array.isArray(group?.options) ? group.options : [];
        // fusion-* 配对改由 /fusion 选择器完成，模型下拉只留普通模型；
        // 当前值若是 fusion，fallback 选项显示 "Fusion (A + B)" 友好名。
        const shown =
          key === 'model' ? options.filter((o) => !isFusionValue(o.value)) : options;
        const cur = typeof cfg[key] === 'string' ? cfg[key] : '';
        const dft =
          options.find((o) => o.value === group?.currentValue)?.name ||
          group?.currentValue ||
          '';
        return (
          <span key={key} className="model-sel">
            <em className="model-sel-name">{label}</em>
            <select
              className="model-select"
              aria-label={`会话${label}配置`}
              disabled={busy || !ready}
              value={cur}
              onChange={(e) => onSelect(key, e.target.value)}
            >
              <option value="">
                {ready && dft ? `默认（${shorten(dft, 16)}）` : '默认'}
              </option>
              {shown.map((o) => (
                <option key={o.value} value={o.value} title={o.value}>
                  {o.name || o.value}
                  {key === 'speed' && isBillableSpeed(o.value) ? '（计费）' : ''}
                </option>
              ))}
              {!!cur && !shown.some((o) => o.value === cur) && (
                <option value={cur} title={cur}>
                  {options.find((o) => o.value === cur)?.name || cur}
                </option>
              )}
            </select>
            {key === 'speed' && fastSpeed && (
              <small
                className="model-warn"
                title="非 Standard 速度档会解析为收费快速变体（SWE-2 → Lightning），会消耗周额度；改成 Standard 即可免费"
              >
                {options.find((o) => o.value === speedValue)?.name || speedValue}{' '}
                计费
              </small>
            )}
            {loading && <small className="model-dft">加载中…</small>}
          </span>
        );
      })}
      {!!resolvedModel && (
        <EffectiveModelTag value={resolvedModel} opts={opts} speed={tagSpeed} />
      )}
    </div>
  );
}
