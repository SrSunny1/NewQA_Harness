// node:test 加载器：让测试进程能 import 含 JSX 的 src/*.jsx。
// .jsx 经 esbuild 转译（automatic runtime）；.css 置为空模块。
// 用法：import { register } from 'node:module';
//       register('./jsx-loader.mjs', import.meta.url); 之后再动态 import App.jsx。
import { readFile } from 'node:fs/promises';
import { transform } from 'esbuild';

export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('.jsx')) {
    const source = await readFile(new URL(url), 'utf8');
    const { code } = await transform(source, {
      loader: 'jsx',
      jsx: 'automatic',
      format: 'esm',
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {}', shortCircuit: true };
  }
  return next(url, context);
}
