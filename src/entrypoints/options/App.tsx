import { useEffect, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { settingsItem } from '@/lib/settings';
import { DEFAULT_SETTINGS, type Provider, type Settings } from '@/lib/types';

const LANGS = [
  { id: 'zh-CN', name: '简体中文' },
  { id: 'zh-TW', name: '繁體中文' },
  { id: 'ja', name: '日本語' },
  { id: 'ko', name: '한국어' },
  { id: 'en', name: 'English' },
];

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-neutral-200">{label}</span>
        {hint && <span className="text-[11px] text-neutral-500">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

const inputCls =
  'w-full rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none transition placeholder:text-neutral-600 focus:border-emerald-500/70 focus:ring-2 focus:ring-emerald-500/20';

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'error'; text: string }>({
    state: 'idle',
    text: '',
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void settingsItem.getValue().then((saved) => setSettings({ ...DEFAULT_SETTINGS, ...(saved ?? {}) }));
  }, []);

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      setStatus('saving');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void settingsItem.setValue(next).then(() => {
          setStatus('saved');
          setTimeout(() => setStatus('idle'), 1500);
        });
      }, 300);
      return next;
    });
  };

  // 导出/导入配置：换扩展 ID 或换机器时不用重填
  const exportSettings = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ytsub-settings.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const importSettings = async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as Partial<Settings>;
      const merged: Settings = { ...DEFAULT_SETTINGS, ...data };
      setSettings(merged);
      await settingsItem.setValue(merged);
      setStatus('saved');
      setTimeout(() => setStatus('idle'), 1500);
    } catch (err) {
      alert(`导入失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const runTest = async () => {
    setTest({ state: 'running', text: '' });
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'ytsub:test',
        text: 'Welcome back to the channel, today we are talking about GPUs.',
        settings,
      })) as { ok: boolean; data?: string[]; error?: string } | undefined;
      if (res?.ok && res.data?.[0]) setTest({ state: 'ok', text: res.data[0] });
      else setTest({ state: 'error', text: res?.error ?? '没有返回结果' });
    } catch (err) {
      setTest({ state: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const providers = useMemo(
    () =>
      [
        { id: 'google' as Provider, name: 'Google 免费', desc: '零配置，质量够用，适合日常' },
        { id: 'llm' as Provider, name: 'LLM（OpenAI 兼容）', desc: 'DeepSeek / OpenAI / Ollama 均可' },
      ] satisfies Array<{ id: Provider; name: string; desc: string }>,
    [],
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-6 py-10">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">YouTube 双语字幕</h1>
          <p className="mt-1 text-sm text-neutral-500">
            在播放页实时抓取字幕轨并翻译，中英双语叠加显示。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-neutral-500">
            {status === 'saving' ? '保存中…' : status === 'saved' ? '已保存 ✓' : ''}
          </span>
          <button
            type="button"
            onClick={() => void browser.tabs.create({ url: '/guide.html' })}
            className="rounded-lg border border-neutral-800 px-2.5 py-1 text-[11px] text-neutral-400 hover:text-neutral-100"
          >
            使用说明
          </button>
          <button
            type="button"
            onClick={exportSettings}
            className="rounded-lg border border-neutral-800 px-2.5 py-1 text-[11px] text-neutral-400 hover:text-neutral-100"
          >
            导出配置
          </button>
          <label className="cursor-pointer rounded-lg border border-neutral-800 px-2.5 py-1 text-[11px] text-neutral-400 hover:text-neutral-100">
            导入配置
            <input
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void importSettings(f);
                e.target.value = '';
              }}
            />
          </label>
        </div>
      </header>

      <section className="space-y-3 rounded-2xl border border-neutral-800 bg-neutral-900/50 p-4">
        <h2 className="text-sm font-semibold text-neutral-300">翻译引擎</h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {providers.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => update({ provider: p.id })}
              className={`rounded-xl border p-3 text-left transition ${
                settings.provider === p.id
                  ? 'border-emerald-500/60 bg-emerald-500/10'
                  : 'border-neutral-800 bg-neutral-900 hover:border-neutral-700'
              }`}
            >
              <span className="block text-sm font-medium">{p.name}</span>
              <span className="mt-0.5 block text-[11px] leading-relaxed text-neutral-500">{p.desc}</span>
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="目标语言">
            <select
              className={inputCls}
              value={settings.targetLang}
              onChange={(e) => update({ targetLang: e.target.value })}
            >
              {LANGS.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="提前翻译" hint="秒">
            <input
              type="number"
              min={10}
              max={600}
              className={inputCls}
              value={settings.prefetchSeconds}
              onChange={(e) => update({ prefetchSeconds: Number(e.target.value) || 90 })}
            />
          </Field>
        </div>

        {settings.provider === 'llm' && (
          <div className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-950/60 p-3">
            <Field label="API 端点" hint="OpenAI 兼容">
              <input
                className={inputCls}
                placeholder="https://api.deepseek.com/v1"
                value={settings.apiBase}
                onChange={(e) => update({ apiBase: e.target.value })}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="模型">
                <input
                  className={inputCls}
                  placeholder="deepseek-chat"
                  value={settings.apiModel}
                  onChange={(e) => update({ apiModel: e.target.value })}
                />
              </Field>
              <Field label="API Key">
                <input
                  type="password"
                  className={inputCls}
                  placeholder="sk-..."
                  value={settings.apiKey}
                  onChange={(e) => update({ apiKey: e.target.value })}
                />
              </Field>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 pt-1">
          <button
            type="button"
            onClick={() => void runTest()}
            disabled={test.state === 'running'}
            className="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white transition hover:bg-emerald-500 disabled:opacity-60"
          >
            {test.state === 'running' ? '测试中…' : '测试翻译'}
          </button>
          {test.state !== 'idle' && test.state !== 'running' && (
            <p
              className={`flex-1 truncate text-xs ${
                test.state === 'ok' ? 'text-emerald-400' : 'text-rose-400'
              }`}
              title={test.text}
            >
              {test.text}
            </p>
          )}
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-neutral-800 bg-neutral-900/50 p-4">
        <h2 className="text-sm font-semibold text-neutral-300">显示</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="字号" hint="倍率">
            <input
              type="range"
              min={0.7}
              max={1.8}
              step={0.05}
              value={settings.fontScale}
              onChange={(e) => update({ fontScale: Number(e.target.value) })}
              className="w-full accent-emerald-500"
            />
          </Field>
          <Field label="底部距离" hint="%">
            <input
              type="range"
              min={2}
              max={40}
              step={1}
              value={settings.bottomOffset}
              onChange={(e) => update({ bottomOffset: Number(e.target.value) })}
              className="w-full accent-emerald-500"
            />
          </Field>
          <Field label="预览">
            <div className="rounded-lg border border-neutral-800 bg-black px-2 py-1.5 text-center">
              <div
                className="text-neutral-300"
                style={{ fontSize: `${11 * settings.fontScale}px` }}
              >
                welcome back to the channel
              </div>
              <div
                className="font-semibold text-white"
                style={{ fontSize: `${15 * settings.fontScale}px` }}
              >
                欢迎回到频道
              </div>
            </div>
          </Field>
        </div>

        <div className="space-y-1">
          {[
            {
              key: 'enabled' as const,
              label: '启用翻译',
              desc: '在 YouTube 播放页自动运行',
            },
            {
              key: 'showOriginal' as const,
              label: '显示原文',
              desc: '关闭后只显示译文',
            },
            {
              key: 'hideNativeCaptions' as const,
              label: '隐藏原生字幕',
              desc: '避免与翻译层重叠',
            },
          ].map((item) => (
            <label
              key={item.key}
              className="flex cursor-pointer items-center justify-between rounded-lg px-1 py-2 hover:bg-neutral-800/40"
            >
              <span>
                <span className="block text-sm text-neutral-200">{item.label}</span>
                <span className="block text-[11px] text-neutral-500">{item.desc}</span>
              </span>
              <input
                type="checkbox"
                className="h-4 w-4 accent-emerald-500"
                checked={settings[item.key]}
                onChange={(e) => update({ [item.key]: e.target.checked } as Partial<Settings>)}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-3 rounded-2xl border border-neutral-800 bg-neutral-900/50 p-4">
        <h2 className="text-sm font-semibold text-neutral-300">截图翻译 / 视觉服务</h2>
        <p className="text-[11px] leading-relaxed text-neutral-500">
          截图翻译由独立的 <b className="text-neutral-300">pdftranslate</b> 项目提供识别能力，
          需要先在那边的目录双击 <code className="rounded bg-neutral-800 px-1">start-server.cmd</code>。
        </p>
        <Field label="视觉服务地址">
          <input
            className={inputCls}
            placeholder="http://127.0.0.1:8765"
            value={settings.visionUrl}
            onChange={(e) => update({ visionUrl: e.target.value })}
          />
        </Field>
      </section>

      <section className="space-y-3 rounded-2xl border border-neutral-800 bg-neutral-900/50 p-4">
        <h2 className="text-sm font-semibold text-neutral-300">语音识别（无字幕视频）</h2>
        <p className="text-[11px] leading-relaxed text-neutral-500">
          视频没有字幕轨时，扩展可以抓取标签页音频，交给本地 whisper 服务转写后再翻译。
          需要先在项目目录运行 <code className="rounded bg-neutral-800 px-1">start-asr.cmd</code>。
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="本地服务地址">
            <input
              className={inputCls}
              placeholder="http://127.0.0.1:8770"
              value={settings.asrUrl}
              onChange={(e) => update({ asrUrl: e.target.value })}
            />
          </Field>
          <Field label="切片长度" hint="秒，越短延迟越低但更吃 CPU">
            <input
              type="number"
              min={2}
              max={15}
              className={inputCls}
              value={settings.asrChunkSec}
              onChange={(e) => update({ asrChunkSec: Number(e.target.value) || 6 })}
            />
          </Field>
        </div>
        <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3 text-[11px] leading-relaxed text-neutral-500">
          速度取决于 <code className="rounded bg-neutral-800 px-1">asrsvc</code> 用的模型（实测 3 秒切片）：
          <br />· <b className="text-neutral-300">base</b>（默认）≈ 0.8s/块 → 总延迟约 5 秒
          <br />· <b className="text-neutral-300">tiny</b> ≈ 0.4s/块，最快但会丢字
          <br />· <b className="text-neutral-300">small</b> ≈ 5s/块，最准，适合中文/口音重的素材
          <br />
          启动时指定：<code className="rounded bg-neutral-800 px-1">start-asr.cmd --model small</code>
        </div>
      </section>

      <footer className="pb-6 text-[11px] leading-relaxed text-neutral-600">
        字幕来自播放器自身发出的 timedtext 请求，因此不依赖第三方解析服务，直播也同样适用。
        翻译结果会本地缓存，同一句话不会重复请求。
      </footer>
    </div>
  );
}
