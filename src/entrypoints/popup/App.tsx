import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { PageState } from '@/entrypoints/background';
import { settingsItem } from '@/lib/settings';
import { DEFAULT_SETTINGS, type Provider, type Settings } from '@/lib/types';

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-2">
      <span>
        <span className="block text-sm font-medium text-neutral-100">{label}</span>
        {hint && <span className="block text-xs text-neutral-500">{hint}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
          checked ? 'bg-emerald-500' : 'bg-neutral-700'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white transition-transform ${
            checked ? 'translate-x-5' : ''
          }`}
        />
      </button>
    </label>
  );
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<PageState | null>(null);
  const [asrState, setAsrState] = useState<'idle' | 'starting' | 'running' | 'error'>('idle');
  const [svc, setSvc] = useState<{ online: boolean; model?: string }>({ online: false });
  const [svcBusy, setSvcBusy] = useState(false);
  const [svcMsg, setSvcMsg] = useState('');

  // 本地 ASR 服务：走 Native Messaging 启动/停止（扩展自己不能起进程）
  const toggleService = async (start: boolean) => {
    setSvcBusy(true);
    setSvcMsg(start ? '正在启动服务（首次加载模型约 20-30 秒）…' : '正在停止…');
    try {
      const res = (await browser.runtime.sendMessage({
        type: 'ytsub:service',
        cmd: start ? 'start' : 'stop',
      })) as {
        ok: boolean;
        result?: { ok?: boolean; error?: string; model?: string };
        error?: string;
      };
      if (!res?.ok) throw new Error(res?.error ?? '调用启动器失败');
      if (res.result && res.result.ok === false) throw new Error(res.result.error ?? '启动失败');
      setSvcMsg('');
      setSvc({ online: start, model: res.result?.model });
    } catch (err) {
      setSvcMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSvcBusy(false);
    }
  };
  const [asrMsg, setAsrMsg] = useState('');
  const asrRunning = asrState === 'running' || asrState === 'starting';

  // 主路径：点播字幕生成（下载音频 → 整段转写 → 缓存）
  const toggleAsr = async (start: boolean) => {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (start) {
        await browser.tabs.sendMessage(tab!.id!, { type: 'ytsub:vod-start' });
        setAsrState('running');
        setAsrMsg('');
        update({ asrEnabled: true });
      } else {
        await browser.tabs.sendMessage(tab!.id!, { type: 'ytsub:vod-stop' });
        await browser.runtime.sendMessage({ type: 'ytsub:asr-stop', tabId: tab?.id });
        setAsrState('idle');
        setAsrMsg('');
        update({ asrEnabled: false });
      }
    } catch (err) {
      setAsrState('error');
      const msg = err instanceof Error ? err.message : String(err);
      setAsrMsg(
        /Receiving end does not exist|Could not establish connection/i.test(msg)
          ? '页面里没有注入脚本：扩展刚更新过，请刷新视频页面后重试'
          : msg,
      );
    }
  };

  // 兜底路径：实时抓标签页音频（没 cookie / 下载失败时用）
  const startLive = async () => {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const res = (await browser.runtime.sendMessage({
        type: 'ytsub:asr-start',
        tabId: tab?.id,
        chunkSec: settings.asrChunkSec,
      })) as { ok: boolean; error?: string } | undefined;
      if (res?.ok) {
        setAsrState('running');
        setAsrMsg('');
      } else {
        setAsrState('error');
        setAsrMsg(res?.error ?? '启动失败');
      }
    } catch (err) {
      setAsrState('error');
      setAsrMsg(err instanceof Error ? err.message : String(err));
    }
  };

  // 探测本地 ASR 服务是否在线
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      try {
        const res = await fetch(`${settings.asrUrl.replace(/\/+$/, '')}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        const data = (await res.json()) as { ok?: boolean; model?: string };
        if (alive) setSvc({ online: !!data.ok, model: data.model });
      } catch {
        if (alive) setSvc({ online: false });
      }
    };
    void ping();
    const timer = setInterval(ping, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [settings.asrUrl]);

  useEffect(() => {
    void settingsItem.getValue().then((saved) => {
      setSettings({ ...DEFAULT_SETTINGS, ...(saved ?? {}) });
      setReady(true);
    });
  }, []);

  // 轮询当前标签页的自检状态
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const res = (await browser.runtime.sendMessage({ type: 'ytsub:getState' })) as
          | {
              ok: boolean;
              state: PageState | null;
              asr?: { state: 'idle' | 'starting' | 'running' | 'error'; detail?: string };
            }
          | undefined;
        if (!alive) return;
        setState(res?.state ?? null);
        if (res?.asr) {
          setAsrState(res.asr.state);
          if (res.asr.state === 'error' && res.asr.detail) setAsrMsg(res.asr.detail);
        }
      } catch {
        if (alive) setState(null);
      }
    };
    void tick();
    const timer = setInterval(tick, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    void settingsItem.setValue(next);
  };

  return (
    <div className="space-y-3 p-4">
      <header className="flex items-center gap-2">
        <span className="text-lg">🎬</span>
        <div className="flex-1">
          <h1 className="text-sm font-semibold">YouTube 双语字幕</h1>
          <p className="text-[11px] text-neutral-500">
            {settings.provider === 'google' ? 'Google 免费翻译' : `${settings.apiModel || 'LLM'}`}
            {settings.provider === 'llm' && !settings.apiKey ? ' · 未配置 Key' : ''}
          </p>
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            svc.online ? 'bg-sky-500/15 text-sky-400' : 'bg-rose-500/15 text-rose-400'
          }`}
          title={svc.online ? `本地服务在线（${svc.model ?? ''}）` : '本地 ASR 服务未启动'}
        >
          {svc.online ? `ASR ${svc.model ?? '在线'}` : 'ASR 离线'}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
            settings.enabled ? 'bg-emerald-500/15 text-emerald-400' : 'bg-neutral-800 text-neutral-500'
          }`}
        >
          {settings.enabled ? '运行中' : '已关闭'}
        </span>
      </header>

      <div className="divide-y divide-neutral-800 rounded-xl border border-neutral-800 bg-neutral-900/60 px-3">
        <Toggle
          label="本地 ASR 服务"
          hint={
            svcBusy
              ? svcMsg
              : svc.online
                ? `运行中${svc.model ? ` · ${svc.model}` : ''}（所有页面共用）`
                : svcMsg || '未启动 · 需要它才能生成语音字幕'
          }
          checked={svc.online}
          onChange={(v) => void toggleService(v)}
        />
        <Toggle
          label="启用翻译"
          checked={settings.enabled}
          onChange={(v) => update({ enabled: v })}
          hint="播放页自动抓取字幕并翻译"
        />
        <Toggle
          label="显示原文"
          checked={settings.showOriginal}
          onChange={(v) => update({ showOriginal: v })}
          hint="中英对照两行显示"
        />
        <Toggle
          label="隐藏原生字幕"
          checked={settings.hideNativeCaptions}
          onChange={(v) => update({ hideNativeCaptions: v })}
          hint="避免与翻译层重叠"
        />
      </div>

      <div className="space-y-2">
        <p className="text-[11px] font-medium text-neutral-500">翻译引擎</p>
        <div className="grid grid-cols-2 gap-2">
          {(
            [
              { id: 'google', name: 'Google 免费', desc: '无需配置' },
              { id: 'llm', name: 'LLM', desc: '质量更好' },
            ] as Array<{ id: Provider; name: string; desc: string }>
          ).map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => update({ provider: p.id })}
              className={`rounded-lg border px-2 py-2 text-left transition ${
                settings.provider === p.id
                  ? 'border-emerald-500/60 bg-emerald-500/10'
                  : 'border-neutral-800 bg-neutral-900/60 hover:border-neutral-700'
              }`}
            >
              <span className="block text-xs font-medium">{p.name}</span>
              <span className="block text-[10px] text-neutral-500">{p.desc}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 px-3">
        <Toggle
          label="语音识别"
          hint="没有字幕轨的视频，用本地 whisper 转写"
          checked={asrRunning}
          onChange={(v) => void toggleAsr(v)}
        />
        {asrRunning && (
          <p className="pb-2 text-[10px] leading-relaxed text-emerald-400">
            {state?.asr || '正在生成字幕…'}
          </p>
        )}
        {!asrRunning && asrState === 'error' && (
          <p className="pb-2 text-[10px] leading-relaxed text-rose-400">{asrMsg}</p>
        )}
        {!asrRunning && asrState !== 'error' && (
          <p className="pb-2 text-[10px] leading-relaxed text-neutral-500">
            {svc.online ? (
              <>服务在线 · {settings.asrUrl}</>
            ) : (
              <>
                服务未启动：双击项目里的 <b className="text-neutral-300">install-autostart.cmd</b>{' '}
                设为开机自启，或临时运行 start-asr.cmd
              </>
            )}
          </p>
        )}
        {!asrRunning && (
          <button
            type="button"
            onClick={() => void startLive()}
            className="mb-2 w-full rounded-lg bg-neutral-800/70 py-1.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            改用实时识别（下载失败时兜底，约 5 秒延迟）
          </button>
        )}
      </div>

      <button
        type="button"
        onClick={() => void browser.runtime.openOptionsPage()}
        disabled={!ready}
        className="w-full rounded-lg bg-neutral-800 py-2 text-xs font-medium text-neutral-200 transition hover:bg-neutral-700 disabled:opacity-50"
      >
        打开完整设置
      </button>

      <div className="space-y-1 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3 text-[11px]">
        <div className="flex items-center justify-between">
          <span className="font-medium text-neutral-400">当前页面自检</span>
          <span className={state ? 'text-emerald-400' : 'text-neutral-600'}>
            {state ? '已注入' : '未检测到'}
          </span>
        </div>
        {settings.provider === 'llm' && (
          <div className="space-y-0.5 text-[11px] text-neutral-500">
            <div className="truncate">端点 {settings.apiBase || '未填'}</div>
            <div className="truncate">
              模型 {settings.apiModel || '未填'} ·{' '}
              <span className={settings.apiKey ? 'text-emerald-400' : 'text-amber-400'}>
                {settings.apiKey ? 'Key 已填' : 'Key 未填'}
              </span>
            </div>
          </div>
        )}
        {state ? (
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-neutral-500">
            <span>字幕条数</span>
            <span className="text-right text-neutral-300">{state.cues}</span>
            <span>已翻译</span>
            <span className="text-right text-neutral-300">{state.translated}</span>
            <span>当前译文</span>
            <span className="truncate text-right text-neutral-300">{state.showing.tr || '—'}</span>
            <span>错误</span>
            <span className="truncate text-right text-rose-400">{state.error || '无'}</span>
          </div>
        ) : (
          <p className="text-neutral-600">打开一个 YouTube 视频页后再看这里。</p>
        )}
      </div>

      <p className="text-[10px] leading-relaxed text-neutral-600">
        提示：若字幕未出现，请确认播放器右下角 CC 按钮已开启。
      </p>
    </div>
  );
}
