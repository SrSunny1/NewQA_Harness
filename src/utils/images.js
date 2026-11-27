import { THUMB_LIMIT } from '../model.js';

// ---- 粘贴图片 ----
const PASTE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const PASTE_FILE_MAX = 15 * 1024 * 1024; // 原始文件硬上限
const REENCODE_BYTES = 1.5 * 1024 * 1024; // 超过则重编码为 jpeg
const SEND_MAX_SIDE = 1920;
// 存档图：尽量大以保证灯箱清晰，超出 THUMB_LIMIT 安全线则降尺寸重试
const THUMB_SIDES = [1400, 1024, 768, 512];
const THUMB_SAFE = Math.floor(THUMB_LIMIT * 0.95);

function fileDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error('读取图片失败'));
    r.readAsDataURL(file);
  });
}

// 粘贴的图片 → { data(base64), mime, thumb(dataURL) }。
// 大图/超宽图重编码为 jpeg 控制请求体大小；gif 保持原样（不动画会丢帧）。
export async function readPastedImage(file) {
  if (!file || !PASTE_MIMES.has(file.type) || file.size > PASTE_FILE_MAX) return null;
  const bmp = await createImageBitmap(file);
  const scaled = (maxSide, quality) => {
    const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s));
    c.height = Math.max(1, Math.round(bmp.height * s));
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', quality);
  };
  // 存档图取「能存下的最大尺寸」：1400px 起逐级降，jpeg 质量 0.8 保文字清晰
  const thumb =
    THUMB_SIDES.map((s) => scaled(s, 0.8)).find((t) => t.length <= THUMB_SAFE) ||
    scaled(THUMB_SIDES.at(-1), 0.8);
  const needReencode =
    file.size > REENCODE_BYTES || Math.max(bmp.width, bmp.height) > SEND_MAX_SIDE;
  let data;
  let mime = file.type;
  if (needReencode && file.type !== 'image/gif') {
    const url = scaled(SEND_MAX_SIDE, 0.85);
    data = url.slice(url.indexOf(',') + 1);
    mime = 'image/jpeg';
  } else {
    const url = await fileDataUrl(file);
    data = url.slice(url.indexOf(',') + 1);
  }
  bmp.close?.();
  return { data, mime, thumb };
}

// 发送前把附图传服务端落盘：灯箱/历史查看用原图 URL，localStorage 只留缩略图。
// 失败返回 null——不阻断发送，气泡仍显示本地缩略图。
export async function uploadAttachments(images) {
  try {
    const r = await fetch('/api/attachment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        images: images.map((i) => ({ data: i.data, mime: i.mime })),
      }),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => ({}));
    const urls = (j.attachments || []).map((a) => a.url);
    return urls.length === images.length ? urls : null;
  } catch {
    return null;
  }
}
