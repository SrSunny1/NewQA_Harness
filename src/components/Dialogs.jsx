import React, { useEffect, useState } from 'react';

// 二次确认按钮：先点「删除」，变成「确认删除」，3 秒内再点才执行。
export function ConfirmButton({ label = '删除', confirmLabel = '确认删除', onConfirm, title }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={`mini-btn ${armed ? 'danger' : ''}`}
      title={title}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

// 右键菜单里的两段确认删除项。
export function CtxConfirm({ label, onConfirm }) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      type="button"
      className={`ctx-item ${armed ? 'armed danger' : ''}`}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      {armed ? '确认删除' : label}
    </button>
  );
}

export function PermDialog({ perm, more = 0, onDecide }) {
  const allow = perm.options.filter((o) => o.kind === 'allow_once');
  const deny = perm.options.filter((o) => o.kind === 'reject_once');
  return (
    <div className="perm-card markup-ui" role="alertdialog" aria-label="工具权限请求">
      <div className="perm-head">
        <strong>工具权限请求</strong>
        {perm.toolKind && <span className="tool-kind">{perm.toolKind}</span>}
        {more > 0 && <span className="perm-more">还有 {more} 个待确认</span>}
      </div>
      <p className="perm-title">{perm.title}</p>
      {perm.command && <pre className="perm-cmd">{perm.command}</pre>}
      <div className="perm-ops">
        {allow.map((o) => (
          <button
            key={o.id}
            type="button"
            className="btn-primary"
            onClick={() => onDecide(perm.requestId, o.id)}
          >
            {o.label || '允许一次'}
          </button>
        ))}
        {deny.map((o) => (
          <button
            key={o.id}
            type="button"
            className="mini-btn"
            onClick={() => onDecide(perm.requestId, o.id)}
          >
            {o.label || '拒绝'}
          </button>
        ))}
        <button type="button" className="mini-btn" onClick={() => onDecide(perm.requestId, null)}>
          取消
        </button>
      </div>
      <p className="perm-note">仅单次生效；不会自动批准、没有「总是允许」。</p>
    </div>
  );
}

// agent 提问（elicitation form）：按 schema 渲染 单选/多选/自由文本；
// allowOther 时追加「其他」自由输入。提交 = accept，跳过 = decline。
export function ElicitDialog({ eli, more = 0, onDecide }) {
  const OTHER = '__other__';
  const [answers, setAnswers] = useState({}); // key → string | string[]
  const [otherText, setOtherText] = useState({}); // key → 自由输入
  const setA = (key, v) => setAnswers((a) => ({ ...a, [key]: v }));
  const setO = (key, v) => setOtherText((a) => ({ ...a, [key]: v }));
  const toggleMulti = (key, value) =>
    setAnswers((a) => {
      const cur = Array.isArray(a[key]) ? a[key] : [];
      return {
        ...a,
        [key]: cur.includes(value) ? cur.filter((x) => x !== value) : [...cur, value],
      };
    });
  // 汇总 content：select 选「其他」时用自由输入；multi 把非空自由输入补进数组
  const buildContent = () => {
    const out = {};
    for (const f of eli.fields) {
      const v = answers[f.key];
      const extra = (otherText[f.key] || '').trim();
      if (f.kind === 'multi') {
        const arr = Array.isArray(v) ? [...v] : [];
        if (eli.allowOther && extra) arr.push(extra);
        if (arr.length) out[f.key] = arr;
      } else if (f.kind === 'select') {
        if (v === OTHER) {
          if (extra) out[f.key] = extra;
        } else if (typeof v === 'string' && v) {
          out[f.key] = v;
        }
      } else if (typeof v === 'string' && v.trim()) {
        out[f.key] = v.trim();
      }
    }
    return out;
  };
  // 必填校验：required 字段必须有有效答案才放行提交
  const missingRequired = eli.fields.some((f) => {
    if (!f.required) return false;
    const v = answers[f.key];
    if (f.kind === 'multi') return !Array.isArray(v) || (!v.length && !(otherText[f.key] || '').trim());
    if (f.kind === 'select') {
      if (v === OTHER) return !(otherText[f.key] || '').trim();
      return !v;
    }
    return !(typeof v === 'string' && v.trim());
  });
  return (
    <div className="perm-card elicit-card markup-ui" role="alertdialog" aria-label="Devin 的提问">
      <div className="perm-head">
        <strong>Devin 想问一下</strong>
        {more > 0 && <span className="perm-more">还有 {more} 个提问</span>}
      </div>
      {eli.message && <p className="perm-title">{eli.message}</p>}
      {eli.fields.map((f) => (
        <div className="elicit-field" key={f.key}>
          <div className="elicit-field-title">
            {f.title}
            {f.required && <span className="elicit-req">必填</span>}
          </div>
          {f.description && <div className="elicit-field-desc">{f.description}</div>}
          {f.kind === 'select' && (
            <div className="elicit-options" role="radiogroup" aria-label={f.title}>
              {f.options.map((o) => (
                <label className="elicit-option" key={o.value}>
                  <input
                    type="radio"
                    name={`eli-${eli.requestId}-${f.key}`}
                    checked={answers[f.key] === o.value}
                    onChange={() => setA(f.key, o.value)}
                  />
                  <span>
                    {o.label}
                    {o.description && <small>{o.description}</small>}
                  </span>
                </label>
              ))}
              {eli.allowOther && (
                <label className="elicit-option">
                  <input
                    type="radio"
                    name={`eli-${eli.requestId}-${f.key}`}
                    checked={answers[f.key] === OTHER}
                    onChange={() => setA(f.key, OTHER)}
                  />
                  <span>
                    其他
                    <input
                      type="text"
                      className="elicit-other-input"
                      placeholder="自己填写…"
                      value={otherText[f.key] || ''}
                      onChange={(e) => {
                        setO(f.key, e.target.value);
                        if (answers[f.key] !== OTHER) setA(f.key, OTHER);
                      }}
                    />
                  </span>
                </label>
              )}
            </div>
          )}
          {f.kind === 'multi' && (
            <div className="elicit-options" role="group" aria-label={f.title}>
              {f.options.map((o) => (
                <label className="elicit-option" key={o.value}>
                  <input
                    type="checkbox"
                    checked={(Array.isArray(answers[f.key]) ? answers[f.key] : []).includes(o.value)}
                    onChange={() => toggleMulti(f.key, o.value)}
                  />
                  <span>
                    {o.label}
                    {o.description && <small>{o.description}</small>}
                  </span>
                </label>
              ))}
              {eli.allowOther && (
                <input
                  type="text"
                  className="elicit-other-input"
                  placeholder="其他（可补充）…"
                  value={otherText[f.key] || ''}
                  onChange={(e) => setO(f.key, e.target.value)}
                />
              )}
            </div>
          )}
          {f.kind === 'text' && (
            <input
              type="text"
              className="elicit-text-input"
              value={answers[f.key] || ''}
              placeholder="输入回答…"
              onChange={(e) => setA(f.key, e.target.value)}
            />
          )}
        </div>
      ))}
      <div className="perm-ops">
        <button
          type="button"
          className="btn-primary"
          disabled={missingRequired}
          onClick={() => onDecide(eli.requestId, 'accept', buildContent())}
        >
          提交回答
        </button>
        <button type="button" className="mini-btn" onClick={() => onDecide(eli.requestId, 'decline')}>
          跳过
        </button>
      </div>
      <p className="perm-note">回答只发给本轮 Devin 会话；跳过则 Devin 自行决定怎么做。</p>
    </div>
  );
}
