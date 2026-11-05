// SLS 详情「扩展字段」折叠（describeEntry）的纯函数测试。
//
// 详情页签的扩展字段默认只展示重要键（exception./severity/db./http.…，
// SLS_EXTRA_IMPORTANT_RE），其余（service./os./telemetry./host.arch 等
// 部署与环境元信息）折叠进「展开其余 N 项」按钮，点开才渲染。分类在 describeEntry
// （纯函数，extras / extrasMore 两个桶，SLS_EXTRA_CAP=40 是两侧合计上限）。
// 这里与 sls-query.mjs 的 entryJsonNodes 测试同法：读源码追加 export，
// esbuild stdin 打包后在 node 里驱动真实代码。渲染接线（折叠按钮文案 /
// aria-expanded / 展开后才渲染折叠区）纯函数观察不到，用源码静态断言守住。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

async function loadDescribeEntry() {
  const source = readFileSync(new URL('../src/client/components/sls.tsx', import.meta.url), 'utf8')
  const bundle = await build({
    stdin: {
      contents: source + '\nexport { describeEntry }',
      resolveDir: new URL('../src/client/components', import.meta.url).pathname,
      loader: 'tsx',
    },
    bundle: true,
    external: ['react', '@deepseek-ai/dsh-client-ui-primitives'],
    write: false,
    platform: 'node',
    format: 'cjs',
  })
  const module = { exports: {} }
  Function('require', 'module', 'exports', bundle.outputFiles[0].text)(() => ({}), module, module.exports)
  return module.exports.describeEntry
}

// 截图同款 OTEL 日志条目：attribute/resource 解平后字段很多，重要键只占少数。
// 键序即 flatScalars 抽取序（attribute JSON 按原序先、resource 次之、顶层标量最后）。
const OTEL_ENTRY = {
  __time__: '1791426454',
  __source__: '100.121.149.41',
  traceID: '2e447aae55c634e7e3e52a0b275967d9',
  spanID: '4ff34c140bb41ca1',
  service: 'insuranceagent-dist-biz',
  name: '全局异常信息 ex=[502 Bad Gateway] …',
  statusCode: 'Error',
  content: '全局异常信息 ex=[502 Bad Gateway] during [POST] to …<!DOCTYPE html>…',
  attribute: JSON.stringify({
    'exception.message': '[502 Bad Gateway] during [POST] to …',
    'exception.stacktrace': 'feign.FeignException$BadGateway: …',
    'exception.type': 'feign.FeignException$BadGateway',
    'os.description': 'Linux 5.14.0-503.38.1.el9_5.x86_64',
    'os.type': 'linux',
    'process.executable.path': '/opt/jdk-11.0.21/bin/java',
    'process.pid': 1763832,
    'process.runtime.description': 'Oracle Corporation Java HotSp…',
    'process.runtime.name': 'Java(TM) SE Runtime Environment',
    'process.runtime.version': '11.0.21+9-LTS-193',
    'service.instance.id': '890613a9-eead-41e2-8632-bd458e…',
    'service.version': 'v1.0.0',
    'telemetry.distro.name': 'opentelemetry-java-instrumentation',
    'telemetry.distro.version': '2.13.3',
    'telemetry.sdk.language': 'java',
    'telemetry.sdk.name': 'opentelemetry',
    'telemetry.sdk.version': '1.47.0',
    flags: 1,
    'otlp.name': 'com.example.app.common.senti…',
    severityNumber: 17,
    severityText: 'ERROR',
    timeUnixNano: '1791426454923000000',
  }),
  resource: JSON.stringify({ 'host.arch': 'amd64', host: '10.0.0.1' }),
}

test('扩展字段分类：重要键默认展示，环境元信息折叠，两侧互斥且保持键序', async () => {
  const describeEntry = await loadDescribeEntry()
  const info = describeEntry(OTEL_ENTRY)
  assert.deepEqual(info.extras.map(r => r.k), [
    'exception.message', 'exception.stacktrace', 'exception.type', 'process.pid',
    'severityNumber', 'severityText', 'host',
  ])
  assert.deepEqual(info.extrasMore.map(r => r.k), [
    'os.description', 'os.type', 'process.executable.path',
    'process.runtime.description', 'process.runtime.name', 'process.runtime.version',
    'service.instance.id', 'service.version',
    'telemetry.distro.name', 'telemetry.distro.version', 'telemetry.sdk.language',
    'telemetry.sdk.name', 'telemetry.sdk.version', 'flags', 'otlp.name',
    'timeUnixNano', 'host.arch', 'spanID',
  ])
  assert.ok(!info.extrasMore.some(r => info.extras.some(m => m.k === r.k)), '两侧互斥')
})

test('抽取上限：主区+折叠区合计 40；与基本信息同值的键不重复展示', async () => {
  const describeEntry = await loadDescribeEntry()
  const entry = { __time__: '1', __source__: '1.2.3.4', host: '1.2.3.4', 'db.system': 'mysql' }
  for (let i = 0; i < 50; i++) entry['x' + String(i).padStart(2, '0')] = 'v' + i
  const info = describeEntry(entry)
  assert.equal(info.extras.length + info.extrasMore.length, 40)
  assert.deepEqual(info.extras.map(r => r.k), ['db.system'])
  assert.ok(!info.extras.concat(info.extrasMore).some(r => r.k === 'host'),
    'host 与基本信息「来源 IP」同值，不重复展示')
})

test('没有重要键时 extras 为空、全部进折叠区，字段不丢', async () => {
  const describeEntry = await loadDescribeEntry()
  const info = describeEntry({ __time__: '1', message: 'hello', 'telemetry.sdk.name': 'opentelemetry' })
  assert.deepEqual(info.extras, [])
  assert.deepEqual(info.extrasMore.map(r => r.k), ['telemetry.sdk.name'])
})

test('渲染接线：折叠按钮带剩余数量与 aria-expanded，展开后才渲染折叠区', () => {
  const source = readFileSync(new URL('../src/client/components/sls.tsx', import.meta.url), 'utf8')
  assert.match(source, /const \[extrasOpen, setExtrasOpen\] = React\.useState\(false\)/)
  assert.match(source, /moreOpen \? '收起其余字段' : '展开其余 ' \+ info\.extrasMore\.length \+ ' 项'/)
  assert.match(source, /'aria-expanded': moreOpen/)
  assert.match(source, /moreOpen \? info\.extrasMore\.map\(function \(row, i\) \{ return extraKv\(row, 'm' \+ i\) \}\) : null/)
})
