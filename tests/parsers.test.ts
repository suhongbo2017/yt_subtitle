/**
 * 字幕解析回归测试（不依赖浏览器）：
 *   node --experimental-strip-types tests/parsers.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeCueLists, parseCues, tidy, type Cue } from '../src/lib/timedtext.ts';

const json3 = (events: unknown) => JSON.stringify({ events });

test('json3：基本解析与时间戳', () => {
  const cues = parseCues(
    json3([
      { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: 'hello' }, { utf8: ' world' }] },
      { tStartMs: 2000, dDurationMs: 3000, segs: [{ utf8: 'this is a test' }] },
    ]),
  );
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 0, end: 2, text: 'hello world' });
  assert.deepEqual(cues[1], { start: 2, end: 5, text: 'this is a test' });
});

test('json3：分段缺空格时自动补空格', () => {
  const cues = parseCues(json3([{ tStartMs: 500, dDurationMs: 1000, segs: [{ utf8: 'hello' }, { utf8: 'world' }] }]));
  assert.equal(cues[0].text, 'hello world');
});

test('json3：中文分段不补空格', () => {
  const cues = parseCues(json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '你' }, { utf8: '好' }] }]));
  assert.equal(cues[0].text, '你好');
});

test('json3：忽略空事件与无 segs 事件', () => {
  const cues = parseCues(
    json3([
      { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: '\n' }] },
      { tStartMs: 1000, dDurationMs: 1000 },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'ok' }] },
    ]),
  );
  assert.equal(cues.length, 1);
  assert.equal(cues[0].text, 'ok');
});

test('json3：兼容 )]}\' 防 XSSI 前缀', () => {
  const cues = parseCues(`)]}'\n${json3([{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'hi' }] }])}`);
  assert.equal(cues[0].text, 'hi');
});

test('srv3：<p>/<s> 解析与实体解码', () => {
  const xml =
    '<timedtext format="3"><body>' +
    '<p t="0" d="1500"><s>Hi</s><s> there</s></p>' +
    '<p t="1500" d="2000">Tom &amp; Jerry&#39;s</p>' +
    '</body></timedtext>';
  const cues = parseCues(xml);
  assert.deepEqual(cues.map((c) => c.text), ['Hi there', "Tom & Jerry's"]);
  assert.equal(cues[1].start, 1.5);
  assert.equal(cues[1].end, 3.5);
});

test('srv1：<text start dur> 解析', () => {
  const xml =
    '<transcript><text start="1.2" dur="2.3">first line</text>' +
    '<text start="3.5" dur="1">second &lt;line&gt;</text></transcript>';
  const cues = parseCues(xml);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'first line');
  assert.ok(Math.abs(cues[0].end - 3.5) < 1e-6);
  assert.equal(cues[1].text, 'second <line>');
});

test('vtt：时间戳与标签清洗', () => {
  const vtt = [
    'WEBVTT',
    '',
    '1',
    '00:00:01.000 --> 00:00:03.500',
    '<c.colorE5E5E5>hello</c> world',
    '',
    '00:00:03.500 --> 00:00:05.000',
    'next line',
    '',
  ].join('\n');
  const cues = parseCues(vtt);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'hello world');
  assert.equal(cues[0].end, 3.5);
});

test('tidy：滚动补全的重复行合并为一条', () => {
  const cues = tidy([
    { start: 0, end: 1, text: 'hello' },
    { start: 1, end: 2, text: 'hello there' },
    { start: 2, end: 3, text: 'hello there friend' },
    { start: 3, end: 4, text: 'something else' },
  ]);
  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'hello there friend');
  assert.equal(cues[0].end, 3);
});

test('tidy：乱序输入按时间排序', () => {
  const cues = tidy([
    { start: 5, end: 6, text: 'b' },
    { start: 1, end: 2, text: 'a' },
  ]);
  assert.deepEqual(cues.map((c) => c.text), ['a', 'b']);
});

test('mergeCueLists：直播分片增量合并且去重', () => {
  const a: Cue[] = [{ start: 0, end: 2, text: 'one' }];
  const b: Cue[] = [
    { start: 0, end: 2.5, text: 'one' },
    { start: 2, end: 4, text: 'two' },
  ];
  const merged = mergeCueLists(a, b);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].end, 2.5);
  assert.equal(merged[1].text, 'two');
});

test('parseCues：无法识别的内容返回空数组而不是抛错', () => {
  assert.deepEqual(parseCues(''), []);
  assert.deepEqual(parseCues('garbage'), []);
  assert.deepEqual(parseCues('{"events": "nope"}'), []);
});
